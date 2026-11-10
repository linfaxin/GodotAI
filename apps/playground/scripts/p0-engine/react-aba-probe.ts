// No React imports: minimal native-wrapper lifetime / ABA regression probe.
declare const require:(id:string)=>any;
const G=require('godot');
const call=(o:any,n:string,...args:any[])=>{const fn=o[n]??o[n.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())];return fn.apply(o,args);};
const alive=(o:any)=>{try{return !!G.is_instance_valid(o);}catch{return false;}};
export default class P0NativeAbaProbe extends G.Node {
 _ready(){const allocated:any[]=[];try{
  const old=new G.Node2D();call(old,'set_name','OldObject');const originalId=String(call(old,'get_instance_id'));call(old,'free');const validAfterFree=alive(old);let violation:any;
  for(let index=0;index<128;index++){
   const fresh=new G.Node2D();allocated.push(fresh);call(fresh,'set_name','Fresh_'+index);
   if(alive(old)){
    const freshId=String(call(fresh,'get_instance_id')),staleId=String(call(old,'get_instance_id')),freshName=String(call(fresh,'get_name'));call(old,'set_name','WRITTEN_VIA_STALE_REF');
    violation={index,originalId,freshId,staleId,oldAndFreshSameJsReference:old===fresh,freshNameBefore:freshName,freshNameAfter:String(call(fresh,'get_name')),staleWriteAffectedFresh:String(call(fresh,'get_name'))==='WRITTEN_VIA_STALE_REF'};break;
   }
  }
  const report={status:validAfterFree||violation?'failed':'passed',validAfterFree,reproduced:!!violation,allocationAttempts:allocated.length,violation};
  console.log('P0_REACT_ABA_REPORT '+JSON.stringify(report));for(const fresh of allocated)if(alive(fresh))call(fresh,'free');call(call(this,'get_tree'),'quit',report.status==='passed'?0:1);
 }catch(error){console.log('P0_REACT_ABA_REPORT '+JSON.stringify({status:'failed',error:String(error),stack:(error as any)?.stack}));for(const fresh of allocated)if(alive(fresh))call(fresh,'free');call(call(this,'get_tree'),'quit',1);}}
}
