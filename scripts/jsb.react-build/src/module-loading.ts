import * as esbuild from "esbuild";
import {fail} from "./types.js";

const unresolvedLoading = new Set(["unsupported-require-call", "unsupported-dynamic-import", "indirect-require"]);
const nativeModule = /^(?:godot(?:[./]|$)|godot-jsb$|jsb\.)/;

/** esbuild diagnoses actual module-loader bindings, including code in dependencies. */
export async function bundleClosedModules(options:esbuild.BuildOptions, runtimeShims:readonly string[]) {
  let result:esbuild.BuildResult;
  try {
    result=await esbuild.build({...options,metafile:true,logLevel:"silent",logOverride:{
      ...options.logOverride,
      "unsupported-require-call":"error", "unsupported-dynamic-import":"error", "indirect-require":"error",
    }});
  } catch(error) {
    const errors=(error as esbuild.BuildFailure).errors;
    if(Array.isArray(errors)&&errors.some(item=>unresolvedLoading.has(item.id)))
      fail("E_DYNAMIC_MODULE",`Module paths must be string literals; use static imports or literal import()/require().\n${(await esbuild.formatMessages(errors,{kind:"error",color:false})).join("\n")}`);
    throw error;
  }
  const allowed=new Set(runtimeShims);
  // Computed paths with a static prefix become esbuild glob dispatchers. Their
  // synthetic external imports can fail extensionless TS lookup at runtime.
  for(const [filename,input]of Object.entries(result.metafile!.inputs))for(const item of input.imports)
    if(item.external&&!allowed.has(item.path)&&!nativeModule.test(item.path))
      fail("E_DYNAMIC_MODULE",`Unregistered module loading ${JSON.stringify(item.path)} in ${filename}; use a string-literal module path`);
  return result;
}
