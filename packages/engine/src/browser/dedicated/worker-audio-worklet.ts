import type { AudioBlock, AudioEnvelope, AudioPort } from './worker-audio-protocol.js';

interface QueuedBlock { message: AudioBlock; samples: Float32Array; offset: number }
/** Fixed-capacity transferred-buffer queue. Engine work never runs in process(). */
export class WorkerAudioRenderQueue {
  private readonly queue: Array<QueuedBlock | undefined>;
  private head = 0;
  private count = 0;
  private nextSequence = 1;
  private stopped = false;
  underruns = 0;
  outputPeak = 0;
  outputChecks = 0;
  constructor(private readonly identity: AudioEnvelope, readonly channels: number, private maxFrames: number, private readonly capacity: number, private readonly send: (message: unknown, transfer: Transferable[]) => void) {
    this.queue = new Array(capacity);
  }
  private giveBack(message: AudioBlock): void {
    if (!(message.buffer instanceof ArrayBuffer)) return;
    this.send({ ...this.identity, type: 'return', blockId: message.blockId, blockSeq: message.blockSeq, buffer: message.buffer }, [message.buffer]);
  }
  accept(message: AudioBlock): void {
    if (message.type !== 'block' || message.runId !== this.identity.runId || message.audioEpoch !== this.identity.audioEpoch) return;
    if (this.stopped) { this.giveBack(message); return; }
    if (message.blockSeq !== this.nextSequence || this.count === this.capacity || message.channels !== this.channels || message.format !== 'f32-interleaved' || !Number.isInteger(message.frames) || message.frames < 1 || message.frames > this.maxFrames || !(message.buffer instanceof ArrayBuffer) || message.buffer.byteLength !== message.frames * this.channels * 4) {
      this.giveBack(message); return;
    }
    this.nextSequence++;
    this.queue[(this.head + this.count) % this.capacity] = { message, samples: new Float32Array(message.buffer), offset: 0 };
    this.count++;
  }
  render(output: Float32Array[]): void {
    // Browsers zero outputs before process(), but clear explicitly to support reuse and tests.
    for (let channel = 0; channel < output.length; channel++) output[channel]!.fill(0);
    if (this.stopped || output.length === 0) return;
    const frames = output[0]!.length;
    this.outputChecks++;
    let written = 0;
    while (written < frames && this.count > 0) {
      const block = this.queue[this.head]!;
      const take = Math.min(frames - written, block.message.frames - block.offset);
      for (let c = 0; c < Math.min(output.length, this.channels); c++) {
        const channel = output[c]!;
        for (let f = 0; f < take; f++) { const value = block.samples[(block.offset + f) * this.channels + c]!; channel[written + f] = value; this.outputPeak = Math.max(this.outputPeak, Math.abs(value)); }
      }
      block.offset += take; written += take;
      if (block.offset === block.message.frames) {
        this.queue[this.head] = undefined; this.head = (this.head + 1) % this.capacity; this.count--;
        this.giveBack(block.message);
      }
    }
    if (written < frames) this.underruns++;
  }
  flush(): void {
    this.stopped = true;
    while (this.count > 0) {
      const block = this.queue[this.head]!;
      this.queue[this.head] = undefined; this.head = (this.head + 1) % this.capacity; this.count--;
      this.giveBack(block.message);
    }
  }
  configureMaximumFrames(frames: number): boolean {
    if (this.nextSequence !== 1 || this.count !== 0 || !Number.isSafeInteger(frames) || frames < 1) return false;
    this.maxFrames = frames; return true;
  }
  get queuedBlocks(): number { return this.count; }
}

