const test=require('node:test');const assert=require('node:assert/strict');const React=require('react');
const SDK=require('../dist');const {MockNativePort}=require('../dist/testing');const {validateValue,getHostSchema,validateHostProps}=require('../dist/schema');
test('world hosts remain opt-in and integer cell codecs reject truncation and overflow',()=>{
 for(const type of ['AnimatedSprite2D','AnimatedSprite3D','AnimationPlayer','TileMapLayer','GridMap','NavigationRegion2D','NavigationRegion3D','NavigationAgent2D','NavigationAgent3D']){assert.ok(SDK[type]);assert.throws(()=>getHostSchema(type),/E_/);validateHostProps(type,{}, {profileId:'showcase-v1'});}
 assert.throws(()=>validateHostProps('AnimationPlayer',{rootNode:'../../outside'},{profileId:'showcase-v1'}),/E_PROPERTY_VALUE/);
 assert.deepEqual(validateValue('vector3i',{x:-2,y:0,z:5}),{x:-2,y:0,z:5});for(const v of [{x:1.5,y:0},{x:2147483648,y:0},{x:0,y:0,z:1}])assert.throws(()=>validateValue('vector2i',v),/E_/);assert.throws(()=>validateValue('vector2iArray',[{x:0,y:NaN}]),/E_/);
});
test('tile commands enforce phase, effects and integer wire coordinates',()=>{
 const port=new MockNativePort(),root=SDK.createRoot(port,port.createContainer(),{generation:'tiles',profileId:'showcase-v1'});let count=0;
 port.command=(key,name,args)=>{assert.equal(name,'set_cell');assert.deepEqual(args,[{kind:'Vector2i',x:-1,y:2},0,{kind:'Vector2i',x:0,y:0},0]);count++;};
 function App(){const ref=SDK.useNodeRef();SDK.useProcess(ref,{writes:['cells']},c=>c.command('setCell',{x:-1,y:2},0,{x:0,y:0},0));SDK.usePhysicsProcess(ref,{},c=>assert.throws(()=>c.command('clear'),/E_COMMAND_UNSUPPORTED/));return React.createElement(SDK.TileMapLayer,{ref,engineOwned:['cells']});}
 try{root.render(React.createElement(App));root.process(.016);root.physics(.016);assert.equal(count,1);}finally{root.shutdown();}
});
test('animation library arguments resolve registered assets to native identities',async()=>{
 const port=new MockNativePort();port.assets.set('res://library.tres',{});const root=SDK.createRoot(port,port.createContainer(),{generation:'animation',profileId:'showcase-v1',assets:{library:{uri:'res://library.tres',type:'AnimationLibrary'}}});let called=false;
 port.command=(_key,name,args)=>{assert.equal(name,'add_animation_library');assert.deepEqual(args,['',{kind:'asset',id:'res://library.tres',type:'AnimationLibrary',scope:'shared'}]);called=true;return 0;};
 function App(){const library=SDK.useAsset(SDK.asset('library','AnimationLibrary')),ref=SDK.useNodeRef();SDK.useProcess(ref,{writes:['animationLibraries']},c=>c.command('addLibrary','',library));return React.createElement(SDK.AnimationPlayer,{ref,engineOwned:['animationLibraries']});}
 try{root.preloadAssets(["library"]);root.pump();root.render(React.createElement(React.Suspense,{fallback:null},React.createElement(App)));for(let i=0;i<8;i++){root.pump();await Promise.resolve();}root.process(.016);assert.equal(called,true);}finally{root.shutdown();}
});

test('sprite construction installs frames, selects animation, then applies frame and progress',()=>{
 const {orderedPropertyNames}=require('../dist/schema');for(const type of ['AnimatedSprite2D','AnimatedSprite3D']){const order=orderedPropertyNames(type,'showcase-v1');assert.ok(order.indexOf('spriteFrames')<order.indexOf('animation'));assert.ok(order.indexOf('animation')<order.indexOf('frame'));assert.ok(order.indexOf('frame')<order.indexOf('frameProgress'));}
});
