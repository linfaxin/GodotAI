import type {RuntimeBinding, RuntimeCloseProgress} from '../runtime-host.js';

export interface NativeLifecycleModule {
  godotjsLifecycleVersion?: number;
  godotjsBeginExit?: () => void;
  godotjsCleanupTick?: () => void;
  godotjsReleaseExit?: () => void;
  [key: string]: unknown;
}
export interface NativeLifecycleGateOptions {
  onBegin?(): void;
  onProgress?(progress: RuntimeCloseProgress): void;
  onError?(error: unknown): void;
}
export interface NativeLifecycleGate {
  beginClose(reason?: string): void;
  tick(): void;
  dispose(): void;
  readonly begun: boolean;
}

/** This factory is also serialized into Emscripten pthreads. Keep runtime
 * dependencies inside the factory; the binding and native module are owned by
 * the actual engine realm, never by its Window proxy. */
export function installNativeLifecycleGate(module: NativeLifecycleModule, binding: RuntimeBinding, options: NativeLifecycleGateOptions = {}): NativeLifecycleGate {
  if (module.godotjsLifecycleVersion !== 1 || typeof module.godotjsReleaseExit !== 'function') throw Error('E_NATIVE_LIFECYCLE_ABI');
  let begun = false, nativeClosing = false, closed = false, pending = false, released = false;
  let epoch: string | undefined;
  const previousBegin = Object.getOwnPropertyDescriptor(module, 'godotjsBeginExit');
  const previousTick = Object.getOwnPropertyDescriptor(module, 'godotjsCleanupTick');
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* The host deadline still owns termination. */ } };
  const tick = () => {
    if (closed || !begun || pending || released) return;
    pending = true;
    // A tick returns to C++ before its deletion queue is consumed. Completion
    // can therefore be observed only by a subsequent tick, never by assuming
    // that queue_free or React's logical unmount destroyed the native object.
    void Promise.resolve().then(() => binding.drainClose()).then(progress => {
      pending = false;
      if (closed || released || binding.snapshotSummary().epoch !== epoch) return;
      options.onProgress?.(progress);
      if (!nativeClosing || !progress.canNativeCleanup || binding.snapshotSummary().sealed || progress.pendingStartup || progress.pendingCleanups || progress.status === 'pending') return;
      released = true;
      module.godotjsReleaseExit!();
    }).catch(error => { pending = false; report(error); });
  };
  const beginClose = (reason = 'native-quit') => {
    if (closed || begun) return;
    begun = true; epoch = binding.snapshotSummary().epoch;
    binding.beginClose(reason);
    try { options.onBegin?.(); } catch (error) { report(error); }
    tick();
  };
  const onBegin = () => { nativeClosing = true; beginClose('native-quit'); tick(); };
  Object.defineProperty(module, 'godotjsBeginExit', {configurable: true, writable: true, value: onBegin});
  Object.defineProperty(module, 'godotjsCleanupTick', {configurable: true, writable: true, value: tick});
  return {
    get begun() { return begun; }, beginClose, tick,
    dispose() {
      if (closed) return; closed = true;
      for (const [name, installed, previous] of [['godotjsBeginExit', onBegin, previousBegin], ['godotjsCleanupTick', tick, previousTick]] as const) {
        if (Object.getOwnPropertyDescriptor(module, name)?.value !== installed) continue;
        if (previous) Object.defineProperty(module, name, previous); else delete module[name];
      }
    },
  };
}
