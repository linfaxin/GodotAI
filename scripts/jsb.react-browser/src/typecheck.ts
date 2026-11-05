import type * as TS from 'typescript';
import { getProfileSchema } from '@godot-js/react/schema';

/** The runtime is injected: this module never imports TypeScript or Node at runtime. */
export type TypeScriptRuntime = typeof TS;
export interface TypeGraphEdge { importer: string; specifier: string; resolved: string; mode?: 'import' | 'require'; external?: boolean; runtimeInstanceId?: string; typeInstanceId?: string }
export interface TypeProject {
  hash?: string;
  files: Readonly<Record<string, string | Uint8Array>> | ReadonlyMap<string, string | Uint8Array>;
  typeGraph?: { entries?: readonly string[]; edges?: readonly TypeGraphEdge[]; unresolved?: readonly unknown[] };
  runtimeGraph?: { entries?: readonly string[]; edges?: readonly TypeGraphEdge[] };
  instances?: Readonly<Record<string, { id: string; name: string; version: string; root: string; dependencies?: Readonly<Record<string, string>> }>>;
}
export interface TypeEntry { module: string; export?: string; exportName?: string; props?: Readonly<Record<string, unknown>> }
export interface TypecheckInput {
  project: TypeProject;
  entries?: Readonly<Record<string, TypeEntry>>;
  entry?: string;
  props?: Readonly<Record<string, unknown>>;
  mode: 'development' | 'production';
  profileId?: string;
  sdkPackageRoot?: string;
  typesRoot?: string;
  libRoot?: string;
  projectRoot?: string;
  projectKey?: string;
  revision?: string;
  compilerOptions?: TS.CompilerOptions;
}
export interface TypeDiagnostic {
  stage: 'types'; code: number | string; category: 'error' | 'warning' | 'suggestion' | 'message'; message: string;
  file?: string; start?: number; length?: number; line?: number; column?: number;
  entryId?: string; projectKey?: string; revision?: string;
}
export interface TypecheckResult { ok: boolean; projectKey: string; revision?: string; typescriptVersion: string; diagnostics: TypeDiagnostic[]; files: number }
export interface CompletionDTO { name: string; kind: string; kindModifiers: string; sortText: string; insertText?: string; source?: string }
export interface HoverDTO { kind: string; kindModifiers: string; start: number; length: number; display: string; documentation: string; tags: { name: string; text: string }[] }

function canonical(file: string): string {
  const input = file.replace(/^res:\/\//, '/').replace(/\\/g, '/');
  if (input.includes('\0')) throw new Error('E_TYPES_PATH: NUL in virtual path');
  const parts: string[] = [];
  for (const part of input.split('/')) { if (!part || part === '.') continue; if (part === '..') { if (!parts.length) throw new Error('E_TYPES_PATH: path escapes virtual root'); parts.pop(); } else parts.push(part); }
  return '/' + parts.join('/');
}
function directory(file: string): string { return file.slice(0, file.lastIndexOf('/')) || '/'; }
function under(file: string, root: string): boolean { return file === root || file.startsWith(root + '/'); }
function stable(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}';
  throw new Error('E_ENTRY_PROPS: entry props must be finite JSON values');
}
function extension(ts: TypeScriptRuntime, file: string): TS.Extension {
  if (file.endsWith('.d.mts')) return ts.Extension.Dmts;
  if (file.endsWith('.d.cts')) return ts.Extension.Dcts;
  if (file.endsWith('.d.ts')) return ts.Extension.Dts;
  if (file.endsWith('.tsx')) return ts.Extension.Tsx;
  if (file.endsWith('.mts')) return ts.Extension.Mts;
  if (file.endsWith('.cts')) return ts.Extension.Cts;
  if (file.endsWith('.ts')) return ts.Extension.Ts;
  if (file.endsWith('.jsx')) return ts.Extension.Jsx;
  if (file.endsWith('.json')) return ts.Extension.Json;
  return ts.Extension.Js;
}

/** Resolve all asynchronous declarations first. A failed hydrate never yields a ready session. */
export async function hydrateTypeInputs(input: TypecheckInput, load: () => Promise<TypeProject>): Promise<TypecheckInput> {
  const project = await load();
  if (project.typeGraph?.unresolved?.length) throw new Error('E_TYPES_PENDING: declaration graph has unresolved inputs');
  return { ...input, project };
}

