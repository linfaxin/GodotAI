import ts from 'typescript';
import {type SourceInput, type SourceSnapshot} from './build-plan.js';
import {canonicalPath} from './paths.js';
import {moduleCandidates, projectModulePath, projectScript} from './project-modules.js';
import {engineCheckOptions, DEFAULT_COMPILER_POLICY, type CompilerPolicy} from './compiler-policy.js';
import {ProjectToolError} from './errors.js';

export interface CompilerDiagnostic {
  file?: string; message: string; line: number; column: number; start?: number; length?: number;
  code: number | string; category: 'error' | 'warning' | 'info';
}
export interface ProjectTypeEnvironmentOptions {
  sources: SourceInput;
  declarations: Readonly<Record<string, string>>;
  /** Module specifiers map to the exact declaration files supplied above. */
  moduleDeclarations?: Readonly<Record<string, string>>;
  policy?: CompilerPolicy;
}
export interface ProjectTypeEnvironment {
  readonly files: Readonly<Record<string, string>>;
  readonly userFiles: Readonly<Record<string, string>>;
  readonly options: Readonly<ts.CompilerOptions>;
  createLanguageService(): ts.LanguageService;
}

export const typeFilePath = (value: string): string => canonicalPath(value.startsWith('res://') ? value.slice(6) : value);
export function sourceTextFiles(input: SourceInput): Record<string, string> {
  const rows = typeof (input as ReadonlyMap<string, unknown>)[Symbol.iterator] === 'function'
    ? [...input as ReadonlyMap<string, string | readonly number[] | Uint8Array>] : Object.entries(input);
  const files: Record<string, string> = Object.create(null);
  for (const [name, value] of rows) if (typeof value === 'string') {
    const path = typeFilePath(name);
    if (Object.hasOwn(files, path)) throw new ProjectToolError('E_PROJECT_PATH_COLLISION', `Duplicate type input: ${path}`);
    files[path] = value;
  }
  return files;
}

/** Type checking never needs to expand binary attachments at the JSON boundary. */
export function snapshotTextFiles(snapshot: SourceSnapshot): Record<string, string> {
  return Object.fromEntries(snapshot.files.filter(file => file.encoding === 'utf8')
    .map(file => [file.path, new TextDecoder('utf-8', {fatal: true}).decode(file.bytes)]));
}

/** Immutable virtual type view shared by CLI checks and the editor LS. There
 * is deliberately no fallback to ts.sys, the host filesystem or Node types. */
export function createProjectTypeEnvironment(input: ProjectTypeEnvironmentOptions): ProjectTypeEnvironment {
  const user = sourceTextFiles(input.sources), declarations: Record<string, string> = Object.create(null);
  for (const [name, text] of Object.entries(input.declarations)) {
    if (typeof text !== 'string') throw new ProjectToolError('E_COMPILER_DECLARATIONS', 'Declaration inputs must be text');
    const path = typeFilePath(name);
    if (Object.hasOwn(declarations, path) || Object.hasOwn(user, path))
      throw new ProjectToolError('E_COMPILER_DECLARATIONS', `Project shadows a toolchain declaration: ${path}`);
    declarations[path] = text;
  }
  const files = Object.freeze(Object.assign(Object.create(null), declarations, user)) as Readonly<Record<string, string>>;
  const routes: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(input.moduleDeclarations ?? {})) routes[name] = typeFilePath(value);
  const options = engineCheckOptions(input.policy ?? DEFAULT_COMPILER_POLICY);
  if (options.lib) Object.freeze(options.lib);
  if (options.types) Object.freeze(options.types);
  const roots = [...Object.keys(user).filter(path => projectScript.test(path)), ...Object.keys(declarations).filter(path =>
    path.startsWith('/godot/') || path.startsWith('/godot-jsb/') || path.startsWith('/godot.annotations/'))];
  const resolve = (name: string, from: string): ts.ResolvedModule | undefined => {
    const base = projectModulePath(name, from);
    const path = routes[name] ?? (base ? moduleCandidates(base).find(candidate => Object.hasOwn(files, candidate)) : undefined);
    return path && Object.hasOwn(files, path) ? {resolvedFileName: path, isExternalLibraryImport: !Object.hasOwn(user, path)} : undefined;
  };
  return Object.freeze({files, userFiles: Object.freeze(user), options: Object.freeze(options), createLanguageService() {
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...roots], getScriptVersion: () => '1',
      getScriptSnapshot: name => Object.hasOwn(files, name) ? ts.ScriptSnapshot.fromString(files[name]!) : undefined,
      getCompilationSettings: () => ({...options}), getCurrentDirectory: () => '/',
      getDefaultLibFileName: () => '/lib/lib.es2022.d.ts', fileExists: name => Object.hasOwn(files, name),
      readFile: name => files[name], readDirectory: () => [],
      resolveModuleNames: (names, from) => names.map(name => resolve(name, from)),
    };
    return ts.createLanguageService(host);
  }});
}

export function checkProjectTypes(environment: ProjectTypeEnvironment, service?: ts.LanguageService): CompilerDiagnostic[] {
  const owned = service ?? environment.createLanguageService();
  try {
    const program = owned.getProgram();
    if (!program) throw new ProjectToolError('E_COMPILER_PROGRAM', 'Could not create the project type program');
    const diagnostics: CompilerDiagnostic[] = ts.getPreEmitDiagnostics(program)
      .filter(item => !item.file || Object.hasOwn(environment.userFiles, item.file.fileName)).map(item => {
        const point = item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start) : undefined;
        return {file: item.file?.fileName, message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
          line: point ? point.line + 1 : 0, column: point ? point.character + 1 : 0,
          ...(item.start !== undefined ? {start: item.start} : {}), ...(item.length !== undefined ? {length: item.length} : {}),
          code: item.code, category: item.category === ts.DiagnosticCategory.Error ? 'error' : item.category === ts.DiagnosticCategory.Warning ? 'warning' : 'info'};
      });
    // Only JSON reachable by the same type graph is executable input.
    for (const source of program.getSourceFiles().filter(item => Object.hasOwn(environment.userFiles, item.fileName) && item.fileName.endsWith('.json'))) {
      try { JSON.parse(source.text); } catch (error) {
        if (diagnostics.some(item => item.file === source.fileName && item.category === 'error')) continue;
        const message = String(error), offset = /position (\d+)/.exec(message), location = /line (\d+) column (\d+)/.exec(message);
        const start = offset ? Number(offset[1]) : location ? source.getPositionOfLineAndCharacter(Number(location[1]) - 1, Number(location[2]) - 1) : source.text.length;
        const point = source.getLineAndCharacterOfPosition(Math.min(start, source.text.length));
        diagnostics.push({file: source.fileName, message, line: point.line + 1, column: point.character + 1, start, length: 1, code: 0, category: 'error'});
      }
    }
    return diagnostics;
  } finally { if (!service) owned.dispose(); }
}
