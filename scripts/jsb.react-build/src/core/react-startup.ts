import {runtimeModulePath as modulePath} from '@godot-js/project-tools/engine-project';
import {runtimeBindingBootstrap} from '@godot-js/project-tools/runtime-entry';
export function reactBootstrap(entry:string,exportName:string,props:Record<string,unknown>):string {
 return `const intrinsicStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
const G = require('godot');
const React = require(${JSON.stringify(modulePath('react'))});
const EngineReact = require(${JSON.stringify(modulePath('@godot-js/react/engine'))});
const names = require('godot-jsb').internal.names;
const call = (object: any, name: string, ...args: any[]) => object[names.get_member(name)](...args);
${runtimeBindingBootstrap()}
export default class PlaygroundEngineBootstrap extends G.Node {
 private root: any; private closingRoot: any; private entryScope: any; private host: any; private closed = false; private closing = false; private managed = false;
 _ready() {
  const binding = ensureRuntimeBinding();
  const admission = typeof binding?.closeProgress === 'function' ? binding.closeProgress() : undefined;
  if (admission && (admission.closing || admission.accepting === false)) { this.closed = true; return; }
  this.entryScope = typeof binding?.openEntry === 'function' ? binding.openEntry() : undefined;
  this.host = this.entryScope?.host ?? binding;
  try {
   const entry = require(${JSON.stringify(entry)});
   const Component = entry[${JSON.stringify(exportName)}] ?? (${JSON.stringify(exportName)} === 'default' && typeof entry === 'function' ? entry : undefined);
   if (Component === undefined) throw Error(${JSON.stringify(`React entry does not export "${exportName}"`)});
   this.root = EngineReact.createRoot(this, {autoProcess: false, entry:this.entryScope?.capability,runtimeHost:this.host,lifetime:this.entryScope?.lifetime, onError: (error: any, info: any) => this.report(error, info)});
   const root = this.root;
   this.managed = !!this.entryScope?.lifetime && typeof root.close === 'function';
   if (this.managed) {
    const runtimeManaged = root.runtimeManagedCleanup === true;
    this.entryScope.lifetime.onCancel(() => {
     this.closed = true; this.closing = true; this.closingRoot = root; this.root = undefined;
     if (!runtimeManaged) root.requestShutdown();
    });
    if (runtimeManaged) {
     this.entryScope.onCleanupTick(() => { if (!['open','pending'].includes(root.getCloseProgress().status)) this.finishClosing(); });
     this.entryScope.onNativeSeal(() => this.finishClosing());
    } else {
     this.entryScope.onCleanupTick(() => root.session.drainClose());
     this.entryScope.onNativeSeal(() => { root.sealClose(); this.finishClosing(); });
     this.entryScope.lifetime.defer(async () => {
      try {
       const result = await root.close();
       if (result.status !== 'complete') throw Error('React root cleanup ' + result.status);
      } finally { this.finishClosing(); }
     });
    }
   }
   this.entryScope?.ready(true);
   this.root.render(React.isValidElement(Component) ? Component : React.createElement(Component, ${JSON.stringify(props)}));
   this.root.flush();
  } catch (error) {
   this.entryScope?.ready(!!this.root);
   if (this.host) this.report(error, {kind:'runtime'});
   this.close('startup-failure');
   if (!this.host) throw error;
  }
 }
 _process(delta: number) { if (!this.entryScope?.lifetime?.cancelled && this.root) (this.root.processFrame ?? this.root.process).call(this.root,delta); }
 _physics_process(delta: number) { if (!this.entryScope?.lifetime?.cancelled && this.root) (this.root.physicsFrame ?? this.root.physics).call(this.root,delta); }
 _exit_tree() { this.close('bootstrap-exit'); }
 private finishClosing() { this.closing = false; this.closingRoot = undefined; }
 private report(error: any, info: any, cleanup = false) {
  if (this.closed && !this.closing) return;
  if (this.closed) {
   if (this.entryScope && !this.entryScope.canCleanup()) { this.finishClosing(); return; }
   if (!cleanup) {
    try { if (this.managed ? !['open','pending'].includes(this.closingRoot?.getCloseProgress().status) : this.closingRoot?.getStats().state === 'disposed') { this.finishClosing(); return; } }
    catch (_) { /* Failed inspection cannot certify that teardown completed. */ }
   }
  }
  const own = (name: string, limit: number) => { try { const d = error != null && (typeof error === 'object' || typeof error === 'function') ? Object.getOwnPropertyDescriptor(error,name) : undefined; const text = d && 'value' in d ? d.value : name === 'stack' && intrinsicStackGetter && d?.get === intrinsicStackGetter && ['message','name'].every(key => { const field = Object.getOwnPropertyDescriptor(error,key); return !field || 'value' in field; }) ? intrinsicStackGetter.call(error) : undefined; return typeof text === 'string' ? text.slice(0,limit) : undefined; } catch (_) { return undefined; } };
  const payload = {kind:info?.kind ?? 'runtime',message:typeof error === 'string' ? error.slice(0,4096) : own('message',4096) ?? 'React callback failed',stack:typeof info?.stack === 'string' ? info.stack.slice(0,32768) : own('stack',32768),componentStack:typeof info?.componentStack === 'string' ? info.componentStack.slice(0,8192) : undefined};
  let handled = false;
  try {
   if (this.closed && this.entryScope) { this.entryScope.reportCleanupFailure({...payload,kind:'runtime'}); handled = true; }
   else if (typeof this.host?.reportDiagnostic === 'function') handled = this.host.reportDiagnostic(payload) === true;
   else if (call(G[names.get_class('OS')], 'has_feature', 'web')) {
    const window = call(G[names.get_class('JavaScriptBridge')], 'get_interface', 'window');
    handled = call(window, 'call', '__godotjsReportReactError', JSON.stringify(payload)) === true;
   }
  } catch (_) { /* Standalone native previews keep local error output. */ }
  if (!handled) (payload.kind === 'caught' || payload.kind === 'recoverable' ? console.warn : console.error)(payload.message + '\\n' + (payload.stack ?? ''));
  if (payload.kind === 'uncaught' || payload.kind === 'runtime') this.close('react-failure');
 }
 private close(reason: string) {
  if (this.closed) return;
  this.closed = true; this.closing = true; this.entryScope?.close();
  const root = this.root; this.root = undefined; this.closingRoot = root;
  if (this.managed) { if (!root?.runtimeManagedCleanup) root?.requestShutdown(); return; }
  if (!root) { this.entryScope?.cleanupComplete(); this.finishClosing(); return; }
  if (this.entryScope && !this.entryScope.canCleanup()) { this.entryScope.cleanupUnconfirmed(); this.finishClosing(); return; }
  try {
   root.shutdown(reason);
   const assess = () => {
    if (!this.closing) return;
    if (this.entryScope && !this.entryScope.canCleanup()) { this.entryScope.cleanupUnconfirmed(); this.finishClosing(); return; }
    const stats = root.getStats();
    if (!stats.cleanExit) this.entryScope?.reportCleanupFailure({kind:'runtime',message:'React root cleanup failed'});
    else if (stats.state === 'disposed') this.entryScope?.cleanupComplete();
    else this.entryScope?.cleanupUnconfirmed();
    if (stats.state === 'disposed') this.finishClosing();
   };
   assess();
   // A physics barrier can defer shutdown beyond this first checkpoint. Keep
   // its reporter until real disposal or native epoch seal revokes the lease.
   void Promise.resolve().then(assess).catch((error: any) => this.report(error,{kind:'runtime'},true));
  } catch (error) { this.report(error,{kind:'runtime'},true); }
 }
}
`;
}