/** Independently bounded microphone loans; buffers are allocated before the realtime callback. */
export class WorkerAudioCapturePool {
  private readonly buffers: Array<Float32Array | undefined>;
  private readonly tickets: Array<{ seq: number; inputEpoch: number } | undefined>;
  private sequence = 0;
  private fillingIndex = -1;
  private fillingFrames = 0;
  private inputEpoch = 0;
  private enabled = false;
  private stopped = false;
  droppedFrames = 0;
  constructor(private readonly identity: AudioEnvelope, readonly channels: number, private readonly maxFrames: number, capacity: number, private readonly send: (message: unknown, transfer: Transferable[]) => void) {
    this.buffers = Array.from({ length: capacity }, () => new Float32Array(maxFrames * channels)); this.tickets = new Array(capacity);
  }
  enable(enabled: boolean, inputEpoch: number): void { if (!this.stopped) { this.enabled = enabled; this.inputEpoch = inputEpoch; this.fillingIndex = -1; this.fillingFrames = 0; } }
  capture(input: Float32Array[]): void {
    if (!this.enabled || this.stopped || !input[0]) return;
    const totalFrames = input[0].length;
    let from = 0;
    while (from < totalFrames) {
      if (this.fillingIndex < 0) {
        for (let candidate = 0; candidate < this.buffers.length; candidate++) if (this.buffers[candidate]) { this.fillingIndex = candidate; break; }
      }
      if (this.fillingIndex < 0) { this.droppedFrames += totalFrames - from; return; }
      const id = this.fillingIndex, frames = Math.min(totalFrames - from, this.maxFrames - this.fillingFrames);
      const samples = this.buffers[id]!;
      for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < this.channels; channel++) samples[(this.fillingFrames + frame) * this.channels + channel] = input[channel]?.[from + frame] ?? input[0][from + frame]!;
      this.fillingFrames += frames; from += frames;
      if (this.fillingFrames === this.maxFrames) {
        // Use the entire preallocated block; a 128-frame render quantum must not waste half a 256-frame loan.
        const buffer = samples.buffer as ArrayBuffer; this.buffers[id] = undefined;
        const captureSeq = ++this.sequence; this.tickets[id] = { seq: captureSeq, inputEpoch: this.inputEpoch };
        this.send({ ...this.identity, type: 'capture', blockId: id, captureSeq, inputEpoch: this.inputEpoch, frames: this.maxFrames, channels: this.channels, buffer }, [buffer]);
        this.fillingIndex = -1; this.fillingFrames = 0;
      }
    }
  }

  returned(data: any): void {
    if (data.runId !== this.identity.runId || data.audioEpoch !== this.identity.audioEpoch) return;
    const ticket = this.tickets[data.blockId];
    if (!ticket || ticket.seq !== data.captureSeq || ticket.inputEpoch !== data.inputEpoch || !(data.buffer instanceof ArrayBuffer) || data.buffer.byteLength !== this.maxFrames * this.channels * 4) return;
    this.tickets[data.blockId] = undefined;
    if (!this.stopped) this.buffers[data.blockId] = new Float32Array(data.buffer);
  }
  flush(): void { this.stopped = true; this.enabled = false; this.fillingIndex = -1; this.fillingFrames = 0; this.buffers.fill(undefined); }
  get outstanding(): number { let count = 0; for (const ticket of this.tickets) if (ticket) count++; return count; }
}

/** Existing Web sample position counts rendered output frames, not pitch-scaled source time.
 * Generations fence those actual observations across independent control and node ports. */
