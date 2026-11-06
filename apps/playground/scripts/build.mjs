import {promises as fs} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {build} from "esbuild";
import ts from "typescript";
import {catalog} from "../src/catalog.ts";
import {prepareAssets} from "./prepare-assets.mjs";
import {buildFrontend} from "./build-frontend.mjs";
import {writeTypeSnapshot} from "./build-shell.mjs";

const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),repo=path.resolve(app,"../.."),project=path.join(app,"project"),dist=path.join(app,"dist");
const sdk=path.join(repo,"scripts/jsb.react"),host=process.env.GODOT??path.join(repo,"tests/bin/godot-host-qjs");
const template=process.env.GODOT_WEB_TEMPLATE;
if(!template||!path.isAbsolute(template))throw Error("Set GODOT_WEB_TEMPLATE to the absolute path of a single-thread GodotJS web template ZIP built from this checkout. See README.md.");
await fs.access(template);
const run=(bin,args,cwd=app)=>{const r=spawnSync(bin,args,{cwd,encoding:"utf8",maxBuffer:32*1024*1024}),output=(r.stdout??"")+(r.stderr??"");const errors=output.split("\n").filter(line=>/^(?:ERROR|SCRIPT ERROR):/.test(line)&&!line.includes("compiled without fontconfig"));if(r.status!==0||errors.length)throw Error(`${bin} ${args.join(" ")} failed (${r.status})\n${output}`);return output;};
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const write=(name,text)=>fs.writeFile(path.join(dist,name),text);
await fs.mkdir(dist,{recursive:true});await fs.mkdir(path.join(project,".godot/GodotJS"),{recursive:true});await fs.mkdir(path.join(project,"generated"),{recursive:true});
console.log("Building React SDK");console.log(run(process.execPath,["build.mjs"],sdk));
if(!process.argv.includes("--skip-assets"))await prepareAssets();
const defines={"process.env.NODE_ENV":'"production"'};
await build({entryPoints:[path.join(app,"src/vendor.ts")],outfile:path.join(project,"generated/vendor.js"),bundle:true,platform:"neutral",format:"cjs",target:"es2022",define:defines,external:["godot","godot-jsb"],inject:[path.join(sdk,"dist/internal/performance.mjs")],sourcemap:"external"});
const hostSource=await fs.readFile(path.join(app,"src/host.ts"),"utf8");
await fs.writeFile(path.join(project,"host.ts"),hostSource);
await fs.writeFile(path.join(project,".godot/GodotJS/host.js"),ts.transpileModule(hostSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText);
const defaults={},publicCatalog=[];
for(const demo of catalog){const source=await fs.readFile(path.join(app,"src/demos",demo.file),"utf8"),controls=Object.fromEntries(demo.controls.map(c=>[c.key,c.value]));const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;defaults[demo.id]={code,controls};publicCatalog.push({...demo,source});}
await fs.writeFile(path.join(project,"generated/defaults.js"),`module.exports=${JSON.stringify(defaults)};\n`);
await write("catalog.json",JSON.stringify(publicCatalog));
console.log("Importing playground resources");console.log(run(host,["--headless","--editor","--path",project,"--import"]));
await fs.mkdir(path.join(dist,"engine"),{recursive:true});
await fs.writeFile(path.join(project,"export_presets.cfg"),`[preset.0]\nname="Playground Web"\nplatform="Web"\nrunnable=true\nexport_filter="all_resources"\ninclude_filter="generated/*.js,shaders/*.gdshader"\nexclude_filter=""\nexport_path=""\n\n[preset.0.options]\ncustom_template/debug=${JSON.stringify(template)}\ncustom_template/release=${JSON.stringify(template)}\nvariant/extensions_support=false\nvariant/thread_support=false\nvram_texture_compression/for_desktop=true\nvram_texture_compression/for_mobile=false\nhtml/canvas_resize_policy=2\nprogressive_web_app/enabled=false\n`);
console.log("Exporting single-thread GodotJS Web");console.log(run(host,["--headless","--path",project,"--export-debug","Playground Web",path.join(dist,"engine/game.html")]));
await fs.cp(path.join(app,"web"),dist,{recursive:true});
// Ship license text beside the public bundle, without duplicating model assets.
for(const source of JSON.parse(await fs.readFile(path.join(app,"third-party/sources.json"),"utf8"))){
  if(!/(?:license|readme)/i.test(source.local))continue;
  const destination=path.join(dist,source.local);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(path.join(app,source.local),destination);
}
await buildFrontend(dist);
await fs.mkdir(path.join(dist,'assets'),{recursive:true});
for(const name of ['LICENSE','ThirdPartyNotices.txt'])await fs.copyFile(path.join(app,'node_modules/monaco-editor',name),path.join(dist,'assets','monaco-'+name+(name.endsWith('.txt')?'':'.txt')));
await writeTypeSnapshot(dist);
const fileSizes={};for(const name of ["game.wasm","game.pck"]){fileSizes[`engine/${name}`]=(await fs.stat(path.join(dist,"engine",name))).size;}
await write("engine.json",JSON.stringify({executable:"engine/game",mainPack:"engine/game.pck",fileSizes,args:[]}));
const payloads={};for(const name of ["engine/game.js","engine/game.wasm","engine/game.pck","types.json","compiler.worker.js","catalog.json"])payloads[name]={sha256:sha(await fs.readFile(path.join(dist,name))),bytes:(await fs.stat(path.join(dist,name))).size};
await write("manifest.json",JSON.stringify({schemaVersion:1,engineVersion:run(host,["--version"]).trim(),engineTemplateSha256:sha(await fs.readFile(template)),profile:"showcase-v1",profileHash:(await import(path.join(sdk,"dist/schema/showcase.js"))).SHOWCASE_PROFILE_HASH,payloads,upstream:JSON.parse(await fs.readFile(path.join(app,"third-party/sources.json"),"utf8"))},null,2));
console.log(`Playground built: ${dist}`);
