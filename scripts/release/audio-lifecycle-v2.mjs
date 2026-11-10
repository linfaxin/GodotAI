// Function bodies are injected into the pinned Godot JS library. They execute
// in Godot's runtime, not in this Node module.
export const audioLifecycleFunctions = {
 lifecycle_active: function (session) {
  return !!session && !session.retiring && !session.closed && GodotAudio.lifecycle === session && GodotAudio.ctx === session.context && session.context.state !== 'closed';
 },
 lifecycle_disconnect: function (node, closePort) {
  if (!node) return;
  if (node.port) node.port.onmessage = null;
  try { node.disconnect(); } catch (error) { if (error.name !== 'InvalidStateError' && error.name !== 'InvalidAccessError') GodotRuntime.error('Error disconnecting retired audio node', error); }
  if (closePort && node.port) node.port.close();
 },
 close_async: function (resolve, reject) {
  const session = GodotAudio.lifecycle;
  if (!session) { resolve(); return; }
  if (session.closePromise) { session.closePromise.then(resolve, reject); return; }
  let finish;
  session.closePromise = new Promise(function (done) { finish = done; });
  session.retiring = true;
  const ctx = session.context;
  ctx.onstatechange = null;
  if (GodotAudio.interval) { clearInterval(GodotAudio.interval); GodotAudio.interval = 0; }
  GodotAudio.sampleFinishedCallback = null;
  if (GodotAudio.sampleNodes) {
   for (const node of Array.from(GodotAudio.sampleNodes.values())) node.clear(true);
   GodotAudio.sampleNodes.clear();
  }
  if (GodotAudio.audioPositionWorkletNodes) {
   for (const node of GodotAudio.audioPositionWorkletNodes) GodotAudio.lifecycle_disconnect(node, true);
   GodotAudio.audioPositionWorkletNodes.length = 0;
  }
  if (GodotAudio.input) {
   const input = GodotAudio.input; GodotAudio.input = null;
   GodotAudio.lifecycle_disconnect(input, false);
   if (input.mediaStream) for (const track of input.mediaStream.getTracks()) track.stop();
  }
  const driver = GodotAudio.driver;
  GodotAudio.driver = null;
  GodotAudio.ctx = null;
  GodotAudio.audioPositionWorkletPromise = null;
  GodotAudio.busSolo = null;
  GodotAudio.buses = [];
  // Retire the driver synchronously: a new init() before the next microtask
  // must not let this close operation act on that new driver's global state.
  let driverClosed;
  try { driverClosed = driver ? driver.close() : undefined; }
  catch (error) { GodotRuntime.error('Error closing audio driver', error); }
  Promise.resolve(driverClosed).catch(function (error) {
   GodotRuntime.error('Error closing audio driver', error);
  }).then(function () {
   return ctx.state === 'closed' ? undefined : ctx.close();
  }).catch(function (error) {
   GodotRuntime.error('Error closing AudioContext', error);
  }).then(function () {
   session.closed = true; session.context = null;
   if (GodotAudio.lifecycle === session) GodotAudio.lifecycle = null;
   finish();
  });
  session.closePromise.then(resolve, reject);
 },
};

