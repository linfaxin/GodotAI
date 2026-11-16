/** Generated ordinary script entry. Framework-neutral and free of host imports. */
export function scriptBootstrap(module:string,exportName:string):string {
 return `const intrinsicStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
const G = require('godot');
export default class ProjectScriptBootstrap extends G.Node {
 private cleanup: any; private cleanupCalled = false; private closed = false;
 private entry: any; private host: any; private managed = false;
 private diagnostic(error: any) {
  const own = (name: string, limit: number) => { try { const d = error != null && (typeof error === 'object' || typeof error === 'function') ? Object.getOwnPropertyDescriptor(error, name) : undefined; const text = d && 'value' in d ? d.value : name === 'stack' && intrinsicStackGetter && d?.get === intrinsicStackGetter && ['message','name'].every(key => { const field = Object.getOwnPropertyDescriptor(error,key); return !field || 'value' in field; }) ? intrinsicStackGetter.call(error) : undefined; return typeof text === 'string' ? text.slice(0, limit) : undefined; } catch (_) { return undefined; } };
  return {kind:'runtime',message:(typeof error === 'string' ? error.slice(0,4096) : own('message',4096)) ?? 'Script entry failed',stack:own('stack',32768)};
 }
 private report(error: any, cleanup = false): boolean {
  if (!cleanup && this.closed) return true;
  const diagnostic = this.diagnostic(error);
  try {
   if (cleanup && this.entry) { this.entry.reportCleanupFailure(diagnostic); return true; }
   if (typeof this.host?.reportDiagnostic === 'function' && this.host.reportDiagnostic(diagnostic) === true) return true;
  } catch (_) {}
  console.error(error); return false;
 }
 private runCleanup(cleanup: any) {
  if (this.cleanupCalled) return;
  this.cleanupCalled = true;
  if (this.entry && !this.entry.canCleanup()) { this.entry.cleanupUnconfirmed(); return; }
  try {
   const result = cleanup();
   if (result && typeof result.then === 'function') {
    this.entry?.cleanupUnconfirmed();
    void Promise.resolve(result).catch((error: any) => this.report(error, true));
   } else this.entry?.cleanupComplete();
  } catch (error) { this.report(error, true); }
 }
 _ready() {
  const binding = (globalThis as any).__godotjsRuntimeHost;
  const admission = typeof binding?.closeProgress === 'function' ? binding.closeProgress() : undefined;
  if (admission && (admission.closing || admission.accepting === false)) { this.closed = true; return; }
  this.entry = typeof binding?.openEntry === 'function' ? binding.openEntry() : undefined;
  this.host = this.entry?.host ?? binding;
  this.managed = typeof this.entry?.finishStartup === 'function' && !!this.entry?.lifetime;
  const failed = (error: any, rethrow = false) => {
   if (this.managed) { try { this.entry.finishStartup(); } catch (_) { /* accept may already have settled startup. */ } }
   if (!this.report(error) && !this.closed && rethrow) throw error;
  };
  const accept = (cleanup: any) => {
   if (cleanup !== undefined && typeof cleanup !== 'function') throw Error('Script startup must return void or a cleanup function');
   if (this.managed) { this.entry.finishStartup(cleanup); return; }
   this.entry?.ready(typeof cleanup === 'function');
   if (this.closed) {
    if (cleanup) { if (this.entry && !this.entry.canCleanup()) this.entry.cleanupUnconfirmed(); else void Promise.resolve().then(() => this.runCleanup(cleanup)); }
   } else this.cleanup = cleanup;
  };
  try {
   const start = require(${JSON.stringify(module)})[${JSON.stringify(exportName)}];
   if (typeof start !== 'function') throw Error('Script entry must export a start function');
   const result = start({mount:this,godot:G,host:this.host,lifetime:this.entry?.lifetime});
   if (result && typeof result.then === 'function') void Promise.resolve(result).then(accept).catch((error: any) => failed(error));
   else accept(result);
  } catch (error) { failed(error, true); }
 }
 _exit_tree() {
  if (this.closed) return;
  this.closed = true; this.entry?.close();
  if (this.managed) return;
  const cleanup = this.cleanup; this.cleanup = undefined;
  if (cleanup) this.runCleanup(cleanup);
 }
}
`;
}
