import { BrowserBuildError, type ProjectSnapshot, type RuntimeRelease } from './contracts.js';
import type { CompilerProject } from './compiler-core.js';
import { canonicalJson, sha256, utf8 } from './snapshot.js';

/** Build-time bundles and curated declarations; no npm metadata or network IO. */
export interface BuiltInLibraries {
  versions: Record<string, string>;
  modules: Record<string, string>;
  files: Record<string, string>;
}
export function createBuiltInResolver(libraries: BuiltInLibraries) {
  const libraryHash = sha256(canonicalJson(libraries));
  async function resolveProject(snapshot: ProjectSnapshot, release: RuntimeRelease, options: { signal?: AbortSignal } = {}): Promise<CompilerProject & { builtins: Record<string, string> }> {
    options.signal?.throwIfAborted();
    for (const [name, version] of Object.entries(snapshot.config.dependencies)) {
      if (!Object.hasOwn(libraries.versions, name) || version !== libraries.versions[name]) throw new BrowserBuildError('E_BUILTIN_DEPENDENCY', `${name}@${version} is not built in; available: ${Object.entries(libraries.versions).map(([name, version]) => name + '@' + version).join(', ')}`);
    }
    const files = Object.fromEntries(snapshot.files);
    for (const [path, source] of Object.entries(libraries.files)) {
      const name = Object.keys(libraries.modules).find(name => path.startsWith('/node_modules/' + name + '/'));
      if (name && !Object.hasOwn(snapshot.config.dependencies, name)) continue;
      if (Object.hasOwn(files, path)) throw new BrowserBuildError('E_PROJECT_PATH', `Project shadows built-in file ${path}`);
      files[path] = utf8.encode(source);
    }
    return { files, policyId: 'builtin-v1', builtins: { ...libraries.versions },
      hash: await sha256(canonicalJson({ sourceHash: snapshot.sourceHash, release: release.id, libraries: await libraryHash })),
      runtimeGraph: { entries: Object.values(snapshot.config.entries ?? { app: { module: snapshot.config.entry } }).map(entry => entry.module), nodes: {}, edges: [], unresolved: [] },
    };
  }
  function resolveModule(specifier: string, importer: string, _kind: string, project: CompilerProject): string {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      const module = Object.hasOwn(libraries.modules, specifier) ? libraries.modules[specifier] : undefined;
      if (!module) throw new BrowserBuildError('E_BUILTIN_MODULE', `Module ${specifier} is not built in`);
      if (!Object.hasOwn(project.files, module)) throw new BrowserBuildError('E_BUILTIN_UNDECLARED', `Declare ${specifier}@${libraries.versions[specifier]} in package.json`);
      return module;
    }
    const parts: string[] = [];
    for (const part of (specifier.startsWith('/') ? specifier : importer.slice(0, importer.lastIndexOf('/') + 1) + specifier).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) throw new BrowserBuildError('E_PROJECT_PATH', 'Module path escapes project root'); parts.pop(); }
      else { if (/[\\?#:%]/.test(part)) throw new BrowserBuildError('E_PROJECT_PATH', `Invalid module path ${specifier}`); parts.push(part); }
    }
    const path = '/' + parts.join('/');
    const candidates = [path, ...(/\.jsx?$/.test(path) ? [path.replace(/\.jsx?$/, '.ts'), path.replace(/\.jsx?$/, '.tsx')] : path.endsWith('.mjs') ? [path.slice(0,-4)+'.mts'] : path.endsWith('.cjs') ? [path.slice(0,-4)+'.cts'] : []),
      ...(!/\.[^/]+$/.test(path) ? ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.json'].map(suffix => path + suffix) : [])];
    const resolved = candidates.find(candidate => Object.hasOwn(project.files, candidate) && /\.(?:[cm]?[jt]sx?|json)$/.test(candidate) && !/\.d\.[cm]?ts$/.test(candidate));
    if (!resolved) throw new BrowserBuildError('E_MODULE_NOT_FOUND', `${specifier} imported by ${importer}`);
    return resolved;
  }
  return { resolveProject, resolveModule };
}
