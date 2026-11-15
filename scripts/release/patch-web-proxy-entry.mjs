/** Emscripten 4 calls its private pthread entry from exported callMain. Godot
 * 4.6.1 also exports the old single-underscore name as a JS runtime method,
 * which modern Emscripten correctly rejects (it is a WASM entry, not JS API). */
export const PROXY_ENTRY_PATCH='godotjs-emscripten-proxy-entry-v1';
export const PROXY_ENTRY_ORIGINAL='        env["EXPORTED_RUNTIME_METHODS"] += ["_emscripten_proxy_main"]';
const replacement='        # GODOTJS_EMSCRIPTEN_PROXY_ENTRY_V1\n        # Exported callMain already selects the private pthread entry in Emscripten 4.';
export function patchProxyEntry(source){
 const count=needle=>source.split(needle).length-1;
 if(count('GODOTJS_EMSCRIPTEN_PROXY_ENTRY_V1')){
  if(count('GODOTJS_EMSCRIPTEN_PROXY_ENTRY_V1')!==1||!source.includes(replacement)||count(PROXY_ENTRY_ORIGINAL))throw Error('E_PROXY_ENTRY_PATCH_UNSUPPORTED: modified proxy-entry patch');
  return {code:source,patchId:PROXY_ENTRY_PATCH};
 }
 if(count(PROXY_ENTRY_ORIGINAL)!==1)throw Error('E_PROXY_ENTRY_PATCH_UNSUPPORTED: expected the pinned Godot proxy runtime export');
 return {code:source.replace(PROXY_ENTRY_ORIGINAL,replacement),patchId:PROXY_ENTRY_PATCH};
}
