import {promises as fs} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {build} from "esbuild";
import {catalog} from "../src/catalog.ts";
import {prepareAssets} from "./prepare-assets.mjs";
import {buildFrontend} from "./build-frontend.mjs";
import {buildPreviewHost} from './build-preview-host.mjs';
import {buildDemoRuntime} from './build-demo-runtime.mjs';
import {writeTypeSnapshot,createTypeSnapshot} from "./build-shell.mjs";
import {loadProductionApiProfiles,buildEngineVendor,assembleFullEngineRelease,describeAsset,writeFullEngineOutputs} from './full-engine-release.mjs';
import {resolvePlaygroundEngine} from '../../../scripts/release/browser-engine-artifacts.mjs';
import {profileCatalog,collectManifestPayloads} from './profile-resources.mjs';
import {describeResourceTool} from './prepare-assets.mjs';
import {invalidateSiteDelivery} from './site-delivery-state.mjs';
import {executionFromReport,legacyExecution} from '../../../scripts/release/execution-contract.mjs';
import {productOutputPath,productExportPreset,exportedExecution} from './product-execution.mjs';
import {describeWorkerCandidate,assertWorkerBuildProof} from './worker-candidate.mjs';
import {proveWorkerSdkBuild,assertWorkerSdkBuildFrozen} from './worker-sdk-proof.mjs';

