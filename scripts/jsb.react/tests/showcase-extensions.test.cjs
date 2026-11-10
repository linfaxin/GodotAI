const test=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const SDK=require('../dist');
const schema=require('../dist/schema');
const {MockNativePort}=require('../dist/testing');
const context={profileId:'showcase-v1'};

test('showcase exposes complete media and physics contracts without broadening core',()=>{
  for(const type of ['Area2D','Area3D','RigidBody2D','RayCast2D','Camera2D','AudioStreamPlayer2D','AudioStreamPlayer3D','OmniLight3D','SpotLight3D','CPUParticles2D','CPUParticles3D','Timer','LineEdit','HSlider','TextureRect','ProgressBar','CharacterBody2D']){
    assert.equal(typeof SDK[type],'object');
    assert.equal(schema.getHostSchema(type,context.profileId).nativeType,type);
    assert.throws(()=>schema.getHostSchema(type),/E_HOST_UNSUPPORTED/);
    schema.validateHostProps(type,{},context);
  }
  assert.equal(schema.getHostSchema('CharacterBody3D',context.profileId).commands.moveAndSlide.phase,'physics');
  for(const type of ['Node3D','MeshInstance3D','Camera3D','CharacterBody3D'])assert.deepEqual(schema.getHostSchema(type,context.profileId).commands.setPosition3D.arguments,['vector3']);
  assert.throws(()=>schema.validateHostProps('AudioStreamPlayer',{stream:SDK.asset('bad','CircleShape2D')},context),/E_PROPERTY_VALUE/);
  const props=schema.validateHostProps('CharacterBody3D',{upDirection:{x:0,y:5,z:0}},context);
  assert.deepEqual(props.controlled.upDirection,{x:0,y:1,z:0});
  for(const [type,props] of [['CharacterBody3D',{upDirection:{x:0,y:0,z:0}}],['Area3D',{collisionMask:-1}],['Timer',{waitTime:0}],['Camera2D',{zoom:{x:0,y:1}}],['CPUParticles3D',{amount:0}],['HSlider',{minValue:10,value:5}],['HSlider',{step:1e-12}]])assert.throws(()=>schema.validateHostProps(type,props,context),/E_PROPERTY_VALUE/);
});

test('Area signals resolve managed identities, cancel on retirement, and disconnect on Stop',()=>{
  const port=new MockNativePort(),container=port.createContainer();
  const root=SDK.createRoot(port,container,{generation:'area-events',...context});
  let body,area;const seen=[];
  try{
    root.render(React.createElement(SDK.Node,null,React.createElement(SDK.Area3D,{ref:r=>area=r,onBodyEntered:value=>seen.push(value)}),React.createElement(SDK.StaticBody3D,{ref:r=>body=r})));
    port.emit(area.nativeKey,'body_entered',{kind:'NodeId',key:body.nativeKey,type:'StaticBody3D'});
    root.pump();assert.equal(seen[0],body);assert.equal(seen[0].isValid(),true);
    port.emit(area.nativeKey,'body_entered',{kind:'NodeId',key:body.nativeKey,type:'StaticBody3D'});
    root.render(null);root.pump();assert.equal(seen.length,1);
  }finally{root.shutdown();}
  assert.equal(port.connectionCount(),0);assert.equal(port.liveCount(),1);
});

test('input controls restore controlled state and retain committed user updates',()=>{
  const port=new MockNativePort(),container=port.createContainer(),events=[];
  const root=SDK.createRoot(port,container,{generation:'controls',...context});
  let slider,line;
  function App(){const [text,setText]=React.useState('initial');return React.createElement(SDK.VBoxContainer,null,
    React.createElement(SDK.LineEdit,{ref:r=>line=r,text,onTextChanged:value=>{events.push(value);setText(value);}}),
    React.createElement(SDK.HSlider,{ref:r=>slider=r,value:25}));}
  try{
    root.render(React.createElement(App));
    port.beginStage('safe');port.set(line.nativeKey,'text','typed');port.set(slider.nativeKey,'value',70);port.endStage();
    port.emit(line.nativeKey,'text_changed','typed');port.emit(slider.nativeKey,'value_changed',70);root.pump();
    assert.equal(port.read(line.nativeKey,'text'),'typed');assert.equal(port.read(slider.nativeKey,'value'),25);assert.deepEqual(events,['typed']);
  }finally{root.shutdown();}
});

test('particle restart requires all effects, stays in process, and expires after dispatch',()=>{
  for(const full of [false,true]){
    const port=new MockNativePort(),container=port.createContainer();let calls=0,expired;
    port.command=(_key,name,args)=>{assert.equal(name,'restart');assert.deepEqual(args,[]);calls++;};
    const root=SDK.createRoot(port,container,{generation:'particles',...context});
    function App(){const ref=SDK.useNodeRef();SDK.useProcess(ref,{writes:full?['emitting','simulation']:['emitting']},c=>{expired=c;if(full)c.command('restart');else assert.throws(()=>c.command('restart'),/E_PROPERTY_OWNER_CONFLICT/);});SDK.usePhysicsProcess(ref,{},c=>assert.throws(()=>c.command('restart'),/E_COMMAND_UNSUPPORTED/));return React.createElement(SDK.CPUParticles2D,{ref,engineOwned:['emitting','simulation']});}
    try{root.render(React.createElement(App));root.process(.016);root.physics(.016);assert.equal(calls,full?1:0);assert.throws(()=>expired.command('restart'),/E_STALE_COMMAND/);}finally{root.shutdown();}
  }
});
