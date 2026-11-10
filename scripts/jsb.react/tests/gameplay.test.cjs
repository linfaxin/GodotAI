const test=require('node:test'),assert=require('node:assert/strict'),React=require('react'),SDK=require('../dist');
const {validateHostProps,validateValue}=require('../dist/schema'),{MockNativePort}=require('../dist/testing');
const context={profileId:'showcase-v1'};
test('ownership rejects codec aliases, container ColorRect geometry and overlapping layout declarations',()=>{
 for(const field of ['numberArray','rayQuery3','shapeQuery2','controlLayout'])assert.throws(()=>validateHostProps('Node3D',{engineOwned:[field]},context),/E_PROPERTY_OWNER_CONFLICT/);
 for(const props of [{position:{x:10,y:20}},{size:{x:80,y:40}},{layout:{offsets:[0,0,80,40]}}])assert.throws(()=>validateHostProps('ColorRect',props,{...context,parentType:'VBoxContainer'}),/E_PROPERTY_OWNER_CONFLICT/);
 assert.throws(()=>validateHostProps('ColorRect',{layout:{},size:{x:1,y:2}},context),/E_PROPERTY_OWNER_CONFLICT/);
 assert.throws(()=>validateHostProps('Control',{layout:{},engineOwned:['layout.size']},context),/E_PROPERTY_OWNER_CONFLICT/);
});
test('atlas frames, rects, simple polygons and per-surface resources have bounded contracts',()=>{
 assert.doesNotThrow(()=>validateHostProps('Sprite2D',{hframes:3,vframes:2,frame:5,regionRect:{position:{x:0,y:0},size:{x:32,y:32}}},context));
 assert.throws(()=>validateHostProps('Sprite2D',{hframes:3,frame:3},context),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateValue('rect2',{position:{x:0,y:0},size:{x:-1,y:4}}),/E_PROPERTY_VALUE/);
 for(const polygon of [[{x:0,y:0},{x:2,y:2},{x:0,y:2},{x:2,y:0}],[{x:0,y:0},{x:1,y:0},{x:2,y:0}]])assert.throws(()=>validateHostProps('Polygon2D',{polygon},context),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateHostProps('Polygon2D',{polygon:[{x:0,y:0},{x:2,y:0},{x:0,y:2}],uv:[{x:0,y:0}]},context),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateValue('materialArray',[SDK.asset('bad','Mesh')]),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateValue('materialArray',[{kind:'asset',id:'bad',type:'StandardMaterial3D',scope:'instance'}]),/E_PROPERTY_VALUE/);
 assert.equal(validateHostProps('ProgressBar',{minValue:-10,maxValue:10,step:.5,value:2.6},context).controlled.value,2.5);
});
test('unhandled actions ignore GUI-consumed presses and release safely through the raw channel',()=>{
 const port=new MockNativePort(),root=SDK.createRoot(port,port.createContainer(),{generation:'unhandled',...context});let actions,raw=0,unhandled=0;
 function App(){const ref=SDK.useNodeRef();actions=SDK.useInputActions(ref,{fire:{bindings:[{key:74}]}},{inputPhase:'unhandled'});SDK.useInput(ref,()=>raw++);SDK.useUnhandledInput(ref,()=>unhandled++);return React.createElement(SDK.Node2D,{ref});}
 try{root.render(React.createElement(App));root.input({type:'InputEventKey',physical_keycode:74,pressed:true});assert.equal(actions.isPressed('fire'),false);assert.equal(raw,1);assert.equal(unhandled,0);root.input({type:'InputEventKey',physical_keycode:74,pressed:true},'unhandled');assert.ok(actions.isPressed('fire'));root.input({type:'InputEventKey',physical_keycode:74,pressed:false});assert.equal(actions.isPressed('fire'),false);root.input({type:'InputReset'});assert.equal(unhandled,2);}finally{root.shutdown();}
});
test('interactive subviewports require native forwarding containers',()=>{
 assert.doesNotThrow(()=>validateHostProps('SubViewport',{guiDisableInput:false},{...context,parentType:'SubViewportContainer'}));
 assert.throws(()=>validateHostProps('SubViewport',{guiDisableInput:false},{...context,parentType:'Node'}),/E_PROPERTY_VALUE/);
});

test('surface material queries produce Root-scoped references usable on another mesh',()=>{
 const port=new MockNativePort(),root=SDK.createRoot(port,port.createContainer(),{generation:'surface-ref',...context});let returned,receiver;
 port.command=()=>({kind:'asset',id:'native-material',type:'StandardMaterial3D',scope:'shared'});
 function Source(){const ref=SDK.useNodeRef();SDK.useProcess(ref,{},c=>{returned=c.command('getSurfaceMaterial',0);});return React.createElement(SDK.MeshInstance3D,{ref});}
 try{root.render(React.createElement(Source));root.process(.016);root.render(React.createElement(React.Fragment,null,React.createElement(Source),React.createElement(SDK.MeshInstance3D,{ref:r=>receiver=r,surfaceMaterials:[returned]})));assert.equal(port.read(receiver.nativeKey,'__react_surface_materials')[0].id,'native-material');assert.equal(root.getErrors().length,0);}finally{root.shutdown();}
});
