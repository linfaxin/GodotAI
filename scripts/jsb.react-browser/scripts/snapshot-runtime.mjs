import {readFile,writeFile} from 'node:fs/promises';

// Runtime modules are shared by every target profile. Keep their emitted TS
// surface as data, so engine-api remains usable in both Node and the browser.
const input=new URL('../../out/jsb.runtime.bundle.d.ts',import.meta.url);
const output=new URL('../src/engine-api-runtime-types.ts',import.meta.url);
const declarations=(await readFile(input,'utf8')).replaceAll('\r\n','\n');
const source='// GodotJS runtime-module declaration snapshot. Kept as data so the target API\n'
 +'// consumer remains browser-safe and does not import the editor or filesystem.\n'
 +'// Source: scripts/out/jsb.runtime.bundle.d.ts (the same runtime revision).\n'
 +'export const ENGINE_RUNTIME_DECLARATIONS = '+JSON.stringify(declarations)+';\n';
if(await readFile(output,'utf8').catch(()=>null)!==source)await writeFile(output,source);
