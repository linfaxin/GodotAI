/** Audio ABI shared by the ordinary engine Worker, AudioHost and AudioWorklet. */
export type AudioPort = Pick<MessagePort, 'postMessage' | 'start' | 'close'> & { onmessage: ((event: MessageEvent) => void) | null };
export const NATIVE_AUDIO_INPUT_CHANNELS = 2 as const;
export interface WorkerAudioPreferences { mixRate: number; latencyMs: number; driver: string | number }
export interface WorkerAudioLimits { pcmBytes: number; streamBlocks: number; streamBlockFrames: number; sampleBytes: number; sampleCount: number; voiceBytes: number; voices: number; pendingCommands: number }
export const DEFAULT_AUDIO_LIMITS: WorkerAudioLimits = { pcmBytes: 4 * 1024 * 1024, streamBlocks: 8, streamBlockFrames: 256, sampleBytes: 64 * 1024 * 1024, sampleCount: 256, voiceBytes: 64 * 1024 * 1024, voices: 128, pendingCommands: 1024 };
export interface WorkerAudioDescriptor { kind: 'worklet' | 'dummy'; driver: 'AudioWorklet' | 'Dummy'; runId: string; audioEpoch: number; sampleRate: number; channels: number; inputChannels: 2; state: AudioContextState; outputLatency: number; pcm?: WorkerAudioPcmLayout; limits: WorkerAudioLimits }
export interface WorkerAudioStream { outPtr: number; outSamples: number; inPtr: number; inSamples: number; outCallback: (position: number, samples: number) => void; inCallback: (position: number, samples: number) => void; heap: () => Float32Array }
export interface SampleRegistration { id: string; frames: number; loopMode: string; loopBegin: number; loopEnd: number; data: Float32Array }
export interface SampleStart { id: string; streamId: string; bus: number; offset: number; pitch: number; volume: number[] }
export interface AudioEnvelope { runId: string; audioEpoch: number }
export interface AudioBlock extends AudioEnvelope { type: 'block'; blockId: number; blockSeq: number; frames: number; channels: number; format: 'f32-interleaved'; buffer: ArrayBuffer }
export interface AudioReturn extends AudioEnvelope { type: 'return'; blockId: number; blockSeq: number; buffer: ArrayBuffer }
export type SampleBusOperation = 'count' | 'remove' | 'add' | 'move' | 'send' | 'volume' | 'solo' | 'mute';
/** Synchronous native imports only read local state or enqueue commands. prepare is the sole startup barrier. */
export interface GodotWorkerAudio {
  prepare(preferences: WorkerAudioPreferences): Promise<WorkerAudioDescriptor>;
  available(): boolean; hasWorklet(): boolean;
  init(requestedRate: number, latencyMs: number, onState: (state: number) => void, onLatency: (seconds: number) => void): { sampleRate: number; channels: number };
  resume(): void; close(): Promise<void>;
  streamCreate(channels: number): void; streamStart(stream: WorkerAudioStream): void;
  inputStart(): number; inputStop(): void;
  setFinishedCallback(callback: (id: string) => void): void;
  samplePreflight(frames: number, channels: number): boolean;
  sampleRegister(id: string, data: Float32Array, frames: number, loopMode: string, loopBegin: number, loopEnd: number): void;
  sampleUnregister(id: string): void; sampleIsRegistered(id: string): boolean;
  sampleStart(id: string, streamId: string, bus: number, offset: number, pitch: number, volume: ArrayLike<number>): void;
  sampleStop(id: string): void; samplePause(id: string, paused: boolean): void; sampleIsActive(id: string): boolean; samplePosition(id: string): number;
  samplePitch(id: string, pitch: number): void; sampleVolumes(id: string, buses: number[], volumes: ArrayLike<number>): void;
  sampleBus(operation: SampleBusOperation, index: number, value?: number | boolean): void;
}

