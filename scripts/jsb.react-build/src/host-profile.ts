import path from 'node:path';
import ts from 'typescript';
import { getProfileSchema } from '@godot-js/react/schema';
import { fail } from './types.js';
import { slash } from './fs.js';

/** Identify canonical SDK declarations, including aliases, re-exports and the G facade. */
export function checkHostProfile(program: ts.Program, runtimeRoot: string, projectRoot: string, profileId?: string): void {
  const profile = getProfileSchema(profileId);
  const checker = program.getTypeChecker();
  const components = program.getSourceFile(path.join(runtimeRoot, 'dist/components.d.ts'));
  const module = components && checker.getSymbolAtLocation(components);
  const hosts = new Map<ts.Symbol, string>();
  const declarations = new Map<ts.Declaration, string>();
  if (module) for (const symbol of checker.getExportsOfModule(module)) {
    const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? components!);
    if (type.getCallSignatures().length && symbol.declarations?.some(ts.isVariableDeclaration)) {
      hosts.set(symbol, symbol.name);
      for (const declaration of symbol.declarations ?? []) declarations.set(declaration, symbol.name);
    }
  }
  if (module) {
    const facade = checker.getExportsOfModule(module).find(symbol => symbol.name === 'G');
    if (facade) {
      const names = new Set(hosts.values());
      for (const symbol of checker.getTypeOfSymbolAtLocation(facade, facade.valueDeclaration ?? components!).getProperties()) {
        if (!names.has(symbol.name)) continue;
        hosts.set(symbol, symbol.name);
        for (const declaration of symbol.declarations ?? []) declarations.set(declaration, symbol.name);
      }
    }
  }
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !file.fileName.startsWith(projectRoot + path.sep)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node.tagName) ? node.tagName.name : node.tagName);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const name = symbol && (hosts.get(symbol) ?? symbol.declarations?.map(declaration => declarations.get(declaration)).find(Boolean));
        if (name && !Object.hasOwn(profile.hosts, name)) {
          const point = file.getLineAndCharacterOfPosition(node.getStart(file));
          fail('E_PROFILE_UNSUPPORTED', `${name} requires a different capability profile (${slash(path.relative(projectRoot, file.fileName))}:${point.line + 1}:${point.character + 1})`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
}
