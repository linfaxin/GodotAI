import { DEFAULT_AUDIO_LIMITS, workerAudioPcmForFrames, type AudioPort, type AudioReturn, type GodotWorkerAudio, type SampleBusOperation, type WorkerAudioDescriptor, type WorkerAudioPreferences, type WorkerAudioStream } from './worker-audio-protocol.js';

export interface WorkerAudioBridgeOptions { runId: string; audioEpoch: number; onError?: (error: Error) => void }
interface VoiceMirror { epoch: number; streamId: string; position: number; positionCommandSeq: number }
interface Loan { seq: number; bytes: number; ringPosition: number; samples: number }

/** The native ABI lives in the engine Worker. No native import waits for another thread.
 * One instance owns one immutable run/audio epoch. The native Web ABI has init/resume/close,
 * stream create/start and input start/stop, but no global same-run reset/reopen operation.
 * Context suspend/resume and input restart retain this epoch; full reset creates a new Worker.
 * A sample stop/start (including a seek implemented by restart) gets a fresh voice epoch.
 */
export class WorkerAudioBridge implements GodotWorkerAudio {
  private descriptor?: WorkerAudioDescriptor;
  private preparePromise?: Promise<WorkerAudioDescriptor>;
  private resolvePrepare?: (value: WorkerAudioDescriptor) => void;
  private rejectPrepare?: (error: Error) => void;
  private closePromise?: Promise<void>;
  private receivedClosed = false;
  private resolveClose?: () => void;
  private rejectClose?: (error: Error) => void;
  private stopped = false;
  private sequence = 0;
  private pending = new Set<number>();
  private samples = new Map<string, number>();
  private voices = new Map<string, VoiceMirror>();
  private voiceEpoch = 0;
  private sampleBytes = 0;
  // Logical unregister is immediate, but the Host can still own the sample or
  // its transferred registration buffer until the matching unregister ACK.
  private retainedSampleBytes = 0;
  private retainedSampleCount = 0;
  private sampleRegistrations = new Map<number, number>();
  private sampleReleases = new Map<number, number>();
  private voiceBytes = 0;
  private finished?: (id: string) => void;
  private stateCallback?: (state: number) => void;
  private latencyCallback?: (seconds: number) => void;
  private stream?: WorkerAudioStream;
  private loans = new Map<number, Loan>();
  private blockSequence = 0;
  private inputEpoch = 0;
  private inputEnabled = false;
  private inputPosition = 0;
  private lastCaptureSequence = 0;
  inputState: 'stopped' | 'pending' | 'active' | 'denied' = 'stopped';
  private nextBlockId = 0;

