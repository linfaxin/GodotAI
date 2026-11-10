const test=require('node:test'),assert=require('node:assert/strict'),React=require('react'),SDK=require('../dist');
const {MockNativePort}=require('../dist/testing'),{validateHostProps,validateValue}=require('../dist/schema');
const context={profileId:'showcase-v1'};
test('Control layouts preserve authored edges while explicit position/size remain available',()=>{
 const port=new MockNativePort(),root=SDK.createRoot(port,port.createContainer(),{generation:'layout-edges',...context});
 try{root.render(React.createElement(SDK.Control,{layout:{offsets:[20,30,120,80]}}));root.pump();const key=root.getHostGraph()[0].key,calls=port.calls.filter(c=>c.op==='set'&&c.key.slot===key.slot).map(c=>c.value.name);assert.ok(calls.includes('__react_layout'));assert.ok(!calls.includes('position'));assert.ok(!calls.includes('size'));root.render(React.createElement(SDK.Control,{position:{x:8,y:9},size:{x:20,y:30}}));root.pump();assert.deepEqual(port.read(key,'position'),{x:8,y:9});assert.deepEqual(port.read(key,'size'),{x:20,y:30});}finally{root.shutdown();}
});
test('layout tween plans only address bounded UI properties and require native-owned output groups',()=>{
 assert.throws(()=>validateValue('layoutTweenPlan',{steps:[{property:'script',to:1,duration:1}]}),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateValue('layoutTweenPlan',{steps:[{property:'scale',to:{x:0,y:1},duration:1}]}),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateValue('layoutTweenPlan',{steps:[{property:'position',to:{x:1,y:1},duration:0}],loops:0}),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateHostProps('Control',{rotation:.5,engineOwned:['uiTransform']},context),/E_PROPERTY_OWNER_CONFLICT/);
 assert.throws(()=>validateHostProps('Control',{position:{x:1,y:1}},{...context,parentType:'CenterContainer'}),/E_PROPERTY_OWNER_CONFLICT/);
 assert.throws(()=>validateHostProps('Camera3D',{position:{x:0,y:0,z:4}},{...context,parentType:'SpringArm3D'}),/E_PROPERTY_OWNER_CONFLICT/);
});
test('textured buttons preserve grouped state ownership and GPU hosts reject unsupported/oversized emission',()=>{
 const group={kind:'asset',id:'group',type:'ButtonGroup'};assert.doesNotThrow(()=>validateHostProps('TextureButton',{buttonGroup:group,initial:{toggleMode:true},engineOwned:['button.state']},context));
 assert.throws(()=>validateHostProps('TextureButton',{buttonGroup:group,toggleMode:true,engineOwned:['button.state']},context),/E_PROPERTY_OWNER_CONFLICT/);
 assert.throws(()=>validateHostProps('GPUParticles3D',{amount:16385},context),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateHostProps('GPUParticles2D',{trailsEnabled:true},context),/E_PROPERTY_UNSUPPORTED/);
 assert.throws(()=>validateHostProps('GPUParticles3D',{processMaterial:{kind:'asset',id:'shader',type:'ShaderMaterial'}},context),/E_PROPERTY_VALUE/);
});

test('textured progress bars validate and quantize the complete native range',()=>{
 assert.throws(()=>validateHostProps('TextureProgressBar',{minValue:20,maxValue:10,value:15},context),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateHostProps('TextureProgressBar',{maxValue:10,value:11},context),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateHostProps('TextureProgressBar',{step:1e-12},context),/E_PROPERTY_VALUE/);
 const value=validateHostProps('TextureProgressBar',{minValue:0,maxValue:10,step:.5,value:3.6},context);assert.equal(value.controlled.value,3.5);
});
