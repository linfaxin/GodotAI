declare const require:(id:string)=>any;
const G=require('godot');
const call=(object:any,name:string,...args:any[])=>object[name](...args);
export default class IntegerNativeProbe extends G.Node {
 private report:any;
 private frames=0;
 _ready(){
  const checks:Record<string,boolean>={},details:Record<string,unknown>={},failures:any[]=[];
  const check=(name:string,fn:()=>boolean)=>{try{checks[name]=fn();}catch(error){checks[name]=false;failures.push({name,error:String(error),stack:(error as any)?.stack});}};
  check('packedInt64Boundaries',()=>{
   const values=[-(1n<<63n),-9007199254740993n,-9007199254740991n,-2147483649n,0n,2147483648n,9007199254740991n,9007199254740993n,(1n<<63n)-1n];
   const results=values.map(value=>{const array=new G.PackedInt64Array();call(array,'push_back',value);const actual=call(array,'get',0);return {expected:String(value),actual:String(actual),type:typeof actual,exact:BigInt(actual)===value,expectedType:value>9007199254740991n||value<-9007199254740991n?'bigint':'number'};});
   details.packedInt64Boundaries=results;return results.every(v=>v.exact&&v.type===v.expectedType);
  });
  check('nativeNegativeReturns',()=>{
   const results=['-9007199254740993','9007199254740993','-9223372036854775808','9223372036854775807'].map(text=>{const value=call(G,'str_to_var',text);return {expected:text,actual:String(value),type:typeof value,exact:BigInt(value)===BigInt(text)};});
   details.nativeNegativeReturns=results;return results.every(v=>v.exact&&v.type==='bigint');
  });
  check('resourceIdRoundtrip',()=>{
   const material=new G.StandardMaterial3D(),id=call(material,'get_instance_id'),same=call(G,'instance_from_id',id)===material;
   details.resourceId={decimal:String(id),type:typeof id,roundtrip:same};return same;
  });
  check('invalidIntegerInputsRejected',()=>{
   const values=[1n<<63n,-(1n<<63n)-1n,NaN,Infinity,-Infinity,9007199254740992,-9007199254740992];
   const results=values.map(value=>{const array=new G.PackedInt64Array();let rejected=false,error='';try{call(array,'push_back',value);}catch(caught){rejected=true;error=String(caught);}return {input:String(value),rejected,size:Number(call(array,'size')),error};});
   details.invalidInputs=results;return results.every(v=>v.rejected&&v.size===0);
  });
  check('safeFractionTruncationPreserved',()=>{
   const array=new G.PackedInt64Array();call(array,'push_back',3.75);call(array,'push_back',-3.75);const values=[call(array,'get',0),call(array,'get',1)];details.fractions=values;return values[0]===3&&values[1]===-3;
  });
  this.report={status:Object.values(checks).every(Boolean)?'passed':'failed',checks,details,failures};
 }
 _process(){if(++this.frames===3){console.log('P0_INTEGER_NATIVE_REPORT '+JSON.stringify(this.report));call(call(this,'get_tree'),'quit',this.report.status==='passed'?0:1);}}
}
