import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseEngineApi,generateEngineDeclarations,canonicalEngineApi,ENGINE_DECLARATIONS_VERSION} from '../../../scripts/jsb.react-browser/dist/engine-api.js';
import {verifyEngineTypes} from './engine-api-typecheck.mjs';

const input=process.argv[2];if(!input)throw Error('Usage: node verify-engine-api-types.mjs actual-target-api.json [output-directory]');
const directory=path.resolve(process.argv[3]??'work/playground/full-engine/engine-types');await mkdir(directory,{recursive:true});
const api=parseEngineApi(JSON.parse(await readFile(input,'utf8'))),generated=generateEngineDeclarations(api);
for(const [name,value]of Object.entries(generated.files)){
 const file=path.join(directory,name.slice(1));await mkdir(path.dirname(file),{recursive:true});await writeFile(file,value);
}
// Use exactly the release gate, rather than maintaining a second, weaker set
// of consumer fixtures in this command-line entry point.
const verification=verifyEngineTypes(api,generated.files);
const report={...verification,input:path.resolve(input),engineVersion:api.engineVersion,bindingNaming:api.bindingNaming,generator:ENGINE_DECLARATIONS_VERSION,apiHash:createHash('sha256').update(canonicalEngineApi(api)).digest('hex'),coverage:generated.coverage,generatorDiagnostics:generated.diagnostics};
await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,checks:report.checks,coverage:report.coverage,declarationErrors:report.declarationDiagnostics.length,positiveDiagnostics:report.positiveDiagnostics,generatorDiagnostics:report.generatorDiagnostics},null,2));
if(report.status!=='passed')process.exitCode=1;
