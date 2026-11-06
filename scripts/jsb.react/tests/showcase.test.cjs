const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const React=require('react');
const {createRoot,Node3D,ColorRect}=require('../dist');
const {MockNativePort}=require('../dist/testing');
const {SHOWCASE_SCHEMA_DESCRIPTOR,SHOWCASE_PROFILE_HASH,getProfileSchema,validateValue}=require('../dist/schema');
const {canonicalJson}=require('../dist/contracts');

test('showcase is opt-in and has a reproducible capability digest',()=>{
  assert.equal(createHash('sha256').update(canonicalJson(SHOWCASE_SCHEMA_DESCRIPTOR)).digest('hex'),SHOWCASE_PROFILE_HASH);
  assert.ok(!getProfileSchema().profile.hosts.includes('Node3D'));
  assert.ok(getProfileSchema('showcase-v1').profile.hosts.includes('CharacterBody3D'));
  assert.throws(()=>validateValue('vector3',{x:0,y:1,z:Infinity}),/E_/);
  assert.throws(()=>validateValue('vector3',{x:0,y:1}),/E_/);
  assert.throws(()=>validateValue('vector3',{x:0,y:1,z:0,w:1}),/E_/);
});
test('showcase resources and hosts retire before a second root is created',()=>{
  const port=new MockNativePort(),container=port.createContainer();
  for(let index=0;index<10;index++){
    const root=createRoot(port,container,{generation:'showcase-test',profileId:'showcase-v1',mode:'production'});
    root.render(React.createElement(Node3D,{name:'Scene'},React.createElement(ColorRect,{size:{x:100,y:100}})));
    for(let i=0;i<10;i++)root.pump(1/60);
    assert.equal(root.getErrors().length,0);
    assert.equal(root.getHostGraph().length,2);
    root.shutdown('switch-demo');
    assert.equal(port.liveCount(),1);
    assert.equal(port.connectionCount(),0);
  }
});
test('rigid-body forces require a physics frame and both velocity and wake ownership',()=>{
  const SDK=require('../dist');
  for(const full of [false,true]){
    const port=new MockNativePort(),container=port.createContainer();let applied=0,checked=0,expired;
    const original=port.command.bind(port);
    port.command=(key,name,args)=>{if(name==='apply_central_force'){applied++;assert.deepEqual(args,[{x:2,y:0,z:1}]);return;}return original(key,name,args);};
    const root=createRoot(port,container,{generation:'force-test',profileId:'showcase-v1',mode:'production'});
    function App(){
      const ref=SDK.useNodeRef();
      SDK.useProcess(ref,{},commands=>{assert.throws(()=>commands.command('applyCentralForce',{x:2,y:0,z:1}),/E_COMMAND_UNSUPPORTED/);checked++;});
      SDK.usePhysicsProcess(ref,{writes:full?['linearVelocity','sleeping']:['linearVelocity']},commands=>{
        expired=commands;
        if(full)commands.command('applyCentralForce',{x:2,y:0,z:1});
        else assert.throws(()=>commands.command('applyCentralForce',{x:2,y:0,z:1}),/E_PROPERTY_OWNER_CONFLICT/);
      });
      return React.createElement(SDK.RigidBody3D,{ref,engineOwned:['linearVelocity','sleeping']});
    }
    try{root.render(React.createElement(App));root.process(.016);root.physics(.016);assert.equal(checked,1);assert.equal(applied,full?1:0);assert.throws(()=>expired.command('applyCentralForce',{x:2,y:0,z:1}),/E_STALE_COMMAND/);}finally{root.shutdown();}
  }
});
