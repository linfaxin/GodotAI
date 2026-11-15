'use strict';

// Real engine-worker regression cases. The browser harness delays only the
// final-message packets, so native reaping runs before their owner receives them.
exports.startupSource = `const {JSWorkerParent}=require('godot.worker');
JSWorkerParent.postMessage({kind:'p1-close-final',sequence:0,startup:true});
JSWorkerParent.close();`;

exports.messageSource = `const G=require('godot'),{JSWorkerParent}=require('godot.worker');
JSWorkerParent.onmessage=data=>{
 if(data.mode==='cancel'){
  JSWorkerParent.postMessage({kind:'p1-close-final',cancelled:true});
  JSWorkerParent.postMessage({kind:'p1-close-ack'});
 }else{
  JSWorkerParent.postMessage({kind:'p1-close-final',sequence:1,plain:'final result'});
  JSWorkerParent.postMessage({kind:'p1-close-final',sequence:2,vector:new G.Vector2(7,8),bytes:new Uint8Array([4,5,6])});
  const node=new G.Node();node.set_name('P1_final_node');
  JSWorkerParent.postMessage({kind:'p1-close-final',sequence:3,node},[node]);
 }
 JSWorkerParent.close();
};`;

exports.run = function run(G) {
  const {JSWorker}=require('godot.worker');
  const state={done:false,passed:false,startupFinal:false,ordered:[],variant:false,typedArray:false,nativeNode:false,ownerTerminationDropsLate:false,successorFinal:false,errors:[]};
  const workers=[];
  let phase='startup',frames=0,cancelAt=0,disposed=false;
  function assert(value,message){if(!value)throw Error('P1_WORKER_CLOSE '+message);}
  function guarded(body){return function(data){try{body(data);}catch(error){state.errors.push(String(error&&error.stack||error));state.done=true;state.passed=false;}};}
  function worker(path){const value=new JSWorker(path);workers.push(value);return value;}
  function startSequence(){
    phase='sequence';
    const value=worker('src/p1-close-message.worker');
    value.onready=()=>value.postMessage({mode:'sequence'});
    value.onmessage=guarded(data=>{
      assert(data.kind==='p1-close-final'&&data.sequence===state.ordered.length+1,'messages retain send order');
      state.ordered.push(data.sequence);
      if(data.sequence===1)assert(data.plain==='final result','plain final payload survives close');
      if(data.sequence===2){state.variant=data.vector instanceof G.Vector2&&data.vector.x===7&&data.vector.y===8;state.typedArray=data.bytes instanceof Uint8Array&&data.bytes.join(',')==='4,5,6';assert(state.variant&&state.typedArray,'Variant and typed-array payloads survive close');}
      if(data.sequence===3){
        state.nativeNode=G.is_instance_valid(data.node)&&data.node.get_name()==='P1_final_node';assert(state.nativeNode,'transferred native Node survives sender disposal');data.node.free();
        startCancellation();
      }
    });
  }
  function startCancellation(){
    phase='cancellation';
    const value=worker('src/p1-close-message.worker');
    value.onready=()=>value.postMessage({mode:'cancel'});
    value.onmessage=guarded(data=>{
      assert(data.kind==='p1-close-ack','owner termination must suppress the delayed result');
      // The child has posted its delayed result before this acknowledgement.
      // terminate() must override an already requested self-close.
      value.terminate();cancelAt=Date.now();
    });
  }
  const initial=worker('src/p1-close-startup.worker');
  initial.onmessage=guarded(data=>{assert(data.startup===true&&data.sequence===0,'top-level post then close is delivered');state.startupFinal=true;startSequence();});
  return {
    process(){
      frames++;
      if(disposed||state.done)return;
      if(phase==='cancellation'&&cancelAt&&Date.now()-cancelAt>900){
        state.ownerTerminationDropsLate=true;phase='successor';
        const next=worker('src/p1-close-startup.worker');
        next.onmessage=guarded(data=>{assert(data.startup===true&&data.sequence===0,'a fresh worker still receives only its own final message');state.successorFinal=true;state.done=true;state.passed=state.errors.length===0;});
      }
      if(frames>1200&&!state.done){state.errors.push('P1_WORKER_CLOSE timed out in '+phase);state.done=true;}
    },
    results(){return {...state,ordered:state.ordered.slice(),errors:state.errors.slice()};},
    dispose(){disposed=true;for(const value of workers)value.terminate();}
  };
};
