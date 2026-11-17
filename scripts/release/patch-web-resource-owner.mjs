/** Resource creation hooks for the pinned Godot 4.6.1 Web libraries. */
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export const HOST_RESOURCE_PATCH='godotjs-host-resource-owner-v1';
const layouts={
 'platform/web/js/libs/library_godot_os.js':{hashes:['e2b5d7ef96c55a6d3a3803af87a16429c382e97968ec1b5f57c917a63b3e2b23'],edits:[
  ['\t\t\t\t// Always deferred.\n\t\t\t\tsetTimeout(function () {\n\t\t\t\t\tcallback();\n\t\t\t\t}, 0);',`\t\t\t\t// Native FS/audio retirement remains available during cleanup-only.
\t\t\t\tconst schedule = Module['godotjsScheduleCleanup'];
\t\t\t\tif (typeof schedule === 'function') schedule(callback);
\t\t\t\telse setTimeout(callback, 0);`],
 ]},
 'platform/web/js/patches/patch_em_gl.js':{hashes:['eae6f72f5dfe03e5c0fcf81393f28f9d62af0bdb6bc0f91f969b20b45eadbd10'],edits:[
  ['\t// GODOTJS_SHADER_UTF8_DECODER_V1',`\t// GODOTJS_SHADER_UTF8_DECODER_V1
\t// This GL factory belongs to this Module; browser constructors stay intact.
\tconst godotjsCreateContext = GL.createContext;
\tGL.createContext = function (canvas, attributes) {
\t\tconst handle = godotjsCreateContext.call(GL, canvas, attributes);
\t\tconst context = handle && GL.getContext(handle);
\t\tconst own = Module['godotjsOwnResource'];
\t\tif (context && typeof own === 'function' && own('gl', context.GLctx) !== true) {
\t\t\tGL.deleteContext(handle);
\t\t\treturn 0;
\t\t}
\t\treturn handle;
\t};`],
 ]},
 'platform/web/js/libs/library_godot_runtime.js':{hashes:['721798319a8c0965f063df46e7fd106973b1fbeb12bd79e9ea9b0e9362e4a1ce'],edits:[
  ['const GodotRuntime = {','const GodotRuntime = {\n\t$GodotRuntime__postset: "Module[\'godotjsHostResourceAbi\'] = 1;",'],
  ['\t$GodotRuntime: {',`\t$GodotRuntime: {
\t\town_resource: function (kind, value) {
\t\t\tconst own = Module['godotjsOwnResource'];
\t\t\treturn typeof own !== 'function' || own(kind, value) === true;
\t\t},`],
 ]},
 'platform/web/js/libs/library_godot_audio.js':{hashes:['8ad61bdce01b1d3ce833608feafe73cd18961aa740c60b5d02d53607f9a7865b','72712504d22bc265376d894484bee27e30a83557bd4d9c8eb78ab08cdae554a7'],edits:[
  ['\t\t\tconst ctx = new (window.AudioContext || window.webkitAudioContext)(opts);',"\t\t\tconst ctx = new (window.AudioContext || window.webkitAudioContext)(opts);\n\t\t\tif (!GodotRuntime.own_resource('audio', ctx)) throw new Error('E_SESSION_DISPOSED');"],
  ['  this._playbackPosition = this.offset;',"  if (!GodotRuntime.own_resource('port', this._positionWorklet.port)) return;\n  this._playbackPosition = this.offset;"],
  ["   const node = new AudioWorkletNode(session.context, 'godot-processor', { outputChannelCount: [channels] });","   const node = new AudioWorkletNode(session.context, 'godot-processor', { outputChannelCount: [channels] });\n   if (!GodotRuntime.own_resource('port', node.port)) { node.disconnect(); return; }"],
  ['\t\t\tfunction gotMediaInput(stream) {',"\t\t\tfunction gotMediaInput(stream) {\n\t\t\t\tif (!GodotRuntime.own_resource('media', stream)) return;"],
 ]},
 'platform/web/js/libs/library_godot_display.js':{hashes:['0671fb02f58a32efdaddf6b2817bd23b9d3692f6156a4cb7c3117a957025d6b7'],edits:[
  ['\t\t\tconst gl = GL.getContext(gl_context_handle);',"\t\t\tconst gl = GL.getContext(gl_context_handle);\n\t\t\tif (gl && !GodotRuntime.own_resource('gl', gl.GLctx)) return;"],
 ]},
 'modules/websocket/library_godot_websocket.js':{hashes:['33d1523d2eed0b14d9e731dc20fe86b88a2a6febe409ff8e5b587a53168bedb8'],edits:[
  ["\t\tsocket.binaryType = 'arraybuffer';","\t\tif (!GodotRuntime.own_resource('network', socket)) return 0;\n\t\tsocket.binaryType = 'arraybuffer';"],
 ]},
 'modules/webrtc/library_godot_webrtc.js':{hashes:['c9321eb9398917f689f6a07b5265ca3b8b392e5080b81a6edd89d6084c948a6e','eb8af9e54fd43d1a956be826d018001baa84886bd70981f0c110ac3694100133'],edits:[
  ['\t\t\tconst id = IDHandler.add(conn);',"\t\t\tif (!GodotRuntime.own_resource('network', conn)) return 0;\n\t\t\tconst id = IDHandler.add(conn);"],
  ['\t\t\t\tconst cid = IDHandler.add(event.channel);',"\t\t\t\tif (!GodotRuntime.own_resource('network', event.channel)) return;\n\t\t\t\tconst cid = IDHandler.add(event.channel);"],
  ['\t\t\tconst channel = ref.createDataChannel(label, config);',"\t\t\tconst channel = ref.createDataChannel(label, config);\n\t\t\tif (!GodotRuntime.own_resource('network', channel)) return 0;"],
 ]},
};
export const HOST_RESOURCE_PATHS=Object.freeze(Object.keys(layouts));
export function unpatchHostResourceFile(path,source){
 const layout=layouts[path];if(!layout)return source;
 let code=source;
 if(!layout.edits.every(([,to])=>code.includes(to)))return source;
 for(const [from,to]of [...layout.edits].reverse())code=code.replace(to,from);
 if(!layout.hashes.includes(hash(code)))throw Error('E_HOST_RESOURCE_PATCH: modified '+path);
 return code;
}
export function patchHostResourceFile(path,source){
 const layout=layouts[path];if(!layout)throw Error('E_HOST_RESOURCE_PATCH: '+path);
 let before=source;
 if(!layout.hashes.includes(hash(before))){
  for(const [from,to] of [...layout.edits].reverse()){
   if(before.split(to).length!==2)throw Error('E_HOST_RESOURCE_PATCH: modified '+path);
   before=before.replace(to,from);
  }
  if(!layout.hashes.includes(hash(before)))throw Error('E_HOST_RESOURCE_PATCH: baseline '+path);
  return {code:source,changed:false,patchId:HOST_RESOURCE_PATCH};
 }
 let code=source;for(const [from,to] of layout.edits){if(code.split(from).length!==2)throw Error('E_HOST_RESOURCE_PATCH: anchor '+path);code=code.replace(from,to);}
 return {code,changed:true,patchId:HOST_RESOURCE_PATCH};
}
export function hostResourceBuildProof(records){
 const files={};for(const path of HOST_RESOURCE_PATHS){const edge=records.findLast(r=>r.path===path&&r.patchId===HOST_RESOURCE_PATCH);if(!edge?.implementation?.sha256)throw Error('E_HOST_RESOURCE_PROOF: '+path);files[path]={sha256:records.findLast(r=>r.path===path).afterSha256,implementation:edge.implementation};}
 return {hostResourceAbi:1,hostResourcePatch:{abi:1,patchId:HOST_RESOURCE_PATCH,files}};
}