export const sampleLifecycleFunctions = {
 _lifecycleAlive: function () {
  return !this.isCanceled && GodotAudio.lifecycle_active(this._lifecycleSession) && this._lifecycleContext === GodotAudio.ctx;
 },
 connectPositionWorklet: async function (start) {
  const session = this._lifecycleSession;
  const pending = GodotAudio.audioPositionWorkletPromise;
  await pending;
  if (!this._lifecycleAlive() || !GodotAudio.lifecycle_active(session)) return;
  this._source.connect(this.getPositionWorklet());
  if (start) this.start();
 },
 getPositionWorklet: function () {
  if (!this._lifecycleAlive()) return null;
  const ctx = this._lifecycleContext;
  if (this._positionWorklet != null) return this._positionWorklet;
  if (GodotAudio.audioPositionWorkletNodes.length > 0) this._positionWorklet = GodotAudio.audioPositionWorkletNodes.pop();
  else this._positionWorklet = new AudioWorkletNode(ctx, 'godot-position-reporting-processor');
  this._playbackPosition = this.offset;
  this._positionWorklet.port.onmessage = (event) => {
   if (!this._lifecycleAlive()) return;
   if (event.data['type'] === 'position') this._playbackPosition = (parseInt(event.data.data, 10) / this.getSample().sampleRate) + this.offset;
  };
  const reset = this._positionWorklet.parameters.get('reset');
  reset.setValueAtTime(1, ctx.currentTime); reset.setValueAtTime(0, ctx.currentTime + 1);
  return this._positionWorklet;
 },
 clear: function (retiring = false) {
  if (this._lifecycleCleared) return;
  this._lifecycleCleared = true;
  const retired = retiring || !GodotAudio.lifecycle_active(this._lifecycleSession);
  this.isCanceled = true; this.isPaused = false; this.pauseTime = 0;
  if (this._source != null) {
   this._source.removeEventListener('ended', this._onended); this._onended = null;
   try { if (this.isStarted) this._source.stop(); } catch (error) { if (!retired) GodotRuntime.error('Error stopping audio sample', error); }
   GodotAudio.lifecycle_disconnect(this._source, false); this._source = null;
  }
  for (const bus of this._sampleNodeBuses.values()) bus.clear();
  this._sampleNodeBuses.clear();
  if (this._positionWorklet) {
   GodotAudio.lifecycle_disconnect(this._positionWorklet, retired);
   if (!retired) GodotAudio.audioPositionWorkletNodes.push(this._positionWorklet);
   this._positionWorklet = null;
  }
  if (retired) GodotAudio.sampleNodes.delete(this.id);
  else GodotAudio.SampleNode.delete(this.id);
 },
};

export const workletLifecycleFunctions = {
 create: function (channels) {
  const audio = GodotAudio.lifecycle;
  if (!GodotAudio.lifecycle_active(audio)) return;
  const session = { audio: audio, context: audio.context, retiring: false, node: null, ring: null };
  GodotAudioWorklet.session = session;
  const path = GodotConfig.locate_file('godot.audio.worklet.js');
  GodotAudioWorklet.promise = session.context.audioWorklet.addModule(path).then(function () {
   if (!GodotAudioWorklet.lifecycle_active(session)) return null;
   const node = new AudioWorkletNode(session.context, 'godot-processor', { outputChannelCount: [channels] });
   session.node = node; GodotAudioWorklet.worklet = node; return node;
  }, function (error) {
   if (!GodotAudioWorklet.lifecycle_active(session)) return null;
   throw error;
  });
  // Preserve the original rejected promise for callers, while observing errors
  // even if a consumer has not reached start() yet.
  GodotAudioWorklet.promise.catch(function (error) {
   if (GodotAudioWorklet.lifecycle_active(session)) GodotRuntime.error('Error loading AudioWorklet', error);
  });
  GodotAudio.driver = GodotAudioWorklet;
 },
 lifecycle_active: function (session) {
  return !!session && !session.retiring && GodotAudioWorklet.session === session && GodotAudio.lifecycle_active(session.audio);
 },
 start: function (in_buf, out_buf, state) {
  const session = GodotAudioWorklet.session;
  const pending = GodotAudioWorklet.promise;
  if (!pending || !GodotAudioWorklet.lifecycle_active(session)) return;
  pending.then(function (node) {
   if (!node || !GodotAudioWorklet.lifecycle_active(session)) return;
   node.connect(session.context.destination);
   node.port.postMessage({ 'cmd': 'start', 'data': [state, in_buf, out_buf] });
   node.port.onmessage = function (event) {
    if (GodotAudioWorklet.lifecycle_active(session)) GodotRuntime.error(event.data);
   };
  }, function () { /* The create() observer reports active load failures. */ });
 },
 get_node: function () {
  return GodotAudioWorklet.lifecycle_active(GodotAudioWorklet.session) ? GodotAudioWorklet.session.node : null;
 },
 close: function () {
  const session = GodotAudioWorklet.session;
  if (!session) return Promise.resolve();
  session.retiring = true;
  GodotAudioWorklet.session = null;
  const node = session.node; session.node = null; session.ring = null;
  GodotAudioWorklet.worklet = null; GodotAudioWorklet.promise = null; GodotAudioWorklet.ring_buffer = null;
  if (node) {
   node.port.onmessage = null;
   node.port.postMessage({ 'cmd': 'stop', 'data': null });
   GodotAudio.lifecycle_disconnect(node, true);
  }
  return Promise.resolve();
 },
};

export const anonymous = fn => fn.toString().replace(/^(async\s+)?function\s*[\w$]*/, '$1function');
