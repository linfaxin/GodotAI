/** Godot's shader patch references Emscripten's optional UTF8Decoder global.
 * PROXY_TO_PTHREAD deliberately uses TEXTDECODER=0, so own one decoder in the
 * post-run closure and retain the existing copy for SharedArrayBuffer views. */
import {createHash} from 'node:crypto';
export const SHADER_UTF8_PATCH='godotjs-shader-utf8-decoder-v1';
export const SHADER_UTF8_SOURCE_SHA256='2b740dcfb23623ca015d57a0260c9821aacb038b313ef5a2b1d415f6555e2d3a';
export const SHADER_UTF8_PATCHED_SHA256='eae6f72f5dfe03e5c0fcf81393f28f9d62af0bdb6bc0f91f969b20b45eadbd10';
const hash=source=>createHash('sha256').update(source).digest('hex');
export function patchShaderUtf8(source){
 let digest=hash(source);
 if(digest===SHADER_UTF8_PATCHED_SHA256)return {code:source,patchId:SHADER_UTF8_PATCH};
 if(digest==='d3573680e99de35a40524c4dcc52a7150172e3cbb14972b62128fba74a538e49'){
  source=source.replace("addOnPostRun(function () {\n\t// GODOTJS_SHADER_UTF8_DECODER_V1\n\tconst godotShaderDecoder = new TextDecoder('utf-8');",'addOnPostRun(function () {').replace('godotShaderDecoder.decode(slice)','UTF8Decoder.decode(slice)');
  digest=hash(source);
 }
 if(digest!==SHADER_UTF8_SOURCE_SHA256)throw Error('E_SHADER_UTF8_PATCH_UNSUPPORTED: expected pinned Godot shader patch');
 const code=source.replace('addOnPostRun(function () {',"function godotjsInstallWebGLPatch() {\n\t// GODOTJS_SHADER_UTF8_DECODER_V1\n\tconst godotShaderDecoder = new TextDecoder('utf-8');").replace('UTF8Decoder.decode(slice)','godotShaderDecoder.decode(slice)').replace(/\n\}\);\s*$/,"\n}\nif (typeof runtimeInitialized !== 'undefined' && runtimeInitialized) godotjsInstallWebGLPatch();\nelse addOnPostRun(godotjsInstallWebGLPatch);\n");
 if(hash(code)!==SHADER_UTF8_PATCHED_SHA256)throw Error('E_SHADER_UTF8_PATCH_UNSUPPORTED: unexpected patch result');
 return {code,patchId:SHADER_UTF8_PATCH};
}
