import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {patchWorkerXR} from '../../release/patch-web-worker-xr.mjs';

test('all 17 checked WebXR imports preserve native pointers, callback ownership and GL handle registration',async()=>{
 const upstream=await readFile(new URL('./fixtures/godot-4.6.1-webxr.js',import.meta.url),'utf8'),library={},heap=new Map(),strings=new Map(),functions=new Map(),freed=[],events=[];
 let pointer=4096,settings,callbacks,graphics,uninitialized=0,deleted=0,rate;
 const values=Array.from({length:16},(_,index)=>index+.5),input={target:values,targetRayMode:2,touchIndex:-1,grip:values,standardMapping:true,buttons:[.5,1],axes:[-.25,.75],handJoints:new Array(400).fill(.125),handRadii:new Array(25).fill(.01)};
 const gl={deleteTexture(){deleted++;}},scope={LibraryManager:{library},autoAddDeps(){},mergeInto:Object.assign,GL:{textures:[],getContext:()=>({GLctx:gl}),getNewId:table=>table.length},_emscripten_webgl_get_current_context:()=>1,
  MainLoop:{requestAnimationFrame(){},pause(){events.push('pause');},resume(){events.push('resume');}},runtimeKeepalivePush(){},runtimeKeepalivePop(){},window:{setTimeout(callback){callback();}},
  GodotRuntime:{parseString:value=>strings.get(value),get_func:key=>functions.get(key),allocString(value){const key=pointer;pointer+=128;strings.set(key,value);return key;},free(value){freed.push(value);},malloc(bytes){const key=pointer;pointer+=bytes;return key;},setHeapValue(address,value,type){heap.set(address,{value,type});}},
  __godotWorkerXR:{active:true,isSupported:()=>true,isSessionSupported(mode,callback){assert.equal(mode,'immersive-ar');callback(true);},initialize(...args){[settings,callbacks,graphics]=args;},uninitialize(){uninitialized++;},requestAnimationFrame(callback){events.push(callback);},
   getViewCount:()=>2,getRenderTargetSize:()=>[16,8],getTransformForView:()=>values,getProjectionForView:()=>values,getColorTexture:()=>7,getDepthTexture:()=>8,getVelocityTexture:()=>0,getInputSource:()=>input,getVisibilityState:()=> 'visible',getBoundsGeometry:()=>[0,0,0,1,0,0,0,0,1],getFrameRate:()=>90,updateTargetFrameRate:value=>{rate=value;},getSupportedFrameRates:()=>[72,90]},
 };
 const context=vm.createContext(scope);vm.runInContext(patchWorkerXR(upstream).code,context);vm.runInContext('Object.assign(GodotWebXR,GodotWebXR.$GodotWebXR)',context);
 const text=value=>{const key=pointer;pointer+=128;strings.set(key,value);return key;};
 assert.equal(library.godot_webxr_is_supported(),1);
 functions.set(1,(mode,supported)=>events.push([strings.get(mode),supported]));library.godot_webxr_is_session_supported(text('immersive-ar'),1);assert.deepEqual(events.pop(),['immersive-ar',1]);
 functions.set(2,(...pointers)=>events.push(pointers.map(value=>strings.get(value))));functions.set(3,()=>events.push('ended'));functions.set(4,message=>events.push(strings.get(message)));functions.set(5,(type,id)=>events.push([type,id]));functions.set(6,message=>events.push(strings.get(message)));
 library.godot_webxr_initialize(text('immersive-ar'),text('local-floor'),text('hand-tracking, layers'),text('local,viewer'),2,3,4,5,6);
 assert.equal(settings.mode,'immersive-ar');assert.deepEqual(Array.from(settings.optionalFeatures),['hand-tracking','layers']);assert.deepEqual(Array.from(settings.referenceSpaces),['local','viewer']);
 const before=freed.length;callbacks.started('local','hand-tracking','opaque');assert.deepEqual(events.pop(),['local','hand-tracking','opaque']);assert.equal(freed.length-before,3);
 callbacks.failed('failure');assert.equal(events.pop(),'failure');callbacks.ended();assert.equal(events.pop(),'ended');callbacks.input(2,0);assert.deepEqual(events.pop(),[2,0]);callbacks.simple('reference_space_reset');assert.equal(events.pop(),'reference_space_reset');callbacks.wakeMainLoop();assert.deepEqual(events.splice(-2),['pause','resume']);
 const texture={},handle=graphics.registerTexture(texture);assert.equal(scope.GL.textures[handle],texture);graphics.releaseTexture(handle,texture);assert.equal(scope.GL.textures[handle],null);assert.equal(deleted,1);
 assert.equal(library.godot_webxr_get_view_count(),2);assert.equal(library.godot_webxr_get_render_target_size(100),true);assert.deepEqual([heap.get(100),heap.get(104)],[{value:16,type:'i32'},{value:8,type:'i32'}]);
 assert.equal(library.godot_webxr_get_transform_for_view(-1,200),true);assert.equal(library.godot_webxr_get_projection_for_view(1,300),true);for(let index=0;index<16;index++)assert.equal(heap.get(200+index*4).value,values[index]);
 assert.equal(library.godot_webxr_get_color_texture(),7);assert.equal(library.godot_webxr_get_depth_texture(),8);assert.equal(library.godot_webxr_get_velocity_texture(),0);
 const output=[10000,10100,10200,10300,10400,10500,10600,10700,10800,10900,11000,12000,14000];
 assert.equal(library.godot_webxr_update_input_source(0,...output),true);assert.equal(heap.get(output[1]).value,2);assert.equal(heap.get(output[2]).value,-1);assert.equal(heap.get(output[3]).value,1);assert.equal(heap.get(output[6]).value,2);assert.equal(heap.get(output[8]).value,2);assert.equal(heap.get(output[10]).value,1);assert.equal(heap.get(output[11]+399*4).value,.125);assert.equal(heap.get(output[12]+24*4).value,.01);
 const visibility=library.godot_webxr_get_visibility_state();assert.equal(strings.get(visibility),'visible');assert.equal(library.godot_webxr_get_bounds_geometry(500),3);const bounds=heap.get(500).value;assert.equal(heap.get(bounds+8*4).value,1);
 assert.equal(library.godot_webxr_get_frame_rate(),90);library.godot_webxr_update_target_frame_rate(72);assert.equal(rate,72);assert.equal(library.godot_webxr_get_supported_frame_rates(600),2);const rates=heap.get(600).value;assert.equal(heap.get(rates+4).value,90);
 const nativeRAF=()=>{};vm.runInContext('GodotWebXR.requestAnimationFrame',context)(nativeRAF);assert.equal(events.pop(),nativeRAF);
 library.godot_webxr_uninitialize();assert.equal(uninitialized,1);
 assert.equal(Object.keys(library).filter(name=>/^godot_webxr_\w+$/.test(name)&&!name.includes('__')).length,17);
});
