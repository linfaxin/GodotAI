import { DEFAULT_AUDIO_LIMITS, NATIVE_AUDIO_INPUT_CHANNELS, estimateWorkerAudioPcm, type AudioPort, type WorkerAudioDescriptor, type WorkerAudioLimits, type WorkerAudioPreferences } from './worker-audio-protocol.js';

export interface WorkerAudioHostOptions {
  runId: string; audioEpoch: number; workletUrl: string | URL;
  limits?: Partial<WorkerAudioLimits>;
  createContext?: (options: AudioContextOptions) => AudioContext;
  createWorklet?: (context: AudioContext, name: string, options?: AudioWorkletNodeOptions) => AudioWorkletNode;
  requestInput?: () => Promise<MediaStream>;
  onInputStatus?: (state: 'pending' | 'active' | 'denied' | 'stopped', error?: Error) => void;
  timeoutMs?: number; onError?: (error: Error) => void;
}
interface HostSample { buffer: AudioBuffer; bytes: number; loopMode: string; loopBegin: number; loopEnd: number }
interface HostBus { input: GainNode; gain: GainNode; gate: GainNode; send: HostBus | null; db: number; muted: boolean; solo: boolean }
interface VoiceEdge { bus: HostBus; splitter: ChannelSplitterNode; gains: GainNode[]; merger: ChannelMergerNode }
interface HostVoice {
  id: string; epoch: number; sampleId: string; sample: HostSample; buffer: AudioBuffer; source: AudioBufferSourceNode | null;
  positionNode: AudioWorkletNode; edges: VoiceEdge[]; paused: boolean; pitch: number; offset: number; cursor: number; startedAt: number; position: number; positionCommandSeq: number; positionAcknowledged: boolean; startPending: boolean;
}

/** Owns browser audio objects on the main thread; the engine and React remain in their Worker. */
export class WorkerAudioHost {
  private readonly limits: WorkerAudioLimits;
  private context?: AudioContext;
  private gate?: GainNode;
  private streamNode?: AudioWorkletNode;
  private streamConnected = false;
  private meterNode?: AudioWorkletNode;
  private meterFlushed?: () => void;
  private descriptor?: WorkerAudioDescriptor;
  private preparePromise?: Promise<WorkerAudioDescriptor>;
  private stopPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private disposePromise?: Promise<void>;
  private contextClosePromise?: Promise<void>;
  private latencyTimer?: ReturnType<typeof setInterval>;
  private forceClosePromise?: Promise<void>;
  private abortStop?: (error: Error) => void;
  private abandonedEpoch = false;
  private stopping = false;
  private closed = false;
  private nodesDisposed = false;
  private sequence = 0;
  private sampleBytes = 0;
  private voiceBytes = 0;
  private samples = new Map<string, HostSample>();
  private voices = new Map<string, HostVoice>();
  private buses: HostBus[] = [];
  private attached?: () => void;
  private flushed?: () => void;
  private workerStopped?: () => void;
  private pcmFlushed?: () => void;
  private contextsCreated = 0;
  private contextsClosed = 0;
  private latePackets = 0;
  private outputPeak = 0;
  private outputChecks = 0;
  private transferredChunksOwned = 0;
  private inputDroppedFrames = 0;
  private outputUnderruns = 0;
  private inputEpoch = 0;
  private inputStream?: MediaStream;
  private inputSource?: MediaStreamAudioSourceNode;
  private readonly inputOperations = new Set<Promise<void>>();
  private inputCleanupFailure: unknown;
  // One microphone permission acquisition may outlive input-stop; transport
  // ACKs cannot retire this resource-operation credit.
  private readonly maxPendingInputRequests = 1;

