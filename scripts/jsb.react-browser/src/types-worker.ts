import { createTypeSession, type TypecheckInput, type TypeScriptRuntime } from './typecheck.js';

export type TypesWorkerRequest =
  | { id: string | number; kind: 'load'; input: TypecheckInput; typescriptUrl?: string }
  | { id: string | number; kind: 'check' }
  | { id: string | number; kind: 'completion' | 'hover'; file: string; offset: number }
  | { id: string | number; kind: 'dispose' };

/** A module-worker handler, also injectable in tests and custom worker hosts. */
export function createTypesWorkerHandler(injected?: TypeScriptRuntime) {
  let runtime = injected;
  let session: ReturnType<typeof createTypeSession> | undefined;
  // Serialize loads and queries: an older asynchronous load cannot replace a newer one.
  let pending: Promise<unknown> = Promise.resolve();
  async function execute(message: TypesWorkerRequest) {
    switch (message.kind) {
      case 'load': {
        if (!runtime) {
          const existing = (globalThis as typeof globalThis & { ts?: TypeScriptRuntime }).ts;
          if (existing) runtime = existing;
          else {
            if (!message.typescriptUrl) throw new Error('E_TYPES_RUNTIME: missing TypeScript runtime URL');
            const module = await import(/* @vite-ignore */ message.typescriptUrl) as { default?: TypeScriptRuntime; ts?: TypeScriptRuntime };
            runtime = module.default ?? module.ts;
          }
        }
        if (!runtime?.createLanguageService) throw new Error('E_TYPES_RUNTIME: invalid TypeScript module');
        const next = createTypeSession(runtime, message.input);
        session?.dispose(); session = next;
        return session.check();
      }
      case 'dispose': session?.dispose(); session = undefined; return { disposed: true };
      case 'check': if (session) return session.check(); break;
      case 'completion': if (session) return session.complete(message.file, message.offset); break;
      case 'hover': if (session) return session.hover(message.file, message.offset); break;
    }
    throw new Error('E_TYPES_NOT_READY: load a frozen declaration graph first');
  }
  return (message: TypesWorkerRequest): Promise<{ id: string | number; ok: boolean; result?: unknown; error?: { code: string; message: string } }> => {
    const result = pending.then(() => execute(message)).then(result => ({ id: message.id, ok: true, result }), error => ({ id: message.id, ok: false, error: { code: String(error?.message ?? error).split(':')[0], message: String(error?.message ?? error) } }));
    pending = result;
    return result;
  };
}

const worker = globalThis as typeof globalThis & { document?: unknown; postMessage?: (value: unknown) => void; addEventListener?: (type: string, listener: (event: MessageEvent<TypesWorkerRequest>) => void) => void };
if (typeof worker.document === 'undefined' && typeof worker.postMessage === 'function' && typeof worker.addEventListener === 'function') {
  const handle = createTypesWorkerHandler();
  worker.addEventListener('message', event => { void handle(event.data).then(result => worker.postMessage!(result)); });
}