const argument=name=>{const index=process.argv.indexOf(name);if(index<0)return undefined;const value=process.argv[index+1];if(!value||value.startsWith('--'))throw Error('Missing '+name+' value');return value;};
if(process.argv.includes('--legacy-execution'))throw Error('E_EXECUTION_BACKEND_RETIRED: legacy execution has been removed; ordinary builds use Worker');
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),repo=path.resolve(app,"../.."),seedProject=path.join(app,"project");
const sdk=path.join(repo,"scripts/jsb.react"),host=process.env.GODOT??path.join(repo,"tests/bin/godot-host-qjs");
const requestedJobs=argument('--jobs')??process.env.JOBS;
const inputs=await resolvePlaygroundEngine({repository:repo,profile:argument('--profile')??process.env.ENGINE_PROFILE,target:argument('--target')??process.env.ENGINE_TARGET,lto:argument('--lto')??process.env.ENGINE_LTO,moduleMode:argument('--module-mode')??process.env.ENGINE_MODULE_MODE,executionModel:argument('--execution-model')??process.env.ENGINE_EXECUTION_MODEL,jobs:requestedJobs===undefined?undefined:Number(requestedJobs),reportPath:argument('--engine-report')??process.env.ENGINE_BUILD_REPORT,templatePath:process.env.GODOT_WEB_TEMPLATE,development:process.argv.includes('--development')});
const {profile:runtimeProfile,target,lto,moduleMode,executionModel}=inputs.configuration;
const {reportPath:engineReportPath,report:engineReport,reportSha256:engineReportSha256,template,templateHash}=inputs;
const execution=engineReport?.execution||engineReport?.status==='built'?executionFromReport(engineReport,{requireWorkerAssets:executionModel!=='window'}):legacyExecution();
if(executionModel==='window')assertWorkerBuildProof(engineReport);
if(execution.executionModel!==executionModel)throw Error('E_PLAYGROUND_EXECUTION: Requested model has no matching build evidence');
const dist=productOutputPath({app,runtimeProfile,target,lto,moduleMode,executionModel,artifactDirectory:inputs.defaults.artifactDirectory,explicitOutput:argument('--out')});
if(dist===repo||dist===app||dist===seedProject||repo.startsWith(dist+path.sep))throw Error('Output must be a dedicated site directory');
const run=(bin,args,cwd=app)=>{const r=spawnSync(bin,args,{cwd,encoding:"utf8",maxBuffer:32*1024*1024}),output=(r.stdout??"")+(r.stderr??"");const errors=output.split("\n").filter(line=>/^(?:ERROR|SCRIPT ERROR):/.test(line)&&!line.includes("compiled without fontconfig"));if(r.status!==0||errors.length)throw Error(`${bin} ${args.join(" ")} failed (${r.status})\n${output}`);return output;};
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const workspace=path.resolve(argument('--work-dir')??path.join(repo,'work/playground',runtimeProfile,...(executionModel==='window'?[]:[executionModel]),target,`site-${templateHash.slice(0,12)}-${process.pid}`)),project=path.join(workspace,'export-project');
if([repo,app,seedProject,dist].some(directory=>directory===workspace||directory.startsWith(workspace+path.sep))||workspace.startsWith(seedProject+path.sep)||workspace.startsWith(dist+path.sep))throw Error('Build work directory must be a dedicated workspace independent of source project and output');
const exporter=await describeResourceTool(host);
await fs.mkdir(workspace,{recursive:true});
if(!process.argv.includes('--skip-assets')){await fs.rm(project,{recursive:true,force:true});await fs.mkdir(project,{recursive:true});for(const name of ['project.godot','main.tscn','shaders'])await fs.cp(path.join(seedProject,name),path.join(project,name),{recursive:true});}
else{const prepared=argument('--resource-project');if(prepared){await fs.rm(project,{recursive:true,force:true});await fs.cp(path.resolve(prepared),project,{recursive:true});}await fs.access(path.join(project,'generated/assets.js'));}
const verifyTemplate=async()=>{if(sha(await fs.readFile(template))!==templateHash)throw Error("Web template changed during export; finish the engine build, then rebuild the playground.");if(engineReportPath&&sha(await fs.readFile(engineReportPath))!==engineReportSha256)throw Error('Engine report changed during export; rebuild the playground.');};
const write=(name,text)=>fs.writeFile(path.join(dist,name),text);
await fs.mkdir(dist,{recursive:true});await fs.mkdir(path.join(project,".godot/GodotJS"),{recursive:true});await fs.mkdir(path.join(project,"generated"),{recursive:true});
await invalidateSiteDelivery(dist);
await fs.rm(path.join(dist,'engine-release.json'),{force:true});
if(!process.argv.includes("--skip-sdk-build")){console.log("Building engine and React SDK");console.log(run('pnpm',['--filter','@godot-js/react-browser...','build'],repo));}
const sdkBuild=await proveWorkerSdkBuild(repo);
if(!process.argv.includes("--skip-assets"))await prepareAssets({runtimeProfile,project,workDirectory:path.join(workspace,'asset-project'),importer:process.env.GODOT_IMPORTER??host});
const publicCatalog=await Promise.all(profileCatalog(catalog,runtimeProfile).map(async demo=>({...demo,runtime:'react',source:await fs.readFile(path.join(app,'src/demos',demo.file),'utf8')})));
await write('catalog.json',JSON.stringify(publicCatalog));
for(const name of ['host.ts','generated/vendor.js','generated/defaults.js','.godot/GodotJS/host.js'])await fs.rm(path.join(project,name),{force:true});
console.log("Importing playground resources");console.log(run(host,["--headless","--editor","--path",project,"--import"]));
await fs.mkdir(path.join(dist,"engine"),{recursive:true});
await fs.writeFile(path.join(project,"export_presets.cfg"),productExportPreset({template,execution}));
await verifyTemplate();
console.log('Exporting GodotJS Web ('+executionModel+')');console.log(run(host,["--headless","--path",project,target==='template_release'?'--export-release':'--export-debug',"Playground Web",path.join(dist,"engine/game.html")]));
await verifyTemplate();
await fs.cp(path.join(app,"web"),dist,{recursive:true});
// Build the exact browser host before calculating engineId. This bundle has no
// manifest/engine identity input; the later HTML supplies its SRI independently.
const previewHost=await buildPreviewHost(dist,{executionModel});
let fullRelease;
{
 const engineJs=path.join(dist,'engine/game.js'),engineWasm=path.join(dist,'engine/game.wasm');
 const productExecution=await exportedExecution({execution,siteDirectory:dist});
 const describe=async name=>describeAsset(name,await fs.readFile(path.join(dist,name)));
 const engine={javascript:await describe('engine/game.js'),wasm:await describe('engine/game.wasm'),worklets:await Promise.all(['engine/game.audio.worklet.js','engine/game.audio.position.worklet.js'].map(describe)),host:previewHost,execution:productExecution,workerAssets:productExecution.workerAssets};
 if(executionModel==='window')assertWorkerBuildProof(engineReport,engine);
 console.log('Capturing API from the production Web engine');
 const namingProfiles=await loadProductionApiProfiles({engineJs,engineWasm,captureDirectory:path.join(dist,'api/capture'),execution:productExecution});
 await Promise.all(Object.values(namingProfiles).map(async profile=>{profile.typeSnapshot=await createTypeSnapshot({engineFiles:profile.declarations.files});}));
 const api=namingProfiles.snake;
 if(engineReport?.modules&&JSON.stringify([...engineReport.modules].sort())!==JSON.stringify([...api.ir.modules].sort()))throw Error('Engine report module list differs from the production API');
 const [vendor,developmentVendor]=await Promise.all([buildEngineVendor(),buildEngineVendor({mode:'development'})]);
 if(executionModel==='window'&&!engineReport?.runtimeAbi)throw Error('E_WORKER_BUILD_ABI: the actual template report must declare its runtime ABI');
 const release=assembleFullEngineRelease({...api,namingProfiles,engine,runtimeProfile,...(executionModel==='window'?{runtimeAbi:engineReport.runtimeAbi,engineBuildReport:engineReport}:{}),sdkVersion:JSON.parse(await fs.readFile(path.join(sdk,'package.json'),'utf8')).version,vendor,developmentVendor,build:{actualAPIHash:api.actualAPIHash,engineTemplateSha256:templateHash,sourceCertified:inputs.sourceCertified,sdkBuild,provenance:inputs.sourceCertified?'exact-template-and-native-api-capture':'uncertified-local-development',...(engineReport?{engineReportSha256,engineSource:engineReport.source,godotSource:engineReport.godotSource,recipeSha256:engineReport.recipeSha256}:{} )}});
 await writeFullEngineOutputs(dist,release.outputs);fullRelease=release.manifest;
 await fs.rm(path.join(dist,'api/capture'),{recursive:true,force:true});
}
// Ship license text beside the public bundle, without duplicating model assets.
for(const source of JSON.parse(await fs.readFile(path.join(app,"third-party/sources.json"),"utf8"))){
  if(!/(?:license|readme)/i.test(source.local))continue;
  const destination=path.join(dist,source.local);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(path.join(app,source.local),destination);
}
await fs.mkdir(path.join(dist,'resource-inputs/generated'),{recursive:true});
await fs.copyFile(path.join(project,'generated/assets.js'),path.join(dist,'resource-inputs/generated/assets.js'));
await buildDemoRuntime(dist,{project:path.join(dist,'resource-inputs'),runtimeProfile});
await buildFrontend(dist,undefined,{runtimeProfile,previewHost,executionModel});
await write('shell-profile.json',JSON.stringify({schemaVersion:2,runtimeProfile,executionModel,shellOnly:false}));
const resourceInputs=JSON.parse(await fs.readFile(path.join(project,'generated/resource-inputs.json'),'utf8'));
const resourceReport={...resourceInputs,conversionImporter:runtimeProfile==='engine-2d-v1'?null:resourceInputs.importer,importer:exporter,exporter,template:{sha256:templateHash,target},engineReleaseId:fullRelease.id,generatedManifest:{path:'resource-inputs/generated/assets.js',sha256:sha(await fs.readFile(path.join(dist,'resource-inputs/generated/assets.js')))},output:{path:'engine/game.pck',bytes:(await fs.stat(path.join(dist,'engine/game.pck'))).size,sha256:sha(await fs.readFile(path.join(dist,'engine/game.pck')))},demoPack:{path:'demo-resources.pck',sha256:sha(await fs.readFile(path.join(dist,'demo-resources.pck')))}};
await write('resource-build.json',JSON.stringify(resourceReport,null,2)+'\n');
await fs.mkdir(path.join(dist,'assets'),{recursive:true});
for(const name of ['LICENSE','ThirdPartyNotices.txt'])await fs.copyFile(path.join(app,'node_modules/monaco-editor',name),path.join(dist,'assets','monaco-'+name+(name.endsWith('.txt')?'':'.txt')));
const payloads=await collectManifestPayloads(dist);
await assertWorkerSdkBuildFrozen(repo,sdkBuild);
await verifyTemplate();
if(sha(await fs.readFile(exporter.path))!==exporter.sha256)throw Error('Resource exporter changed during the build');
const runtime=executionModel==='window'?await describeWorkerCandidate(dist,fullRelease):undefined;
await write('manifest.json',JSON.stringify({schemaVersion:runtime?3:2,...(runtime?{runtime}:{}),runtimeProfile,executionModel,engineTarget:target,publicAssets:process.argv.includes('--public-assets'),resourceBuild:'resource-build.json',engineRelease:'engine-release.json',engineReleaseId:fullRelease.id,engineId:fullRelease.engineId,extensionId:fullRelease.extensionId,engineTemplateSha256:templateHash,payloads},null,2));
console.log(`Playground built: ${dist}`);
