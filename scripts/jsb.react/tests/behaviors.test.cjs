const test=require('node:test'),assert=require('node:assert/strict'),React=require('react'),SDK=require('../dist');
const {MockNativePort}=require('../dist/testing'),{validateHostProps,validateValue}=require('../dist/schema');
const context={profileId:'showcase-v1'};
test('3D convenience commands select native 3D signatures and velocity fields',()=>{
 for(const [type,phase,field,helper,expected,nativeProperty]of [['Node3D','process','transform3d','setPosition','set_position','position'],['CharacterBody3D','physics','velocity','setVelocity','set_velocity','velocity'],['RigidBody3D','physics','linearVelocity','setVelocity','set_linear_velocity','linear_velocity']]){
  const port=new MockNativePort(),root=SDK.createRoot(port,port.createContainer(),{generation:'dim-'+type,...context});let seen,handle;
  port.command=(key,name,args)=>{seen=name;port.set(key,nativeProperty,args[0]);};
  function App(){const ref=SDK.useNodeRef();(phase==='process'?SDK.useProcess:SDK.usePhysicsProcess)(ref,{writes:[field]},c=>c[helper]({x:1,y:2,z:3}));return React.createElement(SDK[type],{ref:r=>{ref.current=r;handle=r},engineOwned:[field]});}
  try{root.render(React.createElement(App));root[phase](.016);assert.equal(seen,expected);assert.deepEqual(helper==='setVelocity'?handle.readVelocity():handle.readPosition(),{x:1,y:2,z:3});}finally{root.shutdown();}
 }
});
test('ColorRect inherits all standard Control focus commands and signals',()=>{
 assert.doesNotThrow(()=>validateHostProps('ColorRect',{focusMode:2,onFocusEntered(){},onFocusExited(){}},context));
 const port=new MockNativePort(),root=SDK.createRoot(port,port.createContainer(),{generation:'focus-color',...context});let command;
 port.command=(_key,name)=>command=name;
 function App(){const ref=SDK.useNodeRef();SDK.useInput(ref,c=>c.command('grabFocus'),{writes:['focus']});return React.createElement(SDK.ColorRect,{ref,engineOwned:['focus']});}
 try{root.render(React.createElement(App));root.input({type:'test'});assert.equal(command,'grab_focus');}finally{root.shutdown();}
});
test('property Tweens are typed, bounded and use independent ownership groups',()=>{
 assert.throws(()=>validateValue('appearanceTweenPlan',{steps:[{property:'script',to:{r:1,g:1,b:1,a:1},duration:1}]}),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateValue('scalarTweenPlan',{steps:[{to:1,duration:0}],loops:0}),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateValue('appearanceTweenPlan',{steps:[{property:'modulate',to:{r:1,g:1,b:1,a:2},duration:1}]}),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateHostProps('ColorRect',{color:{r:1,g:1,b:1,a:1},engineOwned:['appearance']},context),/E_PROPERTY_OWNER_CONFLICT/);
 const port=new MockNativePort(),root=SDK.createRoot(port,port.createContainer(),{generation:'parallel-tweens',...context}),calls=[];port.command=(_key,name)=>calls.push(name);
 function App(){const ref=SDK.useNodeRef();SDK.useProcess(ref,{writes:['transform2d','appearance']},c=>{c.command('startTween',{steps:[{property:'position',to:{x:1,y:1},duration:1}]});c.command('startAppearanceTween',{steps:[{property:'modulate',to:{r:1,g:1,b:1,a:0},duration:1}]});});return React.createElement(SDK.Node2D,{ref,engineOwned:['transform2d','appearance']});}
 try{root.render(React.createElement(App));root.process(.016);assert.deepEqual(calls,['__react_tween_start','__react_behavior_appearance_start']);}finally{root.shutdown();}
});
test('shader values and particle emitters reject unsupported or inconsistent data',()=>{
 assert.throws(()=>validateValue('shaderValue',SDK.asset('viewport','ViewportTexture')),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateValue('nodeHandle',{kind:'NodeId',key:{}}),/E_NODE_CAPABILITY/);
 assert.throws(()=>validateHostProps('CPUParticles2D',{emissionShape:4},context),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateHostProps('CPUParticles3D',{emissionShape:5,emissionPoints:[{x:0,y:0,z:0}]},context),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateHostProps('CPUParticles3D',{emissionRingRadius:1,emissionRingInnerRadius:2},context),/E_PROPERTY_VALUE/);
});