export class WorkerAudioPositionCounter {
  private frames = 0;
  private reportAt = 2048;
  private voiceEpoch = 0;
  private commandSeq = 0;
  private paused = true;
  configure(data: any): { type: 'position-generation-ack'; frames: number; voiceEpoch: number; commandSeq: number } | undefined {
    if (data.type !== 'position-generation' || !Number.isSafeInteger(data.voiceEpoch) || data.voiceEpoch < 1 || !Number.isSafeInteger(data.commandSeq) || data.commandSeq < 1 || data.commandSeq <= this.commandSeq || (this.voiceEpoch !== 0 && data.voiceEpoch !== this.voiceEpoch)) return;
    if (data.reset && this.commandSeq === 0) this.frames = 0;
    this.voiceEpoch = data.voiceEpoch; this.commandSeq = data.commandSeq; this.paused = !!data.paused; this.reportAt = this.frames + 2048;
    return { type: 'position-generation-ack', frames: this.frames, voiceEpoch: this.voiceEpoch, commandSeq: this.commandSeq };
  }
  processFrames(frames: number): { type: 'position'; frames: number; voiceEpoch: number; commandSeq: number } | undefined {
    if (this.paused || frames < 1) return;
    this.frames += frames;
    if (this.frames < this.reportAt) return;
    this.reportAt = this.frames + 2048;
    return { type: 'position', frames: this.frames, voiceEpoch: this.voiceEpoch, commandSeq: this.commandSeq };
  }
}

