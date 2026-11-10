const test=require('node:test');const assert=require('node:assert/strict');const React=require('react');const SDK=require('../dist');const {MockNativePort}=require('../dist/testing');const schema=require('../dist/schema');
const context={profileId:'showcase-v1'};
test('skeleton and native scene values are opt-in, exact, finite DTOs',()=>{
 for(const type of ['Skeleton3D','BoneAttachment3D','AnimationTree']){assert.ok(SDK[type]);assert.throws(()=>schema.getHostSchema(type),/E_HOST_UNSUPPORTED/);schema.validateHostProps(type,{},context);}
 const q=schema.validateValue('quaternion',{x:0,y:0,z:0,w:5});assert.deepEqual(q,{x:0,y:0,z:0,w:1});assert.throws(()=>schema.validateValue('quaternion',{x:0,y:0,z:0,w:0}),/E_PROPERTY_VALUE/);
 assert.throws(()=>schema.validateValue('transform3d',{origin:{x:0,y:0,z:0},basis:{x:{x:Infinity,y:0,z:0},y:{x:0,y:1,z:0},z:{x:0,y:0,z:1}}}),/E_PROPERTY_VALUE/);
 assert.throws(()=>schema.validateHostProps('BoneAttachment3D',{position:{x:1,y:0,z:0}},context),/E_PROPERTY_OWNER_CONFLICT/);
 assert.throws(()=>schema.validateHostProps('Node3D',{packedScene:SDK.asset('bad','Mesh')},context),/E_PROPERTY_VALUE/);
});
test('native scene command facades require frame ownership and expire on dispatch/Stop',()=>{
 const port=new MockNativePort(),root=SDK.createRoot(port,port.createContainer(),{generation:'native-scenes',...context});let expired,count=0;
 port.command=(_key,name,args)=>{assert.equal(name,'__react_scene_play');assert.deepEqual(args,['AnimationPlayer','Wave',-1,1,false]);count++;};
 function App(){const ref=SDK.useNodeRef();SDK.useProcess(ref,{writes:['prefabPlayback']},c=>{expired=c;c.command('playSceneAnimation','AnimationPlayer','Wave',-1,1,false);});SDK.usePhysicsProcess(ref,{},c=>assert.throws(()=>c.command('listSceneNodes'),/E_COMMAND_UNSUPPORTED/));return React.createElement(SDK.NativeScene,{ref,scene:null,engineOwned:['prefabPlayback']});}
 try{root.render(React.createElement(App));root.process(.016);root.physics(.016);assert.equal(count,1);assert.throws(()=>expired.command('listSceneNodes'),/E_STALE_COMMAND/);}finally{root.shutdown();}
 assert.throws(()=>expired.command('playSceneAnimation','AnimationPlayer','Wave',-1,1,false),/E_STALE_COMMAND/);assert.equal(port.liveCount(),1);
});
test('declarative library/profile ownership rejects simultaneous imperative writers',()=>{
 assert.throws(()=>schema.validateHostProps('Skeleton3D',{profile:SDK.asset('rig','SkeletonProfile'),engineOwned:['bones']},context),/E_PROPERTY_OWNER_CONFLICT/);
 assert.throws(()=>schema.validateHostProps('AnimationPlayer',{library:SDK.asset('clips','AnimationLibrary'),engineOwned:['animationLibraries']},context),/E_PROPERTY_OWNER_CONFLICT/);
 schema.validateHostProps('Skeleton3D',{initial:{profile:SDK.asset('rig','SkeletonProfile')},engineOwned:['bones']},context);
});
