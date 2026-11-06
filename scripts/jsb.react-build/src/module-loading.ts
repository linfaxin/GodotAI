import * as esbuild from "esbuild";
import { bundleClosedModulesWith } from './core/module-loading.js';

const unresolvedLoading = new Set(["unsupported-require-call", "unsupported-dynamic-import", "indirect-require"]);
const nativeModule = /^(?:godot(?:[./]|$)|godot-jsb$|jsb\.)/;

/** esbuild diagnoses actual module-loader bindings, including code in dependencies. */
export async function bundleClosedModules(options:esbuild.BuildOptions, runtimeShims:readonly string[]) {
  return bundleClosedModulesWith(esbuild, options, runtimeShims);
}