declare const AudioWorkletProcessor: { new(options?: unknown): { port: MessagePort } };
declare const registerProcessor: (name: string, processor: unknown) => void;
// The guard also allows the bounded renderer to be unit-tested in Node.
if (typeof AudioWorkletProcessor !== 'undefined') {
  class GodotWorkerAudioProcessor extends AudioWorkletProcessor {
    private queue?: WorkerAudioRenderQueue;
    private capturePool?: WorkerAudioCapturePool;
    private direct?: AudioPort;
    private identity?: AudioEnvelope;
    private flushing = false;
    private flushReported = false;
    private producerStopped = false;
    private reportFrames = 0;
    constructor(options?: unknown) {
      super(options);
      this.port.onmessage = (event) => {
        const data = event.data;
        if (data.type === 'attach') {
          const captureBytes = data.maxBlocks * data.captureBlockFrames * data.inputChannels * 4;
          if (!Number.isSafeInteger(data.captureBlockFrames) || data.captureBlockFrames < data.maxFrames || data.captureBlockFrames % 128 !== 0 || data.captureBlockFrames > 16384 || !Number.isSafeInteger(data.maxBlocks) || data.maxBlocks < 1 || data.maxBlocks > 64 || data.inputChannels !== 2 || !Number.isSafeInteger(captureBytes) || captureBytes > data.pcmBytes) { this.port.postMessage({ runId: data.runId, audioEpoch: data.audioEpoch, type: 'stream-error', message: 'Invalid or over-budget capture pool configuration' }); return; }
          this.identity = { runId: data.runId, audioEpoch: data.audioEpoch };
          this.direct = data.port;
          const send = (message: unknown, transfer: Transferable[]) => this.direct!.postMessage(message, transfer);
          this.queue = new WorkerAudioRenderQueue(this.identity, data.channels, data.maxFrames, data.maxBlocks, send);
          this.capturePool = new WorkerAudioCapturePool(this.identity, data.inputChannels, data.captureBlockFrames, data.maxBlocks, send);
          this.direct!.onmessage = (message) => {
            if (message.data.type === 'stream') {
              const config = message.data;
              const outputBytes = config.outSamples * 4, captureBytes = data.maxBlocks * data.captureBlockFrames * data.inputChannels * 4;
              if (config.runId !== data.runId || config.audioEpoch !== data.audioEpoch || config.channels !== data.channels || !Number.isSafeInteger(config.maxBlocks) || config.maxBlocks < 1 || config.maxBlocks > data.maxBlocks || !Number.isSafeInteger(outputBytes) || outputBytes < 1 || outputBytes + captureBytes > data.pcmBytes || config.inSamples !== config.outSamples || config.inSamples / config.channels > data.maxBlocks * data.captureBlockFrames || config.maxFrames !== Math.ceil(config.outSamples / config.channels / config.maxBlocks) || !this.queue!.configureMaximumFrames(config.maxFrames)) this.port.postMessage({ ...this.identity, type: 'stream-error', message: 'Invalid or over-budget native PCM ring configuration' });
            }
            if (message.data.type === 'block') this.queue!.accept(message.data);
            if (message.data.type === 'capture-return') this.capturePool!.returned(message.data);
            if (message.data.type === 'producer-stopped' && message.data.runId === this.identity!.runId && message.data.audioEpoch === this.identity!.audioEpoch) this.producerStopped = true;
            this.finishFlush();
          };
          this.direct!.start();
          this.port.postMessage({ ...this.identity, type: 'attached' });
        } else if (this.identity && this.identity.runId === data.runId && this.identity.audioEpoch === data.audioEpoch) {
          if (data.type === 'flush') { this.flushing = true; this.queue?.flush(); this.capturePool?.flush(); this.finishFlush(); }
          if (data.type === 'capture-enable') this.capturePool?.enable(data.enabled, data.inputEpoch);
        }
      };
    }
    private metrics(): void {
      this.port.postMessage({ ...this.identity, type: 'metrics', outputPeak: this.queue?.outputPeak ?? 0, outputChecks: this.queue?.outputChecks ?? 0, underruns: this.queue?.underruns ?? 0, inputDroppedFrames: this.capturePool?.droppedFrames ?? 0, transferredChunksOwned: (this.queue?.queuedBlocks ?? 0) + (this.capturePool?.outstanding ?? 0) });
    }
    private finishFlush(): void {
      if (!this.flushing || !this.producerStopped || this.flushReported || this.capturePool?.outstanding) return;
      this.flushReported = true; this.metrics();
      // Same PCM port places every output return before the Worker flush marker.
      this.direct?.postMessage({ ...this.identity, type: 'pcm-flushed' });
      this.port.postMessage({ ...this.identity, type: 'flushed' });
    }
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      if (outputs[0]) { this.queue?.render(outputs[0]); this.reportFrames += outputs[0][0]?.length ?? 0; }
      if (inputs[0]) this.capturePool?.capture(inputs[0]);
      if (this.reportFrames >= 4096) { this.reportFrames = 0; this.metrics(); }
      return true;
    }
  }
  class GodotWorkerPositionProcessor extends AudioWorkletProcessor {
    private readonly counter = new WorkerAudioPositionCounter();
    constructor(options?: unknown) { super(options); this.port.onmessage = (event) => { const ack = this.counter.configure(event.data); if (ack) this.port.postMessage(ack); }; }
    process(inputs: Float32Array[][]): boolean {
      if (inputs[0]?.[0]) { const report = this.counter.processFrames(inputs[0][0].length); if (report) this.port.postMessage(report); }
      return true;
    }
  }
  class GodotWorkerMeterProcessor extends AudioWorkletProcessor {
    private peak = 0;
    private checks = 0;
    private reportFrames = 0;
    private readonly identity: AudioEnvelope;
    constructor(options?: any) {
      super(options); this.identity = options.processorOptions;
      this.port.onmessage = (event) => { if (event.data.type === 'flush') { this.report(); this.port.postMessage({ ...this.identity, type: 'meter-flushed' }); } };
    }
    private report(): void { this.port.postMessage({ ...this.identity, type: 'output-metrics', outputPeak: this.peak, outputChecks: this.checks }); }
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      const output = outputs[0]; const input = inputs[0];
      if (!output?.[0]) return true;
      this.checks++;
      for (let channel = 0; channel < output.length; channel++) {
        const target = output[channel]!; const source = input?.[channel];
        if (source) { target.set(source); for (let frame = 0; frame < source.length; frame++) this.peak = Math.max(this.peak, Math.abs(source[frame]!)); }
        else target.fill(0);
      }
      this.reportFrames += output[0].length;
      if (this.reportFrames >= 4096) { this.reportFrames = 0; this.report(); }
      return true;
    }
  }
  registerProcessor('godot-worker-audio', GodotWorkerAudioProcessor);
  registerProcessor('godot-worker-meter', GodotWorkerMeterProcessor);
  registerProcessor('godot-worker-position', GodotWorkerPositionProcessor);
}