export interface WorkerAudioPcmLayout {
  inputChannels: 2; nativeRingFrames: number; nativeRingSamples: number;
  nativeOutputBytes: number; nativeInputBytes: number; nativeCaptureHistoryBytes: number; nativeBytes: number;
  transportOutputBytes: number; captureBlockFrames: number; capturePoolFrames: number; capturePoolBytes: number; transportBytes: number; transportBudgetBytes: number;
  totalBytes: number; budgetBytes: number;
}
/** PCM data only; allocator/JS object headers and browser-owned WebAudio buffers are outside this byte class. */
export function workerAudioPcmForFrames(frames: number, channels: number, limits: WorkerAudioLimits): WorkerAudioPcmLayout {
  const samples = frames * channels;
  // AudioDriverWeb allocates two float rings. AudioDriver::input_buffer_init additionally allocates
  // driver_frames * 2 channels * 4 history entries of int32, even when the output device is mono.
  if (!Number.isSafeInteger(frames) || frames < 1 || !Number.isSafeInteger(samples) || samples > 0x7fffffff || frames * 8 > 0x7fffffff) throw new Error('Native PCM ring would overflow int32 allocation sizes');
  const ringBytes = samples * 4, historyBytes = frames * 2 * 4 * 4;
  // Match the native ring's duration, not its output-channel-sized input_rb sample count.
  // Keep the existing minimum block size, eight default loans, and render-quantum alignment.
  const minimumFrames = Math.ceil(frames / limits.streamBlocks);
  const captureBlockFrames = Math.ceil(Math.max(minimumFrames, limits.streamBlockFrames) / 128) * 128;
  const capturePoolFrames = limits.streamBlocks * captureBlockFrames;
  const capturePoolBytes = capturePoolFrames * NATIVE_AUDIO_INPUT_CHANNELS * 4;
  const nativeBytes = ringBytes * 2 + historyBytes, transportBytes = ringBytes + capturePoolBytes;
  const totalBytes = nativeBytes + transportBytes;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.pcmBytes) throw new Error('Native rings, capture history and transport pools exceed audioPcmBytes budget');
  if (!Number.isSafeInteger(captureBlockFrames) || captureBlockFrames > 16384) throw new Error('Native capture ring exceeds bounded capture block capacity');
  return { inputChannels: NATIVE_AUDIO_INPUT_CHANNELS, nativeRingFrames: frames, nativeRingSamples: samples, nativeOutputBytes: ringBytes, nativeInputBytes: ringBytes, nativeCaptureHistoryBytes: historyBytes, nativeBytes, transportOutputBytes: ringBytes, captureBlockFrames, capturePoolFrames, capturePoolBytes, transportBytes, transportBudgetBytes: limits.pcmBytes - nativeBytes, totalBytes, budgetBytes: limits.pcmBytes };
}
/** Exact AudioDriverWeb expression: closest_power_of_2(uint32_t(int32_latency * int32_rate / 1000)). */
export function estimateWorkerAudioPcm(latencyMs: number, sampleRate: number, channels: number, limits: WorkerAudioLimits): WorkerAudioPcmLayout {
  if (!Number.isSafeInteger(latencyMs) || latencyMs < 1 || !Number.isSafeInteger(sampleRate) || sampleRate < 1 || ![1, 2, 4, 6, 8].includes(channels)) throw new Error('Invalid native PCM admission parameters');
  const product = latencyMs * sampleRate;
  if (!Number.isSafeInteger(product) || product > 0x7fffffff) throw new Error('Native latency times sample rate would overflow int32 before division');
  const requested = Math.trunc(product / 1000);
  if (requested < 1) throw new Error('Native PCM ring would have zero frames');
  const previous = 2 ** Math.floor(Math.log2(requested)), next = previous === requested ? previous : previous * 2;
  // Godot compares linear integer distances and chooses the larger power on a tie.
  const frames = next - requested > requested - previous ? previous : next;
  return workerAudioPcmForFrames(frames, channels, limits);
}
