import type { BuildOptions, BuildResult, BuildFailure, Message, FormatMessagesOptions } from 'esbuild';
import { fail } from '../types.js';
export interface BundlerPort {
  build(options: BuildOptions): Promise<BuildResult>;
  formatMessages(messages: Message[], options: FormatMessagesOptions): Promise<string[]>;
}
const unresolvedLoading = new Set(['unsupported-require-call', 'unsupported-dynamic-import', 'indirect-require']);
const nativeModule = /^(?:godot(?:[./]|$)|godot-jsb$|jsb\.)/;
/** Inject native esbuild on Node or esbuild-wasm in a browser. */
export async function bundleClosedModulesWith(bundler: BundlerPort, options: BuildOptions, runtimeShims: readonly string[], canonicalAliases: Readonly<Record<string, string>> = {}) {
  let result: BuildResult;
  try {
    result = await bundler.build({ ...options, metafile: true, logLevel: 'silent', logOverride: {
      ...options.logOverride, 'unsupported-require-call': 'error', 'unsupported-dynamic-import': 'error', 'indirect-require': 'error',
    } });
  } catch (error) {
    const errors = (error as BuildFailure).errors;
    if (Array.isArray(errors) && errors.some(item => unresolvedLoading.has(item.id)))
      fail('E_DYNAMIC_MODULE', `Module paths must be string literals; use static imports or literal import()/require().\n${(await bundler.formatMessages(errors, { kind: 'error', color: false })).join('\n')}`);
    throw error;
  }
  const allowed = new Set(runtimeShims);
  // Custom namespaces may retain the author specifier in input metadata while
  // recording the actual rewritten URI only in output metadata. Accept only
  // compiler-owned aliases and independently check every emitted external edge.
  const acceptedInput = (path: string) => allowed.has(path) || nativeModule.test(path) || (Object.hasOwn(canonicalAliases, path) && allowed.has(canonicalAliases[path]));
  for (const [filename, input] of Object.entries(result.metafile!.inputs)) for (const item of input.imports)
    if (item.external && !acceptedInput(item.path)) {
      fail('E_DYNAMIC_MODULE', `Unregistered module loading ${JSON.stringify(item.path)} in ${filename}; use a string-literal module path`);
    }
  for (const [filename, output] of Object.entries(result.metafile!.outputs)) for (const item of output.imports)
    if (item.external && !allowed.has(item.path) && !nativeModule.test(item.path)) fail('E_DYNAMIC_MODULE', `Unregistered emitted module ${JSON.stringify(item.path)} in ${filename}`);
  return result;
}
