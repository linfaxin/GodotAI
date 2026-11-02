const ensure=(value:unknown,message:string):void=>{if(!value)throw Error(`Review regression: ${message}`);};
const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,30));
async function until(predicate:()=>unknown):Promise<void>{for(let turn=0;turn<200;turn++){if(predicate())return;await pause();}throw Error("Review regression timed out");}
export async function start(controller:any,module:any) {
  const r=module.review,s=r.state;
  await until(()=>s.actor&&s.process>0&&s.physics>0&&s.visible&&s.layer&&s.hud);
  const original=s.actor,baseline={process:s.process,physics:s.physics,input:s.input,parentRenders:s.parentRenders};
  r.changeActor(1);await until(()=>s.actor!==original&&s.process>baseline.process&&s.physics>baseline.physics);
  controller.input({pressed:true});ensure(s.input>baseline.input,"input did not rebind");
  ensure(s.parentRenders===baseline.parentRenders,"forwarding parent rendered during independent child replacement");
  ensure(s.cleanup.some((item:any)=>item.id===original.id&&item.valid),"old actor cleanup lost its live handle");
  const replacement=s.actor;
  r.changeActor(null);await until(()=>!replacement.isValid()&&s.cleanup.some((item:any)=>item.id===replacement.id));
  ensure(s.cleanup.find((item:any)=>item.id===replacement.id).valid,"removed actor cleanup ran after free");
  ensure(!replacement.isValid(),"removed actor was not physically released");
  r.changeActor(2);await until(()=>s.actor!==replacement&&s.actor.isValid());
  const visible=s.visible,hidden=s.hidden,layer=s.layer,hud=s.hud;
  r.blockScene();await until(()=>s.loading&&s.loading.isValid());
  for(const item of [visible,hidden,layer,hud])ensure(item.read("visible")===false,"Suspense left a native descendant visible");
  r.resolveScene();await until(()=>!s.loading);
  for(const item of [visible,layer,hud])ensure(item.read("visible")===true,"Suspense failed to restore visibility");
  ensure(hidden.read("visible")===false,"Suspense lost an initial visibility baseline");
  r.changeInitial("after");await until(()=>controller.root.options.mode!=="development"||controller.root.getDiagnostics().length>0);
  ensure(controller.root.getErrors().length===0,"runtime reported unexpected errors");
  return {refRebound:true,readyCleanupLive:true,suspenseDescendantsHidden:true,visibilityRestored:true,
    developmentDiagnostic:controller.root.options.mode==="development"?controller.root.getDiagnostics().length>0:"production-silent"};
}
