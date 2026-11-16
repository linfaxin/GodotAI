import ts from 'typescript';
import {ProjectToolError} from './errors.js';

/** One policy describes the GodotJS module format. Checking and emitting have
 * intentionally different noEmit/extension/map settings. */
export const ENGINE_COMPILER_POLICY = 'godotjs-engine-compiler/1' as const;
export interface CompilerPolicy { readonly id: typeof ENGINE_COMPILER_POLICY }
export const DEFAULT_COMPILER_POLICY: CompilerPolicy = Object.freeze({id: ENGINE_COMPILER_POLICY});

export function assertCompilerPolicy(policy: CompilerPolicy = DEFAULT_COMPILER_POLICY): void {
  if (!policy || policy.id !== ENGINE_COMPILER_POLICY || Object.keys(policy).some(key => key !== 'id'))
    throw new ProjectToolError('E_COMPILER_POLICY', 'Unsupported engine compiler policy');
}

export function engineEmitOptions(policy: CompilerPolicy = DEFAULT_COMPILER_POLICY): ts.CompilerOptions {
  assertCompilerPolicy(policy);
  return {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
    esModuleInterop: true, sourceMap: true, inlineSources: true, rewriteRelativeImportExtensions: true};
}

export function engineCheckOptions(policy: CompilerPolicy = DEFAULT_COMPILER_POLICY): ts.CompilerOptions {
  return {...engineEmitOptions(policy), moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true, skipLibCheck: true, lib: ['lib.es2022.d.ts'], types: [], ignoreDeprecations: '6.0',
    resolveJsonModule: true, allowJs: true, noEmit: true, allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: false, outDir: '/__emit'};
}
