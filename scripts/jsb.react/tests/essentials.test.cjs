const test=require('node:test'),assert=require('node:assert/strict'),React=require('react'),SDK=require('../dist');
const {MockNativePort}=require('../dist/testing'),{SHOWCASE_HOST_SCHEMA:s,validateHostProps,validateValue}=require('../dist/schema');
const context={profileId:'showcase-v1'};
test('derived hosts keep Control focus and dimension-correct transform commands',()=>{
 for(const h of Object.values(s)){
  if(h.properties.customMinimumSize)for(const name of Object.keys(s.Control.commands))assert.ok(h.commands[name],h.type+'.'+name);
  const d=h.properties.position?.codec==='vector3'?3:h.properties.position?.codec==='vector2'&&h.properties.rotation?2:0;
  if(d)for(const field of ['Position','Rotation','Scale']){if(h.properties[field.toLowerCase()]?.aliases.some(alias=>h.intrinsicEngineOwned.includes(alias)))continue;const command=h.commands['set'+field+(d===3?'3D':'')];assert.ok(command,h.type+'.set'+field);if(/^(?:AnimatableBody|StaticBody|RigidBody|CharacterBody)/.test(h.type))assert.equal(command.phase,'physics');else assert.ok(['process','physics'].includes(command.phase));}
 }
});
test('processing gates inherited disabled subtrees, resumes them, and still forwards releases',()=>{
 const port=new MockNativePort(),root=SDK.createRoot(port,port.createContainer(),{generation:'processing',...context});let process=0,physics=0,presses=0,releases=0,always=0;
 function Child(){const ref=SDK.useNodeRef();SDK.useProcess(ref,{},()=>{process++;});SDK.usePhysicsProcess(ref,{},()=>{physics++;});SDK.useInput(ref,(_c,e)=>{if(e.pressed)presses++;else releases++;});return React.createElement(SDK.Node2D,{ref});}
 function Always(){const ref=SDK.useNodeRef();SDK.useProcess(ref,{},()=>{always++;});return React.createElement(SDK.Node2D,{ref,processMode:3});}
 function App({mode}){return React.createElement(SDK.Node,{processMode:mode},React.createElement(Child),React.createElement(Always));}
 try{root.render(React.createElement(App,{mode:4}));root.pump();root.process(.016);root.physics(.016);root.input({pressed:true});root.input({pressed:false});assert.deepEqual({process,physics,presses,releases,always},{process:0,physics:0,presses:0,releases:1,always:1});root.render(React.createElement(App,{mode:0}));root.pump();root.process(.016);root.physics(.016);assert.equal(process,1);assert.equal(physics,1);assert.equal(always,2);}finally{root.shutdown();}
});
test('new container layout remains native-owned and focus paths remain local',()=>{
 for(const parentType of ['CenterContainer','AspectRatioContainer'])assert.throws(()=>validateHostProps('Button',{layout:{offsets:[0,0,20,20]}},{...context,parentType}),/E_PROPERTY_OWNER_CONFLICT/);
 for(const path of ['/root/Other','../Other:script','../../../../../../../../../../../../../../../../../Other'])assert.throws(()=>validateHostProps('Button',{focusNext:path},context),/E_PROPERTY_VALUE/);
 assert.doesNotThrow(()=>validateHostProps('Button',{focusNext:'../Other',icon:{kind:'asset',id:'icon',type:'Texture2D'}},context));
});
test('display bounds, atlas frames and particle curve ranges reject invalid configurations',()=>{
 assert.throws(()=>validateValue('aabb',{position:{x:0,y:0,z:0},size:{x:-1,y:1,z:1}}),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateHostProps('Sprite3D',{hframes:2,vframes:1,frame:2},context),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateHostProps('CPUParticles3D',{linearAccelMin:2,linearAccelMax:1},context),/E_PROPERTY_VALUE/);
 assert.doesNotThrow(()=>validateHostProps('Label3D',{text:'Hello',billboard:1,fontSize:24},context));
});