  constructor(private readonly control: AudioPort, private readonly workletPort: MessagePort, private readonly options: WorkerAudioHostOptions) {
    this.limits = { ...DEFAULT_AUDIO_LIMITS, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid audio limit ${key}`);
    if (this.limits.streamBlocks > 64 || this.limits.streamBlockFrames > 16384 || this.limits.pendingCommands > 65536) throw new Error('Audio limits exceed bounded renderer capacity');
    control.onmessage = (event) => this.receive(event.data); control.start();
  }
  private envelope() { return { runId: this.options.runId, audioEpoch: this.options.audioEpoch }; }
  private matches(data: any) { return data?.runId === this.options.runId && data.audioEpoch === this.options.audioEpoch; }
  private post(message: Record<string, unknown>): void { this.control.postMessage({ ...this.envelope(), ...message }); }
  private error(value: unknown): void {
    const error = value instanceof Error ? value : new Error(String(value));
    this.mute(); this.post({ type: 'error', message: error.message }); this.options.onError?.(error);
  }
  private receive(data: any): void {
    if (!this.matches(data)) { this.latePackets++; return; }
    if (data.type === 'pcm-flushed') { if (data.outstandingLoans === 0) this.pcmFlushed?.(); else this.error(new Error('Audio flush retained output loans')); return; }
    if (data.type === 'worker-stopped') { this.workerStopped?.(); return; }
    if (data.type === 'close') { void this.close().catch((error) => this.error(error)); return; }
    if (data.type === 'prepare') {
      void this.prepare(data.preferences).then((descriptor) => this.post({ type: 'prepared', descriptor })).catch((error) => this.error(error)); return;
    }
    if (data.type !== 'command' || this.stopping) return;
    try {
      if (data.seq !== this.sequence + 1) throw new Error('Out-of-order audio control command');
      this.sequence = data.seq;
      this.dispatch(data);
      this.post({ type: 'ack', seq: data.seq });
    } catch (error) { this.error(error); }
  }
  prepare(preferences: WorkerAudioPreferences): Promise<WorkerAudioDescriptor> {
    if (this.preparePromise) return this.preparePromise;
    this.preparePromise = this.prepareContext(preferences);
    return this.preparePromise;
  }
  private async prepareContext(preferences: WorkerAudioPreferences): Promise<WorkerAudioDescriptor> {
    if (this.stopping) throw new Error('AudioHost was stopped before preparation');
    if (!Number.isInteger(preferences.mixRate) || preferences.mixRate < 0 || !Number.isSafeInteger(preferences.latencyMs) || preferences.latencyMs <= 0) throw new Error('Invalid native audio preferences');
    if (typeof preferences.driver === 'string' && /^dummy$/i.test(preferences.driver)) {
      // Explicit project choice; native Dummy is configured to the same requested/default mix rate.
      this.descriptor = { ...this.envelope(), kind: 'dummy', driver: 'Dummy', sampleRate: preferences.mixRate > 0 ? preferences.mixRate : 44100, channels: 2, inputChannels: NATIVE_AUDIO_INPUT_CHANNELS, state: 'closed', outputLatency: 0, limits: { ...this.limits } };
      return this.descriptor;
    }
    if (typeof preferences.driver === 'string' && !/^(audioworklet|worklet|0)$/i.test(preferences.driver)) throw new Error(`Unsupported native audio driver ${preferences.driver}`);
    if (typeof preferences.driver === 'number' && preferences.driver !== 0) throw new Error(`Unsupported native audio driver ${preferences.driver}`);
    const create = this.options.createContext ?? ((settings: AudioContextOptions) => new AudioContext(settings));
    // Match Godot's Web backend: leave the browser's interactive device hint alone.
    // Project latency sizes the native PCM ring; applying it to the device as well batches render
    // quanta beyond that nearest-power-of-two ring and starves a threadless MessagePort transport.
    const context = create({ ...(preferences.mixRate ? { sampleRate: preferences.mixRate } : {}) });
    this.context = context; this.contextsCreated++;
    try {
      if (preferences.mixRate && context.sampleRate !== preferences.mixRate) throw new Error('AudioContext did not honor the project sample rate');
      if (!context.audioWorklet) throw new Error('AudioWorklet is required by the Worker audio driver');
      const channels = context.destination.channelCount;
      if (![1, 2, 4, 6, 8].includes(channels)) throw new Error(`Unsupported audio channel count ${channels}`);
      // This admission happens before addModule / prepare resolution, hence before native setup2 allocates.
      const pcm = estimateWorkerAudioPcm(preferences.latencyMs, context.sampleRate, channels, this.limits);
      this.gate = context.createGain(); this.gate.gain.value = 0;
      await context.audioWorklet.addModule(this.options.workletUrl);
      if (this.stopping) throw new Error('Audio preparation canceled');
      this.meterNode = this.createWorklet('godot-worker-meter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [channels], channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speakers', processorOptions: this.envelope() });
      this.meterNode.port.onmessage = (event) => {
        if (!this.matches(event.data)) { this.latePackets++; return; }
        if (event.data.type === 'output-metrics') { this.outputPeak = Math.max(this.outputPeak, event.data.outputPeak); this.outputChecks = event.data.outputChecks; }
        if (event.data.type === 'meter-flushed') this.meterFlushed?.();
      };
      this.meterNode.onprocessorerror = () => this.error(new Error('Audio output meter failed'));
      this.gate.connect(this.meterNode); this.meterNode.connect(context.destination);
      const stream = this.createWorklet('godot-worker-audio', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [channels], channelCount: NATIVE_AUDIO_INPUT_CHANNELS, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
      this.streamNode = stream;
      stream.onprocessorerror = () => this.error(new Error('Worker audio processor failed'));
      const attached = this.deadline(new Promise<void>((resolve) => { this.attached = resolve; }), 'AudioWorklet attach');
      stream.port.onmessage = (event) => {
        if (!this.matches(event.data)) { this.latePackets++; return; }
        if (event.data.type === 'metrics') { this.transferredChunksOwned = event.data.transferredChunksOwned; this.inputDroppedFrames = event.data.inputDroppedFrames ?? 0; this.outputUnderruns = event.data.underruns ?? 0; }
        if (event.data.type === 'stream-error') this.error(new Error(event.data.message));
        if (event.data.type === 'attached') this.attached?.();
        if (event.data.type === 'flushed') this.flushed?.();
      };
      stream.port.postMessage({ ...this.envelope(), type: 'attach', port: this.workletPort, channels, inputChannels: NATIVE_AUDIO_INPUT_CHANNELS, maxFrames: this.limits.streamBlockFrames, captureBlockFrames: pcm.captureBlockFrames, maxBlocks: this.limits.streamBlocks, pcmBytes: pcm.transportBudgetBytes }, [this.workletPort]);
      stream.connect(this.gate); this.streamConnected = true;
      await attached;
      if (this.stopping) throw new Error('Audio preparation canceled');
      this.buses.push(this.makeBus(null));
      context.onstatechange = () => this.postState();
      this.descriptor = { ...this.envelope(), kind: 'worklet', driver: 'AudioWorklet', sampleRate: context.sampleRate, channels, inputChannels: NATIVE_AUDIO_INPUT_CHANNELS, state: context.state, outputLatency: this.outputLatency(), pcm, limits: { ...this.limits } };
      this.gate.gain.value = 1;
      this.latencyTimer = setInterval(() => {
        if (!this.descriptor || this.stopping) return;
        const latency = this.outputLatency();
        if (latency !== this.descriptor.outputLatency) { this.descriptor.outputLatency = latency; this.post({ type: 'latency', outputLatency: latency }); }
      }, 1000);
      return this.descriptor;
    } catch (error) {
      this.mute(); this.streamNode?.disconnect(); this.streamConnected = false; this.meterNode?.disconnect(); this.gate?.disconnect();
      await this.closeContext();
      throw error;
    }
  }
  private closeContext(): Promise<void> {
    if (this.contextClosePromise) return this.contextClosePromise;
    const context = this.context;
    if (!context || context.state === 'closed') return Promise.resolve();
    context.onstatechange = null;
    this.contextClosePromise = this.deadline(context.close(), 'AudioContext close').then(() => { this.contextsClosed++; });
    return this.contextClosePromise;
  }
  private createWorklet(name: string, options?: AudioWorkletNodeOptions): AudioWorkletNode {
    return this.options.createWorklet ? this.options.createWorklet(this.context!, name, options) : new AudioWorkletNode(this.context!, name, options);
  }
  private outputLatency(): number { return (this.context?.baseLatency ?? 0) + (this.context?.outputLatency ?? 0); }
  private postState(): void { const state = this.context?.state ?? 'closed', latency = this.outputLatency(); if (this.descriptor) { this.descriptor.state = state; this.descriptor.outputLatency = latency; } this.post({ type: 'state', state, outputLatency: latency }); }
  /** Call synchronously from a real main-thread pointer/key handler, before yielding its activation. */
  resumeFromGesture(): Promise<void> {
    if (!this.context || this.stopping) return Promise.resolve();
    return this.context.resume().then(() => this.postState());
  }
  private dispatch(data: any): void {
    if (!this.context || !this.descriptor) throw new Error('Audio command before preparation');
    switch (data.operation) {
      case 'resume':
        // A Worker message does not carry user activation. A failed attempt remains suspended.
        void this.context.resume().then(() => this.postState()).catch(() => this.postState()); break;
      case 'input-start': void this.startInput(data.inputEpoch); break;
      case 'input-stop': this.stopInput(data.inputEpoch); break;
      case 'register': this.register(data); break;
      case 'unregister': this.unregister(data.id); break;
      case 'start': this.startVoice(data); break;
      case 'stop': { const voice = this.voice(data); if (voice) this.removeVoice(voice, false); break; }
      case 'pause': { const voice = this.voice(data); if (voice) { this.fencePosition(voice, data.seq, !!data.paused); this.pauseVoice(voice, data.paused); } break; }
      case 'pitch': { const voice = this.voice(data); if (voice) { this.fencePosition(voice, data.seq, voice.paused); this.pitchVoice(voice, data.pitch); } break; }
      case 'volumes': { const voice = this.voice(data); if (voice) this.volumes(voice, data.buses, data.volumes); break; }
      case 'bus': this.busCommand(data); break;
      default: throw new Error(`Unknown audio operation ${data.operation}`);
    }
  }
  private inputStatus(state: 'pending' | 'active' | 'denied' | 'stopped', inputEpoch: number, error?: Error): void {
    this.post({ type: 'input-status', state, inputEpoch, ...(error ? { message: error.message } : {}) });
    this.options.onInputStatus?.(state, error);
  }
  private startInput(inputEpoch: number): void {
    this.stopInput(this.inputEpoch);
    if(this.stopping)return;
    this.inputEpoch = inputEpoch;
    if(this.inputOperations.size>=this.maxPendingInputRequests){this.inputStatus('denied',inputEpoch,Error('E_WORKER_AUDIO_INPUT_PENDING'));return;}
    const operation=Promise.resolve().then(()=>this.acquireInput(inputEpoch));this.inputOperations.add(operation);
    void operation.then(()=>this.inputOperations.delete(operation),failure=>{this.inputCleanupFailure??=failure;this.inputOperations.delete(operation);});
    this.inputStatus('pending', inputEpoch);
  }
  private stopTracks(stream:MediaStream):void {
    let failure:unknown;for(const track of stream.getTracks())try{track.stop();}catch(error){failure??=error;}
    if(failure)throw failure;
  }
  private async acquireInput(inputEpoch:number):Promise<void> {
    if(this.stopping||this.inputEpoch!==inputEpoch)return;
    let acquired:MediaStream|undefined;
    try {
      const stream = acquired = await (this.options.requestInput ? this.options.requestInput() : navigator.mediaDevices.getUserMedia({ audio: true }));
      if (this.stopping || this.inputEpoch !== inputEpoch) { this.stopTracks(stream); return; }
      this.inputStream = stream;
      this.inputSource = this.context!.createMediaStreamSource(stream);
      this.inputSource.connect(this.streamNode!);
      this.streamNode!.port.postMessage({ ...this.envelope(), type: 'capture-enable', inputEpoch, enabled: true });
      this.inputStatus('active', inputEpoch);
    } catch (value) {
      if (this.stopping || this.inputEpoch !== inputEpoch) {if(acquired)throw value;return;}
      this.inputSource?.disconnect(); this.inputSource = undefined;
      if (this.inputStream) this.stopTracks(this.inputStream);
      this.inputStream = undefined;
      this.streamNode?.port.postMessage({ ...this.envelope(), type: 'capture-enable', inputEpoch, enabled: false });
      this.inputStatus('denied', inputEpoch, value instanceof Error ? value : new Error(String(value)));
    }
  }
  private async drainInput():Promise<void>{
    while(this.inputOperations.size)await Promise.allSettled([...this.inputOperations]);
    if(this.inputCleanupFailure)throw this.inputCleanupFailure;
  }
  private stopInput(inputEpoch: number): void {
    if (inputEpoch !== this.inputEpoch) return;
    this.inputSource?.disconnect(); this.inputSource = undefined;
    if (this.inputStream) for (const track of this.inputStream.getTracks()) track.stop();
    this.inputStream = undefined;
    this.streamNode?.port.postMessage({ ...this.envelope(), type: 'capture-enable', inputEpoch, enabled: false });
    this.inputStatus('stopped', inputEpoch);
    this.inputEpoch++; // Late permission resolution cannot reconnect a stopped request.
  }
  private register(data: any): void {
    if (this.samples.has(data.id)) throw new Error('Duplicate sample registration');
    const bytes = data.frames * 2 * 4;
    if (!Number.isSafeInteger(data.frames) || data.frames < 1 || !(data.buffer instanceof ArrayBuffer) || data.buffer.byteLength !== bytes) throw new Error('Malformed planar audio sample');
    // The admission check includes both the incoming decode copy and the AudioBuffer allocation.
    if (this.samples.size >= this.limits.sampleCount || this.sampleBytes + bytes * 2 > this.limits.sampleBytes) throw new Error('Host sample decode memory budget exceeded');
    const buffer = this.context!.createBuffer(2, data.frames, this.context!.sampleRate);
    const planar = new Float32Array(data.buffer);
    buffer.copyToChannel(planar.subarray(0, data.frames), 0); buffer.copyToChannel(planar.subarray(data.frames), 1);
    this.samples.set(data.id, { buffer, bytes, loopMode: data.loopMode, loopBegin: data.loopBegin, loopEnd: data.loopEnd }); this.sampleBytes += bytes;
  }
  private unregister(id: string): void {
    const sample = this.samples.get(id); if (!sample) return;
    for (const voice of this.voices.values()) if (voice.sampleId === id) this.removeVoice(voice, true);
    this.samples.delete(id); this.sampleBytes -= sample.bytes;
  }
  private startVoice(data: any): void {
    const sample = this.samples.get(data.streamId);
    if (!sample) throw new Error('Host cannot start an unregistered sample');
    if (!Number.isFinite(data.offset) || data.offset < 0 || !Number.isFinite(data.pitch) || data.pitch <= 0) throw new Error('Invalid sample start parameters');
    const existing = this.voices.get(data.id); if (existing) this.removeVoice(existing, false);
    if (this.voices.size >= this.limits.voices || this.voiceBytes + sample.bytes > this.limits.voiceBytes) throw new Error('Host voice memory budget exceeded');
    // Godot's web sample backend owns a decoded AudioBuffer per voice. Charge that copy separately.
    const buffer = this.context!.createBuffer(2, sample.buffer.length, sample.buffer.sampleRate);
    for (let channel = 0; channel < 2; channel++) buffer.copyToChannel(sample.buffer.getChannelData(channel), channel);
    const positionNode = this.createWorklet('godot-worker-position', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    positionNode.connect(this.gate!);
    const voice: HostVoice = { id: data.id, epoch: data.voiceEpoch, sampleId: data.streamId, sample, buffer, source: null, positionNode, edges: [], paused: false, pitch: data.pitch, offset: data.offset, cursor: data.offset, startedAt: 0, position: data.offset, positionCommandSeq: data.seq, positionAcknowledged: false, startPending: true };
    positionNode.port.onmessage = (event) => {
      const report = event.data;
      if (this.stopping || this.voices.get(voice.id) !== voice || report.voiceEpoch !== voice.epoch || report.commandSeq !== voice.positionCommandSeq || !Number.isSafeInteger(report.frames) || report.frames < 0) return;
      if (report.type === 'position-generation-ack') {
        voice.positionAcknowledged = true;
        if (voice.startPending && !voice.paused && !voice.source) {
          try { this.connectSource(voice); voice.startPending = false; }
          catch (error) { this.removeVoice(voice, false); this.error(error); return; }
        }
      } else if (report.type !== 'position' || !voice.positionAcknowledged || voice.paused) return;
      // Preserve the existing Web API: output-frame time, not a pitch-scaled/wrapped source playhead.
      // The resume cursor below is separate; public position is never synthesized from a Host clock.
      voice.position = voice.offset + report.frames / this.context!.sampleRate;
      this.post({ type: 'position', id: voice.id, voiceEpoch: voice.epoch, commandSeq: voice.positionCommandSeq, position: voice.position });
    };
    positionNode.onprocessorerror = () => this.error(new Error('Sample position processor failed'));
    this.voices.set(voice.id, voice); this.voiceBytes += sample.bytes;
    try { this.volumes(voice, [data.bus], data.volume); this.fencePosition(voice, data.seq, false, true); }
    catch (error) { this.removeVoice(voice, false); throw error; }
  }
  private fencePosition(voice: HostVoice, commandSeq: number, paused: boolean, reset = false): void {
    voice.positionCommandSeq = commandSeq; voice.positionAcknowledged = false;
    voice.positionNode.port.postMessage({ type: 'position-generation', voiceEpoch: voice.epoch, commandSeq, paused, reset });
  }
  private voice(data: any): HostVoice | undefined { const voice = this.voices.get(data.id); return voice?.epoch === data.voiceEpoch ? voice : undefined; }
  private connectSource(voice: HostVoice): void {
    const source = this.context!.createBufferSource(); source.buffer = voice.buffer; source.playbackRate.value = voice.pitch;
    // Preserve the existing web backend's repeat semantics: forward/backward repeat the decoded buffer.
    source.loop = (voice.sample.loopMode === 'forward' || voice.sample.loopMode === 'backward') && voice.buffer.duration > 0;
    if (source.loop) {
      // The upstream ended/restart path repeats from playback offset, not the Sample loop metadata.
      // WebAudio loopEnd=0 falls back to the whole buffer, so set both endpoints explicitly.
      source.loopStart = voice.offset < voice.buffer.duration ? voice.offset : 0;
      source.loopEnd = voice.buffer.duration;
      // WebAudio clamps a looping start beyond its end to that end, then enters the loop at its start.
      if (voice.cursor >= source.loopEnd) voice.cursor = source.loopStart;
    }
    voice.source = source;
    for (const edge of voice.edges) source.connect(edge.splitter);
    source.connect(voice.positionNode);
    source.onended = () => { if (voice.source === source && !voice.paused && this.voices.get(voice.id) === voice) this.removeVoice(voice, true); };
    voice.startedAt = this.context!.currentTime;
    source.start(0, voice.cursor);
  }
  private accumulateCursor(voice: HostVoice): void {
    if (!voice.paused && voice.source) {
      voice.cursor += Math.max(0, this.context!.currentTime - voice.startedAt) * voice.pitch;
      if (voice.source.loop && voice.buffer.duration > 0) {
        const duration = voice.buffer.duration;
        let start = voice.source.loopStart, end = voice.source.loopEnd;
        if (!(Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > 0 && start < end)) { start = 0; end = duration; }
        else { end = Math.min(end, duration); if (start >= end) { start = 0; end = duration; } }
        const length = end - start;
        if (length > 0 && voice.cursor >= end) voice.cursor = start + (voice.cursor - end) % length;
      }
      voice.startedAt = this.context!.currentTime;
    }
  }
  private pauseVoice(voice: HostVoice, paused: boolean): void {
    if (voice.paused === paused) return;
    if (paused) { this.accumulateCursor(voice); voice.paused = true; this.disconnectSource(voice); }
    else { voice.paused = false; voice.startPending = true; }
  }
  private pitchVoice(voice: HostVoice, pitch: number): void {
    if (!Number.isFinite(pitch) || pitch <= 0) throw new Error('Invalid sample pitch');
    this.accumulateCursor(voice); voice.pitch = pitch;
    if (voice.source) voice.source.playbackRate.value = pitch;
  }
  private disconnectSource(voice: HostVoice): void {
    const source = voice.source; voice.source = null;
    if (source) { source.onended = null; try { source.stop(); } catch { /* Already ended. */ } source.disconnect(); }
  }
  private removeVoice(voice: HostVoice, notify: boolean): void {
    if (this.voices.get(voice.id) !== voice) return;
    this.voices.delete(voice.id); this.voiceBytes -= voice.sample.bytes; this.disconnectSource(voice);
    for (const edge of voice.edges) this.clearEdge(edge);
    voice.positionNode.port.onmessage = null; voice.positionNode.disconnect(); voice.positionNode.port.close();
    if (notify) this.post({ type: 'finished', id: voice.id, voiceEpoch: voice.epoch });
  }
  private clearEdge(edge: VoiceEdge): void { edge.splitter.disconnect(); for (const gain of edge.gains) gain.disconnect(); edge.merger.disconnect(); }
  private volumes(voice: HostVoice, indices: number[], volumes: number[]): void {
    if (volumes.length !== indices.length * 8) throw new Error('Native sample volume array must contain eight values per bus');
    indices.forEach((index, offset) => {
      const bus = this.buses[index]; if (!bus) throw new Error('Sample volume references an invalid bus');
      let edge = voice.edges.find((entry) => entry.bus === bus);
      if (!edge) {
        const splitter = this.context!.createChannelSplitter(6); const merger = this.context!.createChannelMerger(6);
        const gains = Array.from({ length: 6 }, () => this.context!.createGain());
        // Same routing as Godot 4.6's browser backend, including its L -> LFE feed.
        for (let channel = 0; channel < 6; channel++) { splitter.connect(gains[channel]!, channel === 5 ? 0 : channel); gains[channel]!.connect(merger, 0, channel); }
        merger.connect(bus.input); edge = { bus, splitter, merger, gains }; voice.edges.push(edge); voice.source?.connect(splitter);
      }
      const godotChannels = [0, 1, 7, 8, 3, 4];
      for (let channel = 0; channel < 6; channel++) edge.gains[channel]!.gain.value = volumes[offset * 8 + godotChannels[channel]!] ?? 0;
    });
  }
  private makeBus(send: HostBus | null): HostBus {
    const context = this.context!;
    const bus: HostBus = { input: context.createGain(), gain: context.createGain(), gate: context.createGain(), send, db: 0, muted: false, solo: false };
    bus.input.connect(bus.gain); bus.gain.connect(bus.gate); bus.gate.connect(send?.input ?? this.gate!); return bus;
  }
  private removeBus(index: number): void {
    if (index <= 0 || index >= this.buses.length) throw new Error('Cannot remove master or invalid sample bus');
    const bus = this.buses[index]!; const master = this.buses[0]!;
    for (const voice of this.voices.values()) for (const edge of voice.edges) if (edge.bus === bus) { edge.merger.disconnect(); edge.merger.connect(master.input); edge.bus = master; }
    for (const other of this.buses) if (other.send === bus) { other.send = master; other.gate.disconnect(); other.gate.connect(master.input); }
    bus.input.disconnect(); bus.gain.disconnect(); bus.gate.disconnect(); this.buses.splice(index, 1); this.updateBusGates();
  }
  private busCommand(data: any): void {
    const index = data.index; const value = data.value;
    if (!Number.isInteger(index)) throw new Error('Invalid sample bus index');
    switch (data.busOperation) {
      case 'count':
        if (index < 1 || index > 256) throw new Error('Sample bus count outside budget');
        while (this.buses.length > index) this.removeBus(this.buses.length - 1);
        while (this.buses.length < index) this.buses.push(this.makeBus(this.buses[0]!)); break;
      case 'add': { const position = index < 0 ? this.buses.length : index; if (position < 1 || position > this.buses.length || this.buses.length >= 256) throw new Error('Invalid sample bus insertion'); this.buses.splice(position, 0, this.makeBus(this.buses[0]!)); break; }
      case 'remove': this.removeBus(index); break;
      case 'move': {
        if (index < 1 || index >= this.buses.length || !Number.isInteger(value) || (value !== -1 && (value < 1 || value > this.buses.length))) throw new Error('Invalid sample bus move');
        if (index === value) break;
        const [bus] = this.buses.splice(index, 1);
        // AudioServer::move_bus uses a before-position in the original array; -1 appends.
        const destination = value === -1 ? this.buses.length : value < index ? value : value - 1;
        this.buses.splice(destination, 0, bus!); break;
      }
      default: {
        const bus = this.buses[index]; if (!bus) throw new Error('Invalid sample bus');
        switch (data.busOperation) {
          case 'send': {
            if (index === 0) break;
            const send = this.buses[value]; if (!send || send === bus) throw new Error('Invalid sample bus send');
            for (let next: HostBus | null = send; next; next = next.send) if (next === bus) throw new Error('Cyclic sample bus send');
            bus.send = send; bus.gate.disconnect(); bus.gate.connect(send.input); break;
          }
          case 'volume': if (!Number.isFinite(value)) throw new Error('Invalid bus volume'); bus.db = value; bus.gain.gain.value = Math.pow(10, value / 20); break;
          case 'solo': if (value) for (const other of this.buses) other.solo = false; bus.solo = !!value; break;
          case 'mute': bus.muted = !!value; break;
          default: throw new Error('Unknown sample bus operation');
        }
      }
    }
    this.updateBusGates();
  }
  private updateBusGates(): void {
    const solo = this.buses.find((bus) => bus.solo);
    const audible = new Set<HostBus>();
    for (let bus = solo; bus; bus = bus.send ?? undefined) audible.add(bus);
    for (const bus of this.buses) bus.gate.gain.value = !bus.muted && (!solo || audible.has(bus)) ? 1 : 0;
  }
  mute(): void { if (this.gate && this.context) this.gate.gain.setValueAtTime(0, this.context.currentTime); }
  private deadline<T>(promise: Promise<T>, name: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), this.options.timeoutMs ?? 3000); })]).finally(() => clearTimeout(timer));
  }
  stop(): Promise<void> {
    if (this.forceClosePromise) return this.forceClosePromise;
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true; clearInterval(this.latencyTimer); this.mute(); this.stopInput(this.inputEpoch);
    this.stopPromise = this.stopAudio(); return this.stopPromise;
  }
  private async stopAudio(): Promise<void> {
    if (!this.context && !this.streamNode) { this.post({ type: 'stop' }); this.post({ type: 'stopped' }); return; }
    const worker = new Promise<void>((resolve) => { this.workerStopped = resolve; });
    this.post({ type: 'stop' });
    const flushed = new Promise<void>((resolve) => { this.flushed = resolve; });
    const pcm = new Promise<void>((resolve) => { this.pcmFlushed = resolve; });
    if (this.streamNode) this.streamNode.port.postMessage({ ...this.envelope(), type: 'flush' }); else { this.flushed?.(); this.pcmFlushed?.(); }
    const meter = new Promise<void>((resolve) => { this.meterFlushed = resolve; });
    if (this.meterNode) this.meterNode.port.postMessage({ type: 'flush' }); else this.meterFlushed?.();
    for (const voice of this.voices.values()) this.removeVoice(voice, false);
    this.samples.clear(); this.sampleBytes = 0;
    for (const bus of this.buses) { bus.input.disconnect(); bus.gain.disconnect(); bus.gate.disconnect(); } this.buses = [];
    try { await this.deadline(Promise.race([Promise.all([worker, flushed, pcm, meter]), new Promise<never>((_resolve, reject) => { this.abortStop = reject; })]), 'Audio epoch flush'); }
    finally { this.streamNode?.disconnect(); this.streamConnected = false; this.post({ type: 'stopped' }); }
  }
  private clearGraph(): void {
    this.stopInput(this.inputEpoch);
    for (const voice of this.voices.values()) this.removeVoice(voice, false);
    this.samples.clear(); this.sampleBytes = 0;
    for (const bus of this.buses) { bus.input.disconnect(); bus.gain.disconnect(); bus.gate.disconnect(); }
    this.buses = [];
    this.streamNode?.disconnect(); this.streamConnected = false;
    this.gate?.disconnect(); this.meterNode?.disconnect();
  }
  private disposeResources(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    clearInterval(this.latencyTimer); this.clearGraph();
    const resources = (async () => {
      try {
        await this.closeContext();
      } finally {
        this.streamNode?.disconnect(); this.gate?.disconnect(); this.meterNode?.disconnect();
        this.meterNode?.port.close(); this.streamNode?.port.close();
        const contextClosed = !this.context || this.context.state === 'closed';
        if (contextClosed) this.post({ type: 'closed', driver: this.descriptor?.driver ?? null });
        else this.post({ type: 'error', message: 'AudioContext could not be closed' });
        this.control.close();
        // An unattached port remains owned by the Host, rather than an AudioWorklet.
        if (!this.streamNode) this.workletPort.close();
        this.nodesDisposed = true;
        if (contextClosed && this.abandonedEpoch) this.transferredChunksOwned = 0;
      }
    })();
    // The Native context-closed ACK above must not wait on browser permission.
    // Full Host cleanup joins the acquisition and its late track compensation.
    this.disposePromise=Promise.all([resources,this.drainInput()]).then(()=>{this.closed=!this.context||this.context.state==='closed';});return this.disposePromise;
  }
  close(): Promise<void> {
    if (this.forceClosePromise) return this.forceClosePromise;
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      let failure: unknown;
      try { await this.stop(); } catch (error) { failure = error; }
      try { await this.disposeResources(); } catch (error) { failure ??= error; }
      if (failure) throw failure;
    })(); return this.closePromise;
  }
  /** Hard-stop path after the runner terminates an unresponsive Worker. Never waits for its ACK. */
  forceClose(): Promise<void> {
    if (this.forceClosePromise) return this.forceClosePromise;
    this.stopping = true; clearInterval(this.latencyTimer); this.mute(); this.abandonedEpoch = !!this.streamNode;
    // Tickets of this epoch are retired, never credited to another run's pool.
    this.abortStop?.(new Error('Audio epoch abandoned after Worker termination'));
    this.post({ type: 'stop' });
    this.forceClosePromise = this.disposeResources(); return this.forceClosePromise;
  }
  snapshot() { return { pcm: this.descriptor?.pcm ?? null, driver: this.descriptor?.driver ?? null, kind: this.descriptor?.kind ?? null, abandonedEpoch: this.abandonedEpoch, abandonedChunks: this.abandonedEpoch ? 'unknown' as const : 0, contextsCreated: this.contextsCreated, contextsClosed: this.contextsClosed, liveNodes: this.nodesDisposed ? 0 : (this.gate ? 1 : 0) + (this.streamConnected ? 1 : 0) + (this.meterNode ? 1 : 0) + this.buses.length * 3 + Array.from(this.voices.values()).reduce((sum, voice) => sum + 1 + (voice.source ? 1 : 0) + voice.edges.length * 8, 0) + (this.inputSource ? 1 : 0), latePackets: this.latePackets, transferredChunksOwned: this.transferredChunksOwned, inputDroppedFrames: this.inputDroppedFrames, outputUnderruns: this.outputUnderruns, outputPeak: this.outputPeak, outputChecks: this.outputChecks, sampleBytes: this.sampleBytes, voiceBytes: this.voiceBytes, samples: this.samples.size, voices: this.voices.size, pendingInputRequests:this.inputOperations.size,maxPendingInputRequests:this.maxPendingInputRequests,contextClosed:!this.context||this.context.state==='closed',stopping: this.stopping, closed: this.closed }; }
}
