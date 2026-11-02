import { RUNTIME_ABI, NATIVE_BRIDGE_ABI } from "@godot-js/react/contracts";

/** Stable genuine NativeScript. The generation is captured once when the root enters the tree. */
export function bootstrapSource(entryId: string, generatedDir: string): string {
  return `declare const require:(id:string)=>any;
const G=require("godot");
const reportError=(marker:string,error:any)=>{const message=String(error),stack=typeof error?.stack==="string"?error.stack:"";const raw=stack.startsWith(message)?stack:message+(stack?"\\n"+stack:"");let text=raw;try{const format=require("godot-jsb").internal.react?.formatStack;if(typeof format==="function")text=format(raw);}catch{}console.error(marker,text);};
const invoke=(o:any,n:string,...a:any[])=>{const c=n.replace(/_([a-z])/g,(_:string,x:string)=>x.toUpperCase());const f=o[n]??o[c];if(typeof f!=="function")throw Error("Missing Godot method "+n);return f.apply(o,a);};
const packedArray=(value:any):any[]=>{if(Array.isArray(value))return value.slice();if(value&&typeof value.size==="function"){const length=Number(invoke(value,"size"));if(!Number.isSafeInteger(length)||length<0||length>100000)throw Error("E_PACKED_ARRAY_LENGTH");const result:any[]=[];for(let i=0;i<length;i++)result.push(invoke(value,"get_indexed",i));return result;}return Array.from(value??[]);};
export default class ReactApplication extends G.Node {
 private controller:any;private report:any;private verify=false;private verified=false;
 private bridge:any;private opened:any;private cap:any;private quitting=false;
 private business=false;private verifier:any;private businessStarted=false;private businessDone=false;private businessResult:any;
 _enter_tree(){try{
  const read=(p:string)=>invoke(G.FileAccess,"get_file_as_string",p);
  const active=JSON.parse(read(${JSON.stringify(`res://${generatedDir}/active.json`)}));
  if(active.schemaVersion!==1||active.state!=="READY")throw Error("E_BUILD_NOT_READY");
  const manifest=JSON.parse(read(active.manifestPath));
  if(invoke(G.FileAccess,"get_sha256",active.manifestPath)!==active.manifestSha256||manifest.generation!==active.generation)throw Error("E_MANIFEST_HASH");
  if(String(invoke(this,"get_meta","_react_generation"))!==active.generation)throw Error("E_GENERATION_MISMATCH");
  if(manifest.runtimeAbi!==${JSON.stringify(RUNTIME_ABI)}||manifest.nativeBridgeAbi!==${JSON.stringify(NATIVE_BRIDGE_ABI)})throw Error("E_RUNTIME_ABI");
  const rootInstance=${JSON.stringify(entryId)}+":"+Date.now()+":"+String(invoke(this,"get_instance_id"));
  this.bridge=require("godot-jsb").internal.react;this.opened=this.bridge.openRoot(this,${JSON.stringify(entryId)},rootInstance,active.generation);this.cap=this.opened.cap;
  for(const m of [...Object.values(manifest.modules),...Object.values(manifest.nativeScripts)] as any[]){const uri=m.uri??m.output;if(invoke(G.FileAccess,"get_sha256",uri)!==m.sha256)throw Error("E_ARTIFACT_HASH "+uri);}
  const entry=manifest.entries[${JSON.stringify(entryId)}];const vendor=require(manifest.modules.runtime.uri);const module=require(manifest.modules[entry.module].uri);
  const args=packedArray(invoke(G.OS,"get_cmdline_user_args"));this.verify=args.includes("--godot-react-verify");this.business=args.includes("--godot-react-business-verify");
  this.controller=vendor.godot.startApplication(this,{entryId:${JSON.stringify(entryId)},rootInstance,generation:manifest.generation,runtimeAbi:manifest.runtimeAbi,nativeBridgeAbi:manifest.nativeBridgeAbi,mode:manifest.mode,manifest},module[entry.exportName],JSON.parse(String(invoke(this,"get_meta","_react_props","{}"))),{nativeOpenedRoot:this.opened,onBoot:(r:any)=>{this.report=r;console.log("GODOT_REACT_BOOT_REPORT "+JSON.stringify(r));},onError:(e:any)=>reportError("GODOT_REACT_RUNTIME_ERROR",e)});this.opened=undefined;
  if(this.business){if(!manifest.modules.verification)throw Error("E_BUSINESS_VERIFIER_MISSING");const v=require(manifest.modules.verification.uri);if(typeof v.start!=="function")throw Error("E_BUSINESS_VERIFIER_EXPORT");this.verifier=()=>v.start(this.controller,module);}
 }catch(e){reportError("GODOT_REACT_BOOT_FAILED",e);this.quit(1);}}
 _process(dt:number){try{
  this.controller?.pump(dt);this.controller?.process(dt);
  if(this.controller?.root.state==="faulted")throw Error("E_ROOT_FAULTED");
  if(this.business&&this.report&&!this.businessStarted){this.businessStarted=true;Promise.resolve(this.verifier()).then((result:any)=>{this.businessResult=result??null;this.businessDone=true;},(e:any)=>{reportError("GODOT_REACT_RUNTIME_FAILED",e);this.quit(1);});}
  if(this.businessDone&&!this.verified){this.verified=true;console.log("GODOT_REACT_BUSINESS_VERIFIED "+JSON.stringify({entryId:this.report.entryId,generation:this.report.generation,result:this.businessResult}));this.controller.shutdown("business-verify");this.quit(0);}
  else if(this.verify&&this.report&&!this.verified){this.verified=true;const ok=this.report.layoutPublished>0&&this.report.treeAudit.matches&&this.report.unexpectedErrors.length===0&&this.report.startupAssets.failures.length===0&&this.report.startupAssets.requested.length===this.report.startupAssets.ready.length;this.controller.shutdown("verify");this.quit(ok?0:1);}
  else if(this.controller?.root.state==="disposed")this.quit(0);
 }catch(e){reportError("GODOT_REACT_RUNTIME_FAILED",e);this.quit(1);}}
 _physics_process(dt:number){try{this.controller?.physics(dt);}catch(e){reportError("GODOT_REACT_RUNTIME_FAILED",e);this.quit(1);}}
 _input(event:any){try{this.controller?.input(event);}catch(e){reportError("GODOT_REACT_RUNTIME_FAILED",e);this.quit(1);}}
 _exit_tree(){try{this.controller?.shutdown("launcher-exit");}catch(e){reportError("GODOT_REACT_CLEANUP_FAILED",e);this.forceClose();}this.closeOpened();}
 private forceClose(){if(this.cap!==undefined){const cap=this.cap;try{this.bridge.quiesceRoot(cap);}catch(e){reportError("GODOT_REACT_CLEANUP_FAILED",e);}try{this.bridge.beginStage(cap,"cleanup");}catch(e){reportError("GODOT_REACT_CLEANUP_FAILED",e);}try{this.bridge.closeRoot(cap,true);}catch(e){reportError("GODOT_REACT_CLEANUP_FAILED",e);}finally{try{this.bridge.endStage(cap);}catch(e){reportError("GODOT_REACT_CLEANUP_FAILED",e);}}this.cap=undefined;this.opened=undefined;}}
 private closeOpened(){if(this.opened){try{this.bridge.quiesceRoot(this.opened.cap);this.bridge.closeRoot(this.opened.cap);this.opened=undefined;this.cap=undefined;}catch(e){reportError("GODOT_REACT_CLEANUP_FAILED",e);this.forceClose();}}}
 private quit(code:number){if(this.quitting)return;this.quitting=true;try{this.controller?.shutdown("launcher-exit");}catch(e){reportError("GODOT_REACT_CLEANUP_FAILED",e);code=1;this.forceClose();}this.closeOpened();const tree=invoke(this,"get_tree");if(tree)invoke(tree,"quit",code);}
}
`;
}
