import {runtimeModulePath as modulePath} from '@godot-js/project-tools/engine-project';
export function reactBootstrap(entry:string,exportName:string,props:Record<string,unknown>):string {
 return `const G = require('godot');
const React = require(${JSON.stringify(modulePath('react'))});
const EngineReact = require(${JSON.stringify(modulePath('@godot-js/react/engine'))});
const names = require('godot-jsb').internal.names;
const call = (object: any, name: string, ...args: any[]) => object[names.get_member(name)](...args);
export default class PlaygroundEngineBootstrap extends G.Node {
 private root: any;
 _ready() {
  try {
   const entry = require(${JSON.stringify(entry)});
   const Component = entry[${JSON.stringify(exportName)}] ?? (${JSON.stringify(exportName)} === 'default' && typeof entry === 'function' ? entry : undefined);
   if (Component === undefined) throw Error(${JSON.stringify(`React entry does not export "${exportName}"`)});
   this.root = EngineReact.createRoot(this, {autoProcess: false, onError: (error: any, info: any) => this.report(error, info)});
   this.root.render(React.isValidElement(Component) ? Component : React.createElement(Component, ${JSON.stringify(props)}));
   this.root.flush();
  } catch (error) {
   try { this.close('startup-failure'); } catch (cleanup) { console.error('React bootstrap cleanup failed', cleanup); }
   throw error;
  }
 }
 _process(delta: number) { this.root?.process(delta); }
 _physics_process(delta: number) { this.root?.physics(delta); }
 _exit_tree() { this.close('bootstrap-exit'); }
 private report(error: any, info: any) {
  let message = 'React callback failed';try { message = String(error); } catch (_) {}
  const payload = {kind:info?.kind ?? 'runtime',message:message.slice(0,4096),stack:(info?.stack ?? '').slice(0,32768),componentStack:(info?.componentStack ?? '').slice(0,8192)};
  let handled = false;
  try {
   const runtimeHost = (globalThis as any).__godotjsRuntimeHost;
   if (typeof runtimeHost?.reportDiagnostic === 'function') handled = runtimeHost.reportDiagnostic(payload) !== false;
   else if (call(G[names.get_class('OS')], 'has_feature', 'web')) {
    const window = call(G[names.get_class('JavaScriptBridge')], 'get_interface', 'window');
    handled = call(window, 'call', '__godotjsReportReactError', JSON.stringify(payload)) === true;
   }
  } catch (_) { /* Native hosts and standalone previews use their own console. */ }
  if (!handled) (payload.kind === 'caught' || payload.kind === 'recoverable' ? console.warn : console.error)(payload.message + '\\n' + payload.stack);
  if (payload.kind === 'uncaught' || payload.kind === 'runtime') this.close('react-failure');
 }
 private close(reason: string) { const root = this.root; this.root = undefined; root?.shutdown(reason); }
}
`;
}
