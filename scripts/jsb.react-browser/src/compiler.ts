import { createBrowserCompilerCore, type CompilerCoreEnvironment } from './compiler-core.js';
import { createResolver, type ResolvedProject } from './resolve.js';
import type { FetchFile, ResolveVersion } from './transport.js';

/** General npm resolver adapter. The Playground imports compiler-core directly. */
export interface CompilerEnvironment extends Omit<CompilerCoreEnvironment<ResolvedProject>, 'resolveProject' | 'resolveModule'> {
  fetchFile: FetchFile;
  resolveVersion?: ResolveVersion;
}
export function createBrowserCompiler(environment: CompilerEnvironment) {
  const resolver = createResolver({ fetchFile: environment.fetchFile, resolveVersion: environment.resolveVersion, typescript: environment.typescript });
  return createBrowserCompilerCore<ResolvedProject>({ ...environment, resolveProject: (snapshot, release, options) => resolver.resolveProject(snapshot, release, options) });
}
