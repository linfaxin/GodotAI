/** Runtime services belong to one engine session, in the engine's JS realm. */
export interface RuntimeDiagnostic {
  kind: 'caught' | 'recoverable' | 'uncaught' | 'runtime';
  message: string;
  stack?: string;
  componentStack?: string;
}
export interface RuntimeHost {
  readonly sessionId: string;
  readonly role: 'host' | 'engine' | 'script-worker';
  reportDiagnostic(diagnostic: RuntimeDiagnostic): boolean;
  reportProgress?(frame: number, phase: string): void;
  emitProjectEvent?(data: Readonly<Record<string, unknown>>): void;
  assignRole?(role: 'host' | 'engine' | 'script-worker'): void;
  markProgress?(): void;
  projectEvent?(data: Readonly<Record<string, unknown>>): boolean;
  bindProjectCommand?(callback: ((json: string) => void) | null): void;
}
type RuntimeScope = { __godotjsRuntimeHost?: RuntimeHost };

/** Install before loading project code; an old disposer cannot remove a new host. */
export function installRuntimeHost(host: RuntimeHost, scope: RuntimeScope = globalThis as RuntimeScope): () => void {
  if (!host.sessionId || !['host', 'engine', 'script-worker'].includes(host.role) || typeof host.reportDiagnostic !== 'function') {
    throw new Error('E_RUNTIME_HOST: Invalid engine session host');
  }
  const previous = scope.__godotjsRuntimeHost;
  scope.__godotjsRuntimeHost = host;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (scope.__godotjsRuntimeHost !== host) return;
    if (previous) scope.__godotjsRuntimeHost = previous;
    else delete scope.__godotjsRuntimeHost;
  };
}

export function getRuntimeHost(scope: RuntimeScope = globalThis as RuntimeScope): RuntimeHost {
  const host = scope.__godotjsRuntimeHost;
  if (!host) throw new Error('E_RUNTIME_HOST: No engine session is installed');
  return host;
}
