import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {canonical,digest} from '../../../../scripts/release/web-release-utils.mjs';
import {engineBuildArgs,getEngineProfile} from '../../../../scripts/release/engine-profiles.mjs';

/** Small synthetic source-proof fixture; no native compilation is claimed. */
export async function engineBuildFixture(root,{profile='engine-2d-v1',target='template_debug',lto='none',moduleMode='baseline',jobs=4}={}){
 await mkdir(root,{recursive:true});const wasm=Buffer.from([0,97,115,109,1,0,0,0]);
 await writeFile(path.join(root,'godot.wasm'),wasm);
 const template=path.join(root,'engine-template.zip');
 const zipped=spawnSync('zip',['-q',template,'godot.wasm'],{cwd:root});if(zipped.status!==0)throw Error('Fixture zip failed');
 const args=engineBuildArgs({profile,target,lto,moduleMode,jobs}),definition=getEngineProfile(profile);
 const inputs={'fixture.cpp':digest('fixture source')},source={commit:'a'.repeat(40),inputs,snapshotHash:digest(canonical(inputs))};
 const recipe={command:'fixture-scons',args,environment:{}};
 const bytes=await readFile(template),log=Buffer.from('Synthetic build fixture, not a real compiler log\n');
 const report={schemaVersion:1,kind:'godot-js-browser-engine-build',status:'built',runtimeProfile:profile,engineTarget:target,sourceCertified:true,source,godotSource:{...source,commit:'b'.repeat(40)},recipe,recipeSha256:digest(canonical(recipe)),requestedArgs:args,builder:{sha256:digest('fixture builder')},toolchains:{emscripten:'fixture-emcc'},versionEvidence:{sha256:digest('fixture version')},modules:[...definition.modules],resolvedFeatures:{...definition.features},resolvedBuildOptions:{...definition.features,lto,modules_enabled_by_default:moduleMode==='baseline'},template:{path:template,sha256:digest(bytes),bytes:bytes.length},logSha256:digest(log)};
 const reportPath=path.join(root,'source-report.json');await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');await writeFile(reportPath+'.log',log);
 return {report,reportPath,template};
}
