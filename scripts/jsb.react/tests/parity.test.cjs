const test=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const SDK=require('../dist');
const {MockNativePort}=require('../dist/testing');
const {validateHostProps,validateValue}=require('../dist/schema');
const context={profileId:'showcase-v1'};
test('TabContainer owns child visibility and containers own child layout',()=>{
 assert.throws(()=>validateHostProps('Label',{visible:true},{...context,parentType:'TabContainer'}),/E_PROPERTY_OWNER_CONFLICT/);
 assert.throws(()=>validateHostProps('Label',{layout:{offsets:[0,0,80,40]}},{...context,parentType:'VBoxContainer'}),/E_PROPERTY_OWNER_CONFLICT/);
 assert.doesNotThrow(()=>validateHostProps('Label',{}, {...context,parentType:'TabContainer'}));
 const props=validateHostProps('Control',{layout:{anchors:[0,0,1,1],offsets:[10,20,-10,-20]}},context);
 assert.deepEqual(props.controlled.layout,[0,0,1,1,10,20,-10,-20]);
});
test('stepped controls normalize requested values and reject unstable precision',()=>{
 for(const type of ['HSlider','SpinBox']){
  assert.equal(validateHostProps(type,{minValue:0,maxValue:10,step:.25,value:3.6},context).controlled.value,3.5);
  assert.equal(validateHostProps(type,{initial:{value:3.6},step:.25},context).baseline.value,3.5);
  assert.equal(validateHostProps(type,{minValue:-1,maxValue:1,step:.1,value:-.75},context).controlled.value,-.7);
  assert.throws(()=>validateHostProps(type,{step:1e-12},context),/E_PROPERTY_VALUE/);
 }
});
test('dropping a controlled range value restores its baseline on the current native step grid',()=>{
 const port=new MockNativePort(),root=SDK.createRoot(port,port.createContainer(),{generation:'step-reset',...context});let handle;const props={ref:r=>handle=r,initial:{value:3.6},step:.25,value:5};
 try{root.render(React.createElement(SDK.SpinBox,props));root.render(React.createElement(SDK.SpinBox,{...props,step:1,value:undefined}));assert.equal(port.read(handle.nativeKey,'value'),4);}finally{root.shutdown();}
});
test('modifier changes release held combos; rebinding preserves physical state; touch and radial deadzones work',()=>{
 const a=SDK.createInputActions({combo:{bindings:[{key:74,ctrl:true,exactModifiers:true}]},touch:{bindings:[{touch:2}]},left:{bindings:[]},right:{deadzone:.2,bindings:[{axis:0}]},up:{bindings:[]},down:{bindings:[{axis:1}]}});
 a.feed({type:'InputEventKey',physical_keycode:74,pressed:true,ctrl_pressed:true});assert.ok(a.isPressed('combo'));
 a.feed({type:'InputEventKey',physical_keycode:4194326,pressed:false,ctrl_pressed:false});assert.equal(a.isPressed('combo'),false);
 a.setBindings('combo',[{key:74}]);assert.ok(a.isPressed('combo'));
 a.setBindings('combo',[{key:75}]);assert.equal(a.isPressed('combo'),false);
 a.feed({type:'InputEventScreenTouch',index:2,pressed:true});assert.ok(a.isPressed('touch'));
 a.feed({type:'InputEventScreenTouch',index:2,pressed:false});assert.equal(a.isPressed('touch'),false);
 a.feed({type:'InputEventJoypadMotion',axis:0,axis_value:.3});a.feed({type:'InputEventJoypadMotion',axis:1,axis_value:.4});
 const v=a.getVector('left','right','up','down',.2);assert.ok(Math.abs(v.x-.225)<1e-12);assert.ok(Math.abs(v.y-.3)<1e-12);
 a.feed({type:'InputReset'});assert.deepEqual(a.getVector('left','right','up','down'),{x:0,y:0});a.dispose();
});
test('advanced queries reject forged exclusions and encode only live managed handles',()=>{
 assert.throws(()=>validateValue('rayQuery2',{from:{x:0,y:0},to:{x:1,y:1},exclude:[{kind:'NodeId',key:{}}]}),/E_NODE_CAPABILITY/);
 assert.throws(()=>validateValue('rayQuery3',{from:{x:0,y:0,z:0},to:{x:1,y:1,z:1},collisionMask:-1}),/E_PROPERTY_VALUE/);
 const port=new MockNativePort(),root=SDK.createRoot(port,port.createContainer(),{generation:'queries',...context});let handle,result;
 function App(){const ref=SDK.useNodeRef();SDK.usePhysicsProcess(ref,{},c=>{result=c.command('queryRay',{from:{x:0,y:0},to:{x:1,y:1},exclude:[handle]});});return React.createElement(SDK.Node2D,{ref},React.createElement(SDK.StaticBody2D,{ref:r=>handle=r}));}
 port.command=(_key,name,args)=>{assert.equal(name,'__react_space_ray2');assert.equal(args[0][7][0].kind,'NodeId');assert.deepEqual(args[0][7][0].key,handle.nativeKey);return [];};
 root.render(React.createElement(App));const saved=handle;root.physics(.016);assert.deepEqual(result,[]);root.shutdown();
 assert.throws(()=>validateValue('rayQuery2',{from:{x:0,y:0},to:{x:1,y:1},exclude:[saved]}),/E_NATIVE_LOST/);
});