export function createTypeSession(ts: TypeScriptRuntime, input: TypecheckInput) {
  const revision = input.revision;
  const profile = getProfileSchema(input.profileId ?? 'core-ui-v1');
  const sdkRoot = canonical(input.sdkPackageRoot ?? '/node_modules/@godot-js/react');
  const libRoot = canonical(input.libRoot ?? '/typescript/lib');
  const typesRoot = canonical(input.typesRoot ?? '/node_modules/@types');
  const root = canonical(input.projectRoot ?? '/');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  // Copy strings and decode bytes now: later mutations cannot change the checked snapshot.
  const texts = new Map<string, string>();
  const iterable = input.project.files as ReadonlyMap<string, string | Uint8Array>;
  const supplied = typeof iterable[Symbol.iterator] === 'function' ? iterable : Object.entries(input.project.files);
  for (const [file, bytes] of supplied) {
    const name = canonical(file);
    if (!/\.(?:[cm]?[jt]sx?|json)$/.test(name)) continue;
    if (texts.has(name)) throw new Error(`E_TYPES_PATH: duplicate virtual path ${name}`);
    texts.set(name, typeof bytes === 'string' ? bytes : decoder.decode(bytes));
  }
  const entries: Record<string, TypeEntry> = input.entries ? Object.fromEntries(Object.entries(input.entries).map(([id, entry]) => [id, { ...entry }])) : { app: { module: input.entry ?? input.project.runtimeGraph?.entries?.[0] ?? '/src/App.tsx', props: input.props } };
  const unresolved = input.project.typeGraph?.unresolved?.length ?? 0;
  const sourceRoots = [...texts.keys()].filter(file => /\.(?:[cm]?ts|tsx)$/.test(file) && !file.includes('/node_modules/') && !under(file, libRoot));
  const synthetic = new Map<string, { id: string; module: string }>();
  for (const [id, entry] of Object.entries(entries)) {
    const module = canonical(entry.module), file = `/.godot-react-types/entry-checks/${encodeURIComponent(id)}.tsx`;
    if (texts.has(file)) throw new Error(`E_TYPES_PATH: reserved virtual path ${file}`);
    // Absolute VFS imports avoid dependence on compiler-emitted .js extension rewriting.
    texts.set(file, `import * as Module from ${JSON.stringify(module.replace(/\.(?:tsx?|mts|cts)$/, ''))};\nconst Entry = Module[${JSON.stringify(entry.exportName ?? entry.export ?? 'default')}];\nconst configuredProps = ${stable(entry.props ?? {})} as const;\nexport const entryTypeCheck = <Entry {...configuredProps}/>;\n`);
    synthetic.set(file, { id, module }); sourceRoots.push(file);
    if (!sourceRoots.includes(module)) sourceRoots.push(module);
  }
  const userOptions = structuredClone(input.compilerOptions ?? {});
  const options: TS.CompilerOptions = {
    ...userOptions,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, skipLibCheck: false, skipDefaultLibCheck: false, noEmit: true, noEmitOnError: true,
    noCheck: false, noLib: false, noImplicitAny: true, noImplicitThis: true, alwaysStrict: true,
    strictNullChecks: true, strictFunctionTypes: true, strictBindCallApply: true,
    strictPropertyInitialization: true, useUnknownInCatchVariables: true, strictBuiltinIteratorReturn: true,
    allowJs: false, allowImportingTsExtensions: true, esModuleInterop: true,
    jsx: input.mode === 'development' ? ts.JsxEmit.ReactJSXDev : ts.JsxEmit.ReactJSX, jsxImportSource: 'react',
    lib: userOptions.lib ?? ['lib.es2022.d.ts'],
    customConditions: [], types: ['react', ...(texts.has(typesRoot + '/godot-runtime/index.d.ts') ? ['godot-runtime'] : [])], typeRoots: [typesRoot],
    paths: { ...(userOptions.paths ?? {}), '@godot-js/react': [sdkRoot + '/dist/index.d.ts'], '@godot-js/react/*': [sdkRoot + '/dist/*'], 'react': [typesRoot + '/react/index.d.ts'], 'react/*': [typesRoot + '/react/*'] },
    ignoreDeprecations: '6.0',
  };
  const dirs = new Set(['/']);
  for (const file of texts.keys()) { let dir = directory(file); while (!dirs.has(dir)) { dirs.add(dir); dir = directory(dir); } }
  const edgeIndex = new Map<string, TypeGraphEdge>();
  for (const edge of input.project.typeGraph?.edges ?? []) edgeIndex.set(canonical(edge.importer) + '\0' + edge.specifier + '\0' + (edge.mode ?? 'import'), { ...edge, resolved: canonical(edge.resolved) });
  const instances = Object.values(input.project.instances ?? {}).map(instance => ({ ...instance, root: canonical(instance.root) })).sort((a, b) => b.root.length - a.root.length);
  const owner = (file: string) => instances.find(instance => under(canonical(file), instance.root));
  const runtimeEdges = new Map((input.project.runtimeGraph?.edges ?? []).map(edge => [canonical(edge.importer) + '\0' + edge.specifier + '\0' + (edge.mode ?? 'import'), { ...edge }]));
  const bindingErrors: { file: string; message: string }[] = [];
  for (const [key, edge] of edgeIndex) {
    const actual = owner(edge.resolved), runtime = runtimeEdges.get(key), runtimeInstance = runtime && (runtime.runtimeInstanceId ?? owner(runtime.resolved)?.id);
    if (edge.typeInstanceId && actual?.id !== edge.typeInstanceId) bindingErrors.push({ file: edge.importer, message: `Declaration ${edge.resolved} does not belong to locked type instance ${edge.typeInstanceId}` });
    if (runtimeInstance && (edge.runtimeInstanceId ?? actual?.id) !== runtimeInstance) bindingErrors.push({ file: edge.importer, message: `Types and runtime package bindings differ for ${edge.specifier}` });
  }
  const moduleHost: TS.ModuleResolutionHost = {
    fileExists: file => texts.has(canonical(file)), readFile: file => texts.get(canonical(file)),
    directoryExists: file => dirs.has(canonical(file)), getCurrentDirectory: () => root,
    getDirectories: file => [...dirs].filter(dir => directory(dir) === canonical(file)), realpath: canonical,
    useCaseSensitiveFileNames: true,
  };
  function resolve(specifier: string, containing: string, mode: 'import' | 'require' = 'import'): TS.ResolvedModuleFull | undefined {
    const edge = edgeIndex.get(canonical(containing) + '\0' + specifier + '\0' + mode);
    if (edge && !edge.external && texts.has(edge.resolved)) return { resolvedFileName: edge.resolved, extension: extension(ts, edge.resolved), isExternalLibraryImport: edge.resolved.includes('/node_modules/') };
    return ts.resolveModuleName(specifier, containing, options, moduleHost).resolvedModule;
  }
  const host: TS.LanguageServiceHost = {
    ...moduleHost,
    getCompilationSettings: () => options, getCurrentDirectory: () => root,
    getScriptFileNames: () => sourceRoots, getScriptVersion: () => '1',
    getScriptSnapshot: file => { const text = texts.get(canonical(file)); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
    getDefaultLibFileName: () => libRoot + '/lib.es2022.d.ts',
    getNewLine: () => '\n', useCaseSensitiveFileNames: () => true,
    resolveModuleNameLiterals: (literals, containing) => literals.map(literal => ({ resolvedModule: resolve(literal.text, containing, (literal as TS.StringLiteralLike & { resolutionMode?: number }).resolutionMode === ts.ModuleKind.CommonJS ? 'require' : 'import') })),
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry(true, root));
  const projectKey = input.projectKey ?? input.project.hash ?? '';
  const dto = (diagnostic: TS.Diagnostic): TypeDiagnostic => {
    const file = diagnostic.file?.fileName, original = file ? synthetic.get(file) : undefined, position = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
    return { stage: 'types', code: diagnostic.code, category: (['warning', 'error', 'suggestion', 'message'] as const)[diagnostic.category], message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      ...(file ? { file: original?.module ?? file } : {}), ...(diagnostic.start === undefined || original ? {} : { start: diagnostic.start }), ...(diagnostic.length === undefined ? {} : { length: diagnostic.length }),
      ...(position && !original ? { line: position.line + 1, column: position.character + 1 } : {}), ...(original ? { entryId: original.id } : {}), projectKey, revision };
  };
  function check(): TypecheckResult {
    const program = service.getProgram();
    if (!program) throw new Error('E_TYPES_PROGRAM: TypeScript did not create a program');
    const diagnostics = ts.getPreEmitDiagnostics(program).map(dto);
    const custom = (code: string, message: string, file?: string, start?: number, entryId?: string) => {
      const source = file && program.getSourceFile(file), point = source && start !== undefined ? source.getLineAndCharacterOfPosition(start) : undefined;
      diagnostics.push({ stage: 'types', category: 'error', code, message, ...(file ? { file } : {}), ...(start === undefined ? {} : { start }), ...(point ? { line: point.line + 1, column: point.character + 1 } : {}), ...(entryId ? { entryId } : {}), projectKey, revision });
    };
    if (unresolved) custom('E_TYPES_PENDING', 'Declaration graph is incomplete');
    for (const error of bindingErrors) custom('E_TYPES_PACKAGE_BINDING', error.message, error.file);
    const checker = program.getTypeChecker();
    for (const [id, entry] of Object.entries(entries)) {
      const file = canonical(entry.module), source = program.getSourceFile(file), symbol = source && checker.getSymbolAtLocation(source), name = entry.exportName ?? entry.export ?? 'default';
      if (!symbol || !checker.getExportsOfModule(symbol).some(item => item.name === name)) custom('E_ENTRY_EXPORT', `Missing ${name} export in ${file}`, file, 0, id);
    }
    // Identity is the canonical SDK declaration package, never the spelling of an import.
    const sdkComponents = program.getSourceFile(sdkRoot + '/dist/components.d.ts');
    const sdkSymbol = sdkComponents && checker.getSymbolAtLocation(sdkComponents);
    const hostSymbols = new Map<TS.Symbol, string>();
    const hostDeclarations = new Map<TS.Declaration, string>();
    if (sdkSymbol) for (const symbol of checker.getExportsOfModule(sdkSymbol)) {
      const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? sdkComponents!);
      const signatures = type.getCallSignatures();
      // Public host exports use ForwardRefExoticComponent; props/type helpers are not hosts.
      if (signatures.length && symbol.declarations?.some(declaration => ts.isVariableDeclaration(declaration))) {
        hostSymbols.set(symbol, symbol.name);
        for (const declaration of symbol.declarations ?? []) hostDeclarations.set(declaration, symbol.name);
      }
    }
    if (sdkSymbol) {
      const facade = checker.getExportsOfModule(sdkSymbol).find(symbol => symbol.name === 'G');
      if (facade) {
        const names = new Set(hostSymbols.values());
        for (const symbol of checker.getTypeOfSymbolAtLocation(facade, facade.valueDeclaration ?? sdkComponents!).getProperties()) {
          if (!names.has(symbol.name)) continue;
          hostSymbols.set(symbol, symbol.name);
          for (const declaration of symbol.declarations ?? []) hostDeclarations.set(declaration, symbol.name);
        }
      }
    }
    for (const file of program.getSourceFiles()) {
      if (file.isDeclarationFile || synthetic.has(file.fileName)) continue;
      const visit = (node: TS.Node): void => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node.tagName) ? node.tagName.name : node.tagName);
          if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
          const hostName = symbol && (hostSymbols.get(symbol) ?? symbol.declarations?.map(declaration => hostDeclarations.get(declaration)).find(Boolean));
          if (hostName && !Object.hasOwn(profile.hosts, hostName)) custom('E_PROFILE_UNSUPPORTED', `${hostName} requires a different capability profile`, file.fileName, node.getStart(file));
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    return { ok: !diagnostics.some(item => item.category === 'error'), projectKey, revision, typescriptVersion: ts.version, diagnostics, files: program.getSourceFiles().length };
  }
  return {
    check,
    complete(file: string, offset: number): CompletionDTO[] {
      return (service.getCompletionsAtPosition(canonical(file), offset, {})?.entries ?? []).map(item => ({ name: item.name, kind: item.kind, kindModifiers: item.kindModifiers ?? '', sortText: item.sortText, ...(item.insertText ? { insertText: item.insertText } : {}), ...(item.source ? { source: item.source } : {}) }));
    },
    hover(file: string, offset: number): HoverDTO | null {
      const item = service.getQuickInfoAtPosition(canonical(file), offset);
      return item ? { kind: item.kind, kindModifiers: item.kindModifiers, start: item.textSpan.start, length: item.textSpan.length, display: ts.displayPartsToString(item.displayParts), documentation: ts.displayPartsToString(item.documentation), tags: (item.tags ?? []).map(tag => ({ name: tag.name, text: ts.displayPartsToString(tag.text) })) } : null;
    },
    dispose: () => service.dispose(),
  };
}

export function checkProjectTypes(ts: TypeScriptRuntime, input: TypecheckInput): TypecheckResult {
  const session = createTypeSession(ts, input);
  try { return session.check(); } finally { session.dispose(); }
}
