const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const {engineHostDomain:domain}=require('../dist/engine-host-domain');

function fixture(run){
 const previous=Module._load,calls=[],node={};let callback,available=true,owned=true;
 const api={abi:'godot-engine-host-operations/1',touch:scope=>calls.push(['touch',scope]),write:(scope,...args)=>calls.push(['write',scope,...args]),read:()=>42,invoke:()=>true,connect:(scope,_node,name,fn)=>{callback=fn;calls.push(['connect',scope,name]);return 1;},disconnect:()=>calls.push(['disconnect']),forget:()=>calls.push(['forget']),quiesceScope:()=>calls.push(['quiesce']),disposeScope:()=>calls.push(['dispose']),finalize:()=>calls.push(['finalize']),registerAsset:()=>calls.push(['asset'])};
 const root={session:{hasPermission:()=>true},nativeOperationContext:()=>({scope:{opaque:true},worldId:'native-world'}),nativeReadOperationContext:()=>({scope:{opaque:true},worldId:'native-world'}),nativeCleanupAvailable:()=>available,isNativeOwned:()=>owned};
 Module._load=function(name,...args){return name==='godot-jsb'?{internal:{native_host_operations:api}}:previous.call(this,name,...args);};
 try{run({root,node,calls,emit:(...args)=>callback?.(...args),seal:()=>{available=false;owned=false;}});}finally{Module._load=previous;}
}

test('host domain caches the opaque token without using JavaScript capability equality',()=>fixture(({root,node,calls})=>{
 const property={nativeName:'text',codec:'string'};
 assert.equal(domain.write(root,node,property,'first'),true);assert.equal(domain.write(root,node,property,'second'),true);
 assert.equal(calls.filter(([name])=>name==='touch').length,1);
 const writes=calls.filter(([name])=>name==='write');assert.equal(writes.length,2);assert.equal(writes[0][1],writes[1][1]);
 domain.afterCommit(root);assert.equal(calls.at(-1)[0],'finalize');domain.disposeRoot(root);assert.equal(calls.at(-1)[0],'dispose');
}));

test('facts-only sealing revokes signals and clears JS state without native entry',()=>fixture(({root,node,calls,emit,seal})=>{
 let delivered=0;const dispose=domain.connect(root,node,{nativeName:'pressed'},()=>delivered++);
 emit(7);assert.equal(delivered,1);const before=calls.length;
 seal();domain.disposeRoot(root);domain.disposeNode(root,node);dispose();emit(8);
 assert.equal(delivered,1);assert.equal(calls.length,before,'sealed cleanup must not touch native Objects, connections or scopes');
}));

test('quiescence cancels callbacks while preserving cleanup reads until logical disposal',()=>fixture(({root,node,calls,emit})=>{
 let delivered=0;domain.write(root,node,{nativeName:'text',codec:'string'},'value');domain.connect(root,node,{nativeName:'pressed'},()=>delivered++);emit();assert.equal(delivered,1);
 domain.quiesceRoot(root);const before=calls.length;emit();assert.equal(delivered,1);assert.equal(calls.at(-1)[0],'quiesce');
 assert.deepEqual(domain.read(root,node,{nativeName:'text',codec:'string'}),{value:42});assert.equal(calls.length,before);assert.throws(()=>domain.write(root,node,{nativeName:'text',codec:'string'},'forbidden'),/E_ENGINE_HOST_QUIESCING/);
 const bareNode={};assert.deepEqual(domain.read(root,bareNode,{nativeName:'name',codec:'string'}),{value:42});assert.equal(calls.length,before,'a first cleanup read must not issue a business TOUCH');
 domain.disposeNode(root,node);assert.equal(calls.at(-1)[0],'forget');domain.disposeRoot(root);assert.equal(calls.at(-1)[0],'dispose');
}));