  constructor(private readonly control: AudioPort, private readonly pcm: AudioPort, private readonly options: WorkerAudioBridgeOptions) {
    control.onmessage = (event) => this.receive(event.data);
    pcm.onmessage = (event) => { if (event.data.type === 'capture') this.capture(event.data); else if (event.data.type === 'pcm-flushed' && this.matches(event.data)) this.control.postMessage({ ...this.envelope(), type: 'pcm-flushed', outstandingLoans: this.loans.size }); else this.returnBlock(event.data); };
    control.start(); pcm.start();
  }
  private envelope() { return { runId: this.options.runId, audioEpoch: this.options.audioEpoch }; }
  private matches(data: { runId?: unknown; audioEpoch?: unknown }) { return data?.runId === this.options.runId && data.audioEpoch === this.options.audioEpoch; }
  private fail(message: string): void {
    const error = new Error(message);
    this.stopped = true;
    this.rejectPrepare?.(error); this.rejectClose?.(error);
    this.options.onError?.(error);
  }
  private receive(data: any): void {
    if (!this.matches(data)) return;
    switch (data.type) {
      case 'prepared':
        this.descriptor = data.descriptor;
        this.resolvePrepare?.(data.descriptor);
        break;
      case 'ack': {
        if (!this.pending.delete(data.seq)) break;
        const registration = this.sampleRegistrations.get(data.seq);
        if (registration !== undefined) {
          // Host finished copying the transfer buffer into its AudioBuffer.
          this.sampleRegistrations.delete(data.seq); this.retainedSampleBytes -= registration;
        }
        const bytes = this.sampleReleases.get(data.seq);
        if (bytes !== undefined) {
          this.sampleReleases.delete(data.seq);
          this.retainedSampleBytes -= bytes; this.retainedSampleCount--;
        }
        break;
      }
      case 'input-status': if (data.inputEpoch === this.inputEpoch) this.inputState = data.state; break;
      case 'error': this.fail(String(data.message)); break;
      case 'latency':
        if (this.descriptor && !this.stopped) { this.descriptor.outputLatency = data.outputLatency; this.latencyCallback?.(data.outputLatency); }
        break;
      case 'state':
        if (this.descriptor) { this.descriptor.state = data.state; this.descriptor.outputLatency = data.outputLatency; }
        this.stateCallback?.(data.state === 'running' ? 1 : data.state === 'closed' ? 2 : 0);
        this.latencyCallback?.(data.outputLatency);
        break;
      case 'position': {
        const voice = this.voices.get(data.id);
        if (voice && voice.epoch === data.voiceEpoch && voice.positionCommandSeq === data.commandSeq) voice.position = data.position;
        break;
      }
      case 'finished': {
        const voice = this.voices.get(data.id);
        if (voice?.epoch === data.voiceEpoch) this.finishVoice(data.id);
        break;
      }
      case 'stop': this.stopLocal(); this.pcm.postMessage({ ...this.envelope(), type: 'producer-stopped' }); this.control.postMessage({ ...this.envelope(), type: 'worker-stopped' }); break;
      case 'stopped': this.stopLocal(); this.retireSamples(); break; // Host consumed/discarded the preceding control queue.
      case 'closed': this.stopLocal(); this.retireSamples(); this.receivedClosed = true; this.resolveClose?.(); break;
    }
  }
  available(): boolean { return !this.stopped; }
  hasWorklet(): boolean { return this.descriptor?.kind === 'worklet'; }
  prepare(preferences: WorkerAudioPreferences): Promise<WorkerAudioDescriptor> {
    if (this.stopped) return Promise.reject(new Error('Audio bridge is stopped'));
    if (this.preparePromise) return this.preparePromise;
    this.preparePromise = new Promise((resolve, reject) => { this.resolvePrepare = resolve; this.rejectPrepare = reject; });
    this.control.postMessage({ ...this.envelope(), type: 'prepare', preferences });
    return this.preparePromise;
  }
  init(requestedRate: number, _latencyMs: number, onState: (state: number) => void, onLatency: (seconds: number) => void) {
    const d = this.requireDescriptor();
    if (d.kind === 'dummy') throw new Error('Explicit Dummy driver does not initialize a Web audio stream');
    if (requestedRate !== 0 && d.sampleRate !== requestedRate) throw new Error(`AudioHost sample rate ${d.sampleRate} differs from project ${requestedRate}`);
    this.stateCallback = onState; this.latencyCallback = onLatency;
    onState(d.state === 'running' ? 1 : d.state === 'closed' ? 2 : 0); onLatency(d.outputLatency);
    return { sampleRate: d.sampleRate, channels: d.channels };
  }
  private requireDescriptor(): WorkerAudioDescriptor {
    if (this.stopped || !this.descriptor) throw new Error('AudioHost must be prepared before native audio initialization');
    return this.descriptor;
  }
  private command(operation: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []): number {
    if (this.stopped) return 0;
    const d = this.requireDescriptor();
    if (this.pending.size >= d.limits.pendingCommands) throw new Error('Audio command budget exceeded');
    const seq = ++this.sequence; this.pending.add(seq);
    try { this.control.postMessage({ ...this.envelope(), type: 'command', seq, operation, ...payload }, transfer); }
    catch (error) { this.pending.delete(seq); throw error; }
    return seq;
  }
  resume(): void { if (!this.stopped && this.descriptor?.kind === 'worklet') this.command('resume'); }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.receivedClosed) return (this.closePromise = Promise.resolve());
    this.closePromise = new Promise((resolve, reject) => { this.resolveClose = resolve; this.rejectClose = reject; });
    this.stopLocal();
    this.control.postMessage({ ...this.envelope(), type: 'close' });
    return this.closePromise;
  }
  /** Synchronous local fence; Host stop/close messages still own their ACKs. */
  revoke(): void { this.stopLocal(); }
  private stopLocal(): void {
    if (!this.descriptor) this.rejectPrepare?.(new Error('Audio preparation canceled'));
    this.stopped = true; this.inputEnabled = false; this.inputState = 'stopped'; this.stream = undefined; this.voices.clear(); this.samples.clear();
    this.voiceBytes = 0; this.sampleBytes = 0; this.pending.clear();
    // Detached in-flight buffers remain charged to their original epoch until returned or port disposal.
  }
  private retireSamples(): void {
    this.retainedSampleBytes = 0; this.retainedSampleCount = 0; this.sampleRegistrations.clear(); this.sampleReleases.clear();
  }
  streamCreate(channels: number): void { if (channels !== this.requireDescriptor().channels) throw new Error('Native audio channel count mismatch'); }
  streamStart(stream: WorkerAudioStream): void {
    const d = this.requireDescriptor();
    if (this.stream) throw new Error('Native audio stream already started');
    if (stream.outSamples <= 0 || stream.outSamples % d.channels !== 0) throw new Error('Invalid native audio ring');
    const nativeFrames = stream.outSamples / d.channels;
    const blocks = Math.min(d.limits.streamBlocks, Math.ceil(nativeFrames / d.limits.streamBlockFrames));
    const maxFrames = Math.ceil(nativeFrames / blocks), blockSamples = maxFrames * d.channels;
    workerAudioPcmForFrames(nativeFrames, d.channels, d.limits);
    if (d.pcm && (stream.outSamples !== d.pcm.nativeRingSamples || stream.inSamples !== d.pcm.nativeRingSamples)) throw new Error('Native PCM rings differ from phase-one admission');
    this.stream = stream;
    // Cover the complete native ring. A larger project ring must not be silently cut to 8 x 256 frames.
    this.pcm.postMessage({ ...this.envelope(), type: 'stream', channels: d.channels, maxBlocks: blocks, maxFrames, outSamples: stream.outSamples, inSamples: stream.inSamples });
    let position = 0;
    for (let i = 0; i < blocks; i++) {
      const samples = Math.min(blockSamples, stream.outSamples - position);
      const id = ++this.nextBlockId;
      const buffer = new ArrayBuffer(samples * 4);
      this.sendBlock(id, buffer, position, samples, false);
      position = (position + samples) % stream.outSamples;
    }
  }
  private sendBlock(id: number, buffer: ArrayBuffer, position: number, samples: number, refill: boolean): void {
    const stream = this.stream;
    if (!stream || this.stopped) return;
    if (refill) stream.outCallback(position, samples);
    const heap = stream.heap();
    const ring = heap.subarray(stream.outPtr / 4, stream.outPtr / 4 + stream.outSamples);
    const output = new Float32Array(buffer);
    const first = Math.min(samples, stream.outSamples - position);
    output.set(ring.subarray(position, position + first));
    if (first < samples) output.set(ring.subarray(0, samples - first), first);
    const blockSeq = ++this.blockSequence;
    this.loans.set(id, { seq: blockSeq, bytes: buffer.byteLength, ringPosition: position, samples });
    this.pcm.postMessage({ ...this.envelope(), type: 'block', blockId: id, blockSeq, frames: samples / this.requireDescriptor().channels, channels: this.requireDescriptor().channels, format: 'f32-interleaved', buffer }, [buffer]);
  }
  private returnBlock(data: AudioReturn): void {
    if (!this.matches(data) || data.type !== 'return') return;
    const loan = this.loans.get(data.blockId);
    if (!loan || loan.seq !== data.blockSeq || !(data.buffer instanceof ArrayBuffer) || data.buffer.byteLength !== loan.bytes) return;
    this.loans.delete(data.blockId);
    if (!this.stopped && this.stream) this.sendBlock(data.blockId, data.buffer, loan.ringPosition, loan.samples, true);
  }
  inputStart(): number {
    if (this.stopped || this.descriptor?.kind !== 'worklet') return 1;
    if (this.inputEnabled) return 0;
    this.inputEnabled = true; this.inputState = 'pending'; this.inputEpoch++; this.inputPosition = 0;
    this.command('input-start', { inputEpoch: this.inputEpoch });
    return 0; // Accepted asynchronously; inputState changes only after browser permission resolves.
  }
  inputStop(): void {
    if (!this.inputEnabled || this.stopped) return;
    this.inputEnabled = false; this.inputState = 'stopped'; this.command('input-stop', { inputEpoch: this.inputEpoch });
  }
  private capture(data: any): void {
    if (!this.matches(data) || !(data.buffer instanceof ArrayBuffer)) return;
    const stream = this.stream; const d = this.descriptor;
    const captureBlockFrames = d?.pcm?.captureBlockFrames ?? d?.limits.streamBlockFrames;
    const valid = d && captureBlockFrames && Number.isInteger(data.frames) && data.frames > 0 && data.frames <= captureBlockFrames && data.channels === d.inputChannels && data.buffer.byteLength === captureBlockFrames * d.inputChannels * 4;
    if (!this.stopped && this.inputEnabled && data.inputEpoch === this.inputEpoch && data.captureSeq > this.lastCaptureSequence && valid && stream && stream.inSamples > 0) {
      this.lastCaptureSequence = data.captureSeq;
      const input = new Float32Array(data.buffer, 0, data.frames * data.channels);
      const ring = stream.heap().subarray(stream.inPtr / 4, stream.inPtr / 4 + stream.inSamples);
      let consumed = 0;
      while (consumed < input.length) {
        const take = Math.min(input.length - consumed, ring.length - this.inputPosition);
        const from = this.inputPosition;
        ring.set(input.subarray(consumed, consumed + take), from);
        stream.inCallback(from, take);
        this.inputPosition = (from + take) % ring.length; consumed += take;
      }
    }
    this.pcm.postMessage({ ...this.envelope(), type: 'capture-return', blockId: data.blockId, captureSeq: data.captureSeq, inputEpoch: data.inputEpoch, buffer: data.buffer }, [data.buffer]);
  }
  setFinishedCallback(callback: (id: string) => void): void { this.finished = callback; }
  samplePreflight(frames: number, channels: number): boolean {
    if (this.stopped) return false;
    const d = this.requireDescriptor();
    const bytes = frames * channels * 4;
    // Native AudioFrame decode + native planar staging + transfer copy + host AudioBuffer.
    return d.kind === 'worklet' && channels === 2 && Number.isSafeInteger(frames) && frames > 0 && Number.isSafeInteger(bytes * 4) && this.retainedSampleCount < d.limits.sampleCount && this.retainedSampleBytes + bytes * 4 <= d.limits.sampleBytes;
  }
  sampleRegister(id: string, data: Float32Array, frames: number, loopMode: string, loopBegin: number, loopEnd: number): void {
    if (this.stopped) return;
    const d = this.requireDescriptor();
    const bytes = frames * 2 * 4;
    if (!Number.isSafeInteger(frames) || frames < 1 || data.length !== frames * 2) throw new Error('Invalid native planar sample');
    if (this.samples.has(id)) return;
    if (this.retainedSampleCount >= d.limits.sampleCount || this.retainedSampleBytes + bytes * 2 > d.limits.sampleBytes) throw new Error('Registered sample memory budget exceeded');
    if (this.pending.size >= d.limits.pendingCommands) throw new Error('Audio command budget exceeded');
    const copy = new Float32Array(data); // Never transfer a view of WebAssembly.Memory.
    this.samples.set(id, bytes); this.sampleBytes += bytes;
    this.retainedSampleBytes += bytes * 2; this.retainedSampleCount++;
    try { const sequence=this.command('register', { id, frames, loopMode, loopBegin, loopEnd, buffer: copy.buffer }, [copy.buffer]);this.sampleRegistrations.set(sequence,bytes); }
    catch (error) { this.samples.delete(id); this.sampleBytes -= bytes; this.retainedSampleBytes -= bytes * 2; this.retainedSampleCount--; throw error; }
  }
  sampleUnregister(id: string): void {
    const bytes = this.samples.get(id); if (bytes === undefined) return;
    for (const [voiceId, voice] of this.voices) if (voice.streamId === id) this.sampleStop(voiceId);
    const sequence = this.command('unregister', { id });
    this.sampleReleases.set(sequence, bytes); this.samples.delete(id); this.sampleBytes -= bytes;
  }
  sampleIsRegistered(id: string): boolean { return this.samples.has(id); }
  sampleStart(id: string, streamId: string, bus: number, offset: number, pitch: number, volume: ArrayLike<number>): void {
    if (this.stopped) return;
    const d = this.requireDescriptor(); const bytes = this.samples.get(streamId);
    if (bytes === undefined) throw new Error('Starting an unregistered audio sample');
    if (this.voices.has(id)) this.sampleStop(id);
    if (this.voices.size >= d.limits.voices || this.voiceBytes + bytes > d.limits.voiceBytes) throw new Error('Audio voice memory budget exceeded');
    const epoch = ++this.voiceEpoch;
    const positionCommandSeq = this.command('start', { id, streamId, bus, offset, pitch, volume: Array.from(volume), voiceEpoch: epoch });
    this.voices.set(id, { epoch, streamId, position: offset, positionCommandSeq }); this.voiceBytes += bytes;
  }
  private finishVoice(id: string): void {
    const voice = this.voices.get(id); if (!voice) return;
    this.voices.delete(id); this.voiceBytes -= this.samples.get(voice.streamId) ?? 0;
    this.finished?.(id);
  }
  private voiceCommand(operation: string, id: string, payload: Record<string, unknown> = {}, positionBarrier = false): void {
    const voice = this.voices.get(id); if (voice) { const seq = this.command(operation, { id, voiceEpoch: voice.epoch, ...payload }); if (positionBarrier) voice.positionCommandSeq = seq; }
  }
  sampleStop(id: string): void { this.voiceCommand('stop', id); this.finishVoice(id); }
  samplePause(id: string, paused: boolean): void { this.voiceCommand('pause', id, { paused }, true); }
  sampleIsActive(id: string): boolean { return this.voices.has(id); }
  samplePosition(id: string): number { return this.voices.get(id)?.position ?? 0; }
  samplePitch(id: string, pitch: number): void { this.voiceCommand('pitch', id, { pitch }, true); }
  sampleVolumes(id: string, buses: number[], volumes: ArrayLike<number>): void { if (!this.stopped) this.voiceCommand('volumes', id, { buses, volumes: Array.from(volumes) }); }
  sampleBus(operation: SampleBusOperation, index: number, value?: number | boolean): void { if (!this.stopped) this.command('bus', { busOperation: operation, index, value }); }
  /** Diagnostic accounting is used by teardown tests, never to admit another epoch's tickets. */
  snapshot() { return { sampleBytes: this.sampleBytes, retainedSampleBytes: this.retainedSampleBytes, retainedSampleCount: this.retainedSampleCount, retiringSamples: this.sampleReleases.size, voiceBytes: this.voiceBytes, loans: this.loans.size, pendingCommands: this.pending.size, stopped: this.stopped }; }
}
export function createWorkerAudioBridge(control: AudioPort, pcm: AudioPort, options: WorkerAudioBridgeOptions): WorkerAudioBridge { return new WorkerAudioBridge(control, pcm, options); }
