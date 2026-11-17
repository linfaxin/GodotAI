import { RUNTIME_ABI, ENGINE_NATIVE_ABI } from "@godot-js/react/contracts";
import { runtimeBindingBootstrap } from "@godot-js/project-tools/runtime-entry";

/** Stable NativeScript. The sealed generation is captured before business modules load. */
export function bootstrapSource(entryId: string, generatedDir: string): string {
  return `declare const require:(id:string)=>any;
const G=require("godot");
const intrinsicStackGetter=Object.getOwnPropertyDescriptor(new Error(),"stack")?.get;
const failureDescription=(error:any)=>{const own=(name:string,limit:number)=>{try{const d=error!=null&&(typeof error==="object"||typeof error==="function")?Object.getOwnPropertyDescriptor(error,name):undefined;const value=d&&"value"in d?d.value:name==="stack"&&intrinsicStackGetter&&d?.get===intrinsicStackGetter&&["message","name"].every(key=>{const field=Object.getOwnPropertyDescriptor(error,key);return !field||"value"in field;})?intrinsicStackGetter.call(error):undefined;return typeof value==="string"?value.slice(0,limit):undefined;}catch{return undefined;}};return {message:(typeof error==="string"?error.slice(0,4096):own("message",4096))??"Native application failed",stack:own("stack",32768)};};
const reportError=(marker:string,error:any)=>{const {message,stack=""}=failureDescription(error);const raw=stack.startsWith(message)?stack:message+(stack?"\\n"+stack:"");let text=raw;try{const format=require("godot-jsb").internal.format_stack;if(typeof format==="function")text=format(raw);}catch{}console.error(marker,text);};
const invoke=(o:any,n:string,...a:any[])=>{const c=n.replace(/_([a-z])/g,(_:string,x:string)=>x.toUpperCase());const f=o[n]??o[c];if(typeof f!=="function")throw Error("Missing Godot method "+n);return f.apply(o,a);};
const packedArray=(value:any):any[]=>{if(Array.isArray(value))return value.slice();if(value&&typeof value.size==="function"){const length=Number(invoke(value,"size"));if(!Number.isSafeInteger(length)||length<0||length>100000)throw Error("E_PACKED_ARRAY_LENGTH");const result:any[]=[];for(let i=0;i<length;i++)result.push(invoke(value,"get_indexed",i));return result;}return Array.from(value??[]);};
${runtimeBindingBootstrap()}
export default class ReactApplication extends G.Node {
 private controller:any;private report:any;private verify=false;private verified=false;
 private entryScope:any;private services:any;private vendor:any;private lease:any;private leases:any;
 private quitting=false;private exitCode=0;private ticks=0;private manifest:any;private rootInstance="";
 private business=false;private verifier:any;private businessStarted=false;private businessDone=false;private businessResult:any;
 _enter_tree(){try{
  const read=(p:string)=>invoke(G.FileAccess,"get_file_as_string",p);
  const active=JSON.parse(read(${JSON.stringify(`res://${generatedDir}/active.json`)}));
  if(active.schemaVersion!==1||active.state!=="READY")throw Error("E_BUILD_NOT_READY");
  const manifest=JSON.parse(read(active.manifestPath));this.manifest=manifest;
  if(invoke(G.FileAccess,"get_sha256",active.manifestPath)!==active.manifestSha256||manifest.generation!==active.generation)throw Error("E_MANIFEST_HASH");
  if(String(invoke(this,"get_meta","_react_generation"))!==active.generation)throw Error("E_GENERATION_MISMATCH");
  if(manifest.runtimeAbi!==${JSON.stringify(RUNTIME_ABI)}||manifest.nativeBridgeAbi!==${JSON.stringify(ENGINE_NATIVE_ABI)})throw Error("E_RUNTIME_ABI");
  this.rootInstance=${JSON.stringify(entryId)}+":"+Date.now()+":"+String(invoke(this,"get_instance_id"));
  this.leases=require("godot-jsb").internal.engine_run_lease;
  if(!this.leases||typeof this.leases.open!=="function")throw Error("E_ENGINE_LEASE_ABI");
  this.lease=this.leases.open(this,${JSON.stringify(entryId)},this.rootInstance,active.generation);
  const binding=ensureRuntimeBinding();if(!binding||typeof binding.openEntry!=="function")throw Error("E_ENGINE_ENTRY_ABI");
  this.entryScope=binding.openEntry();
  // Register before createRoot: reverse cleanup order releases native nodes before the reader lease.
  this.entryScope.lifetime.defer(()=>this.releaseLease());
  for(const m of [...Object.values(manifest.modules),...Object.values(manifest.nativeScripts)] as any[]){const uri=m.uri??m.output;if(invoke(G.FileAccess,"get_sha256",uri)!==m.sha256)throw Error("E_ARTIFACT_HASH "+uri);}
  const entry=manifest.entries[${JSON.stringify(entryId)}];this.vendor=require(manifest.modules.runtime.uri);const module=require(manifest.modules[entry.module].uri);
  const Component=module[entry.exportName];if(typeof Component!=="function"&&!this.vendor.React.isValidElement(Component))throw Error("E_ENTRY_EXPORT");
  const args=packedArray(invoke(G.OS,"get_cmdline_user_args"));this.verify=args.includes("--godot-react-verify");this.business=args.includes("--godot-react-business-verify");
  const root=this.vendor.engineReact.createRoot(this,{godot:G,autoProcess:false,strictMode:manifest.mode==="development",entry:this.entryScope.capability,onError:(e:any,info:any)=>{reportError("GODOT_REACT_RUNTIME_ERROR",e);this.entryScope?.host.reportDiagnostic({kind:info?.kind??"runtime",...failureDescription(e),stack:info?.stack});if(info?.kind==="runtime"||info?.kind==="uncaught")this.quit(1);}});
  this.services=this.vendor.engineComponents.configureEngineComponents(root,{profileId:manifest.profile.id,mode:manifest.mode,assets:manifest.resources,nativeScriptProfiles:manifest.nativeScriptProfiles});
  const render=(props:any)=>{root.render(this.vendor.React.createElement(Component,props));root.flush();};
  this.controller={root,services:this.services,mode:manifest.mode,pump:()=>root.pump(),process:(dt:number)=>root.processFrame(dt),physics:(dt:number)=>root.physicsFrame(dt),input:(event:any,unhandled=false)=>this.vendor.engineComponents.dispatchEngineInput(root,event,unhandled),render,shutdown:()=>root.shutdown()};
  this.services.preloadAssets(entry.startupAssets??[]);render(JSON.parse(String(invoke(this,"get_meta","_react_props","{}"))));this.entryScope.finishStartup();
  if(this.business){if(!manifest.modules.verification)throw Error("E_BUSINESS_VERIFIER_MISSING");const v=require(manifest.modules.verification.uri);if(typeof v.start!=="function")throw Error("E_BUSINESS_VERIFIER_EXPORT");this.verifier=()=>v.start(this.controller,module);}
 }catch(e){reportError("GODOT_REACT_BOOT_FAILED",e);try{this.entryScope?.finishStartup();}catch{}this.quit(1);}}
 _process(dt:number){try{
  if(this.quitting){this.controller?.root.session.drainClose();return;}
  if(this.lease!==undefined&&this.leases.shutdownRequested(this.lease)){this.quit(0);return;}
  this.controller?.pump(dt);this.controller?.process(dt);
  const root=this.controller?.root,stats=root?.getStats();if(stats?.state==="faulted")throw Error("E_ROOT_FAULTED");
  if(!this.report&&stats&&++this.ticks>=2&&stats.commits>0&&!root.hasPending()){
   root.session.runSafe(()=>root.audit());const current=root.getStats(),assets=this.services.assetStatus();
   this.report={schemaVersion:1,kind:"sdk-boot-verification-v1",scope:"framework-boot-smoke",entryId:${JSON.stringify(entryId)},generation:this.manifest.generation,rootInstance:this.rootInstance,runtimeAbi:this.manifest.runtimeAbi,nativeBridgeAbi:this.manifest.nativeBridgeAbi,profile:this.manifest.profile.id,layoutPublished:current.commits,treeAudit:{matches:current.invalidations===0&&current.orphaned===0&&root.getErrors().length===0,businessNodes:current.publishedRecords},startupAssets:assets,unexpectedErrors:root.getErrors().map(String)};
   console.log("GODOT_REACT_BOOT_REPORT "+JSON.stringify(this.report));
  }
  if(this.business&&this.report&&!this.businessStarted){this.businessStarted=true;Promise.resolve().then(()=>this.verifier()).then((result:any)=>{this.businessResult=result??null;this.businessDone=true;},(e:any)=>{reportError("GODOT_REACT_RUNTIME_FAILED",e);this.quit(1);});}
  if(this.businessDone&&!this.verified){this.verified=true;console.log("GODOT_REACT_BUSINESS_VERIFIED "+JSON.stringify({entryId:this.report.entryId,generation:this.report.generation,result:this.businessResult}));this.quit(0);}
  else if(this.verify&&this.report&&!this.verified){this.verified=true;const ok=this.report.layoutPublished>0&&this.report.treeAudit.matches&&this.report.unexpectedErrors.length===0&&this.report.startupAssets.failures.length===0&&this.report.startupAssets.requested.length===this.report.startupAssets.ready.length;this.quit(ok?0:1);}
  else if(stats?.state==="disposed"&&!this.business)this.quit(0);
 }catch(e){reportError("GODOT_REACT_RUNTIME_FAILED",e);this.quit(1);}}
 _physics_process(dt:number){if(this.quitting)return;try{this.controller?.physics(dt);}catch(e){reportError("GODOT_REACT_RUNTIME_FAILED",e);this.quit(1);}}
 _input(event:any){if(this.quitting)return;try{this.controller?.input(event);}catch(e){reportError("GODOT_REACT_RUNTIME_FAILED",e);this.quit(1);}}
 _unhandled_input(event:any){if(this.quitting)return;try{this.controller?.input(event,true);}catch(e){reportError("GODOT_REACT_RUNTIME_FAILED",e);this.quit(1);}}
 _exit_tree(){this.entryScope?.close();if(!this.entryScope)this.releaseLease();}
 private releaseLease(){if(this.lease!==undefined){const lease=this.lease;this.lease=undefined;this.leases.close(lease);}}
 private finishQuit(){this.releaseLease();const tree=invoke(this,"get_tree");if(tree)invoke(tree,"quit",this.exitCode);}
 private quit(code:number){if(this.quitting){if(code)this.exitCode=code;return;}this.quitting=true;this.exitCode=code;this.entryScope?.close();
  const root=this.controller?.root;if(!root){this.finishQuit();return;}
  try{root.requestShutdown();void root.close().then((result:any)=>{if(result.status!=="complete"){reportError("GODOT_REACT_CLEANUP_FAILED",Error("E_ENGINE_CLEANUP "+result.status));this.exitCode=1;}this.finishQuit();},(error:any)=>{reportError("GODOT_REACT_CLEANUP_FAILED",error);this.exitCode=1;this.finishQuit();});}catch(e){reportError("GODOT_REACT_CLEANUP_FAILED",e);this.exitCode=1;root.sealClose();this.finishQuit();}
 }
}
`;
}
