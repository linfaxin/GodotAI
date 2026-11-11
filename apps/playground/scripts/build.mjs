import {promises as fs} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {build} from "esbuild";
import {catalog} from "../src/catalog.ts";
import {prepareAssets} from "./prepare-assets.mjs";
import {buildFrontend} from "./build-frontend.mjs";
import {buildDemoRuntime} from './build-demo-runtime.mjs';
import {writeTypeSnapshot,createTypeSnapshot} from "./build-shell.mjs";
import {loadProductionApiProfiles,buildEngineVendor,assembleFullEngineRelease,describeAsset,writeFullEngineOutputs} from './full-engine-release.mjs';
import {isSourceCertified} from '../../../scripts/release/build-web-release.mjs';

const argument=name=>{const index=process.argv.indexOf(name);if(index<0)return undefined;const value=process.argv[index+1];if(!value||value.startsWith('--'))throw Error('Missing '+name+' value');return value;};
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),repo=path.resolve(app,"../.."),project=path.join(app,"project"),dist=path.resolve(argument('--out')??path.join(app,"dist"));
if(dist===repo||dist===app||dist===project||repo.startsWith(dist+path.sep))throw Error('Output must be a dedicated site directory');
const sdk=path.join(repo,"scripts/jsb.react"),host=process.env.GODOT??path.join(repo,"tests/bin/godot-host-qjs");
const engineReportPath=argument('--engine-report');
const engineReport=engineReportPath?JSON.parse(await fs.readFile(engineReportPath,'utf8')):undefined;
const template=process.env.GODOT_WEB_TEMPLATE??(engineReport?.template?.path?path.resolve(path.dirname(engineReportPath),engineReport.template.path):path.join(repo,'work/playground/engine-template/full-engine.zip'));
if(!path.isAbsolute(template))throw Error('GODOT_WEB_TEMPLATE must be an absolute path');
try{await fs.access(template);}catch{throw Error(`Missing production Web template ${template}; build it with scripts/build-web-engine.sh or set GODOT_WEB_TEMPLATE to the matching full engine ZIP.`);}
const run=(bin,args,cwd=app)=>{const r=spawnSync(bin,args,{cwd,encoding:"utf8",maxBuffer:32*1024*1024}),output=(r.stdout??"")+(r.stderr??"");const errors=output.split("\n").filter(line=>/^(?:ERROR|SCRIPT ERROR):/.test(line)&&!line.includes("compiled without fontconfig"));if(r.status!==0||errors.length)throw Error(`${bin} ${args.join(" ")} failed (${r.status})\n${output}`);return output;};
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const templateHash=sha(await fs.readFile(template));
if(engineReport&&(engineReport.kind!=='godot-js-browser-engine-build'||engineReport.status!=='built'||engineReport.template?.sha256!==templateHash||!engineReport.recipe?.args?.includes('modules_enabled_by_default=yes')))throw Error('Engine report must identify this exact full-module Web template');
const verifyTemplate=async()=>{if(sha(await fs.readFile(template))!==templateHash)throw Error("Web template changed during export; finish the engine build, then rebuild the playground.");};
const write=(name,text)=>fs.writeFile(path.join(dist,name),text);
await fs.mkdir(dist,{recursive:true});await fs.mkdir(path.join(project,".godot/GodotJS"),{recursive:true});await fs.mkdir(path.join(project,"generated"),{recursive:true});
await fs.rm(path.join(dist,'engine-release.json'),{force:true});
console.log("Building React SDK");console.log(run(process.execPath,["build.mjs"],sdk));
{console.log(run('pnpm',['--filter','@godot-js/react-build','build'],repo));console.log(run('pnpm',['--filter','@godot-js/react-browser','build'],repo));}
if(!process.argv.includes("--skip-assets"))await prepareAssets();
const publicCatalog=await Promise.all(catalog.map(async demo=>({...demo,runtime:'react',source:await fs.readFile(path.join(app,'src/demos',demo.file),'utf8')})));
await write('catalog.json',JSON.stringify(publicCatalog));
for(const name of ['host.ts','generated/vendor.js','generated/defaults.js','.godot/GodotJS/host.js'])await fs.rm(path.join(project,name),{force:true});
console.log("Importing playground resources");console.log(run(host,["--headless","--editor","--path",project,"--import"]));
await fs.mkdir(path.join(dist,"engine"),{recursive:true});
await fs.writeFile(path.join(project,"export_presets.cfg"),`[preset.0]\nname="Playground Web"\nplatform="Web"\nrunnable=true\nexport_filter="all_resources"\ninclude_filter="generated/*.js,shaders/*.gdshader"\nexclude_filter=""\nexport_path=""\n\n[preset.0.options]\ncustom_template/debug=${JSON.stringify(template)}\ncustom_template/release=${JSON.stringify(template)}\nvariant/extensions_support=false\nvariant/thread_support=false\nvram_texture_compression/for_desktop=true\nvram_texture_compression/for_mobile=false\nhtml/canvas_resize_policy=2\nprogressive_web_app/enabled=false\n`);
await verifyTemplate();
console.log("Exporting single-thread GodotJS Web");console.log(run(host,["--headless","--path",project,"--export-debug","Playground Web",path.join(dist,"engine/game.html")]));
await verifyTemplate();
await fs.cp(path.join(app,"web"),dist,{recursive:true});
let fullRelease;
{
 console.log('Capturing API from the production Web engine');
 const engineJs=path.join(dist,'engine/game.js'),engineWasm=path.join(dist,'engine/game.wasm');
 const namingProfiles=await loadProductionApiProfiles({engineJs,engineWasm,captureDirectory:path.join(dist,'api/capture')});
 await Promise.all(Object.values(namingProfiles).map(async profile=>{profile.typeSnapshot=await createTypeSnapshot({engineFiles:profile.declarations.files});}));
 const api=namingProfiles.snake;
 if(engineReport?.modules&&JSON.stringify([...engineReport.modules].sort())!==JSON.stringify([...api.ir.modules].sort()))throw Error('Engine report module list differs from the production API');
 const describe=async name=>describeAsset(name,await fs.readFile(path.join(dist,name)));
 const engine={javascript:await describe('engine/game.js'),wasm:await describe('engine/game.wasm'),worklets:await Promise.all(['engine/game.audio.worklet.js','engine/game.audio.position.worklet.js'].map(describe))};
 const [vendor,developmentVendor]=await Promise.all([buildEngineVendor(),buildEngineVendor({mode:'development'})]);
 const release=assembleFullEngineRelease({...api,namingProfiles,engine,sdkVersion:JSON.parse(await fs.readFile(path.join(sdk,'package.json'),'utf8')).version,vendor,developmentVendor,build:{actualAPIHash:api.actualAPIHash,engineTemplateSha256:templateHash,sourceCertified:!!(engineReport&&isSourceCertified(engineReport)),provenance:'exact-template-and-native-api-capture',...(engineReport?{engineReportSha256:sha(await fs.readFile(engineReportPath)),engineSource:engineReport.source,godotSource:engineReport.godotSource,recipeSha256:engineReport.recipeSha256}:{} )}});
 await writeFullEngineOutputs(dist,release.outputs);fullRelease=release.manifest;
 await fs.rm(path.join(dist,'api/capture'),{recursive:true,force:true});
}
// Ship license text beside the public bundle, without duplicating model assets.
for(const source of JSON.parse(await fs.readFile(path.join(app,"third-party/sources.json"),"utf8"))){
  if(!/(?:license|readme)/i.test(source.local))continue;
  const destination=path.join(dist,source.local);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(path.join(app,source.local),destination);
}
await buildDemoRuntime(dist);
await buildFrontend(dist);
await fs.mkdir(path.join(dist,'assets'),{recursive:true});
for(const name of ['LICENSE','ThirdPartyNotices.txt'])await fs.copyFile(path.join(app,'node_modules/monaco-editor',name),path.join(dist,'assets','monaco-'+name+(name.endsWith('.txt')?'':'.txt')));
const payloads={};for(const name of ['engine/game.js','engine/game.wasm','types.json','compiler.worker.js','catalog.json','demo-release.json','demo-runtime.js','demo-resources.pck','demo-api.d.ts']){const bytes=await fs.readFile(path.join(dist,name));payloads[name]={sha256:sha(bytes),bytes:bytes.length};}
await verifyTemplate();
await write('manifest.json',JSON.stringify({schemaVersion:2,runtimeProfile:'full-engine-v1',engineRelease:'engine-release.json',engineReleaseId:fullRelease.id,engineTemplateSha256:templateHash,payloads},null,2));
console.log(`Playground built: ${dist}`);
