import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {captureNativeCertificate,assertNativeCertificate,isolateGodotEditor,assertNoInspectorTransportErrors,sdkFingerprint} from '../react_fixture_evidence.mjs';
const require=createRequire(import.meta.url);
const esbuild=require('../../scripts/jsb.react/node_modules/esbuild');
const binary=process.argv[2];if(!binary)throw Error('Usage: node tests/react_source_maps/run.mjs /absolute/path/to/godot [project-directory]');
const fixture=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(fixture,'../..');
const project=process.argv[3]??await fs.mkdtemp(path.join(os.tmpdir(),'godot-react-source-map-'));
const output=path.join(project,'.godot/GodotJS');await fs.mkdir(output,{recursive:true});
const lines={};
for(const name of ['caught','uncaught']){
  const source=await fs.readFile(path.join(fixture,`${name}.tsx`),'utf8');
  lines[name]=source.split('\n').findIndex(line=>line.includes(`REACT_MAP_${name.toUpperCase()}_AUTHOR_THROW`))+1;
  await fs.writeFile(path.join(project,`${name}.tsx`),source);
}
for(const [name,entry,minify]of [['caught','caught',false],['caught.min','caught',true],['uncaught','uncaught',false]])await esbuild.build({
  entryPoints:[path.join(project,`${entry}.tsx`)],outfile:path.join(output,`${name}.js`),bundle:true,format:'cjs',platform:'neutral',target:'es2022',jsx:'automatic',sourcemap:'external',sourcesContent:true,minify,
  nodePaths:[path.join(repo,'scripts/jsb.react/node_modules')],define:{'process.env.NODE_ENV':JSON.stringify('production')},
});
const source=`declare const require:(name:string)=>any;
const G=require('godot');
const invoke=(target:any,name:string,...args:any[])=>{const method=target[name]??target[name.replace(/_([a-z])/g,(_:string,c:string)=>c.toUpperCase())];return method.apply(target,args);};
export default class SourceMapProbe extends G.Node {
  private elapsed=0;
  _ready(){
    const bridge=require('godot-jsb').internal.react;
    for(const name of ['caught','caught.min'])try{require('res://.godot/GodotJS/'+name+'.js');}catch(error){
      const raw=String((error as any)?.stack??error),mapped=bridge.formatStack(raw);
      console.log('REACT_SOURCE_MAP_CAUGHT '+JSON.stringify({name,message:String(error),raw,mapped}));
    }
    require('res://.godot/GodotJS/uncaught.js');
  }
  _process(delta:number){this.elapsed+=delta;if(this.elapsed>0.25)invoke(invoke(this,'get_tree'),'quit',0);}
}
`;
await fs.writeFile(path.join(project,'Probe.ts'),source);
const ts=require('../../scripts/jsb.react/node_modules/typescript');
const compiled=ts.transpileModule(source,{fileName:'Probe.ts',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
await fs.writeFile(path.join(output,'Probe.js'),compiled.outputText);
await fs.writeFile(path.join(project,'Main.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://Probe.ts" id="1"]\n[node name="SourceMapProbe" type="Node"]\nscript = ExtResource("1")\n');
await fs.writeFile(path.join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="React TSX source map negative QA"\nrun/main_scene="res://Main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/logger/source_map_enabled=true\nruntime/debugger/debugger_port=0\n');
if(process.argv.includes('--prepare-only')){console.log(JSON.stringify({prepared:true,project,lines}));process.exit(0);}
const nativeCertificate=await captureNativeCertificate(binary);
const sdkSourceHash=await sdkFingerprint();
const editorIsolation=await isolateGodotEditor();
await fs.writeFile(path.join(project,'native-certificate.json'),JSON.stringify(nativeCertificate,null,2));
const execute=(args,timeoutMs=20000)=>new Promise((resolve,reject)=>{
  const child=spawn(path.resolve(binary),args,{cwd:project,stdio:['ignore','pipe','pipe']});let log='';
  const collect=data=>{log+=String(data);process.stdout.write(String(data));};child.stdout.on('data',collect);child.stderr.on('data',collect);
  const timeout=setTimeout(()=>child.kill('SIGKILL'),timeoutMs);child.on('error',reject);child.on('exit',(code,signal)=>{clearTimeout(timeout);resolve({code,signal,log});});
});
const imported=await execute(['--headless','--editor','--path',project,'--import'],60000);
if(imported.code!==0)throw Error(`Source map probe import failed: ${imported.code}/${imported.signal}`);
assertNoInspectorTransportErrors(imported.log);
await assertNativeCertificate(nativeCertificate);
const result=await execute(['--headless','--path',project]);
await fs.writeFile(path.join(project,'source-map-probe.log'),result.log);
if(result.code!==0)throw Error(`Source map probe process failed: ${result.code}/${result.signal}`);
assertNoInspectorTransportErrors(result.log);
const records=result.log.split(/\r?\n/).flatMap(line=>{const marker='REACT_SOURCE_MAP_CAUGHT ',offset=line.indexOf(marker);return offset<0?[]:[JSON.parse(line.slice(offset+marker.length))];});
const atAuthor=(text,name)=>new RegExp(`${name}\\.tsx:${lines[name]}(?:[:)\\s]|$)`).test(text);
const caught=records.find(record=>record.name==='caught'),minified=records.find(record=>record.name==='caught.min');
if(!caught||!caught.message.includes('REACT_MAP_CAUGHT_AUTHOR_THROW')||!atAuthor(caught.mapped,'caught'))throw Error('Caught error did not map to its actual author TSX line');
if(!result.log.includes('REACT_MAP_UNCAUGHT_AUTHOR_THROW')||!atAuthor(result.log,'uncaught'))throw Error('Uncaught native exception did not map to its actual author TSX line');
if(!minified)throw Error('Missing compressed source-map probe');
const hasColumns=/caught\.min\.js:\d+:\d+/.test(minified.raw);
if(hasColumns?!atAuthor(minified.mapped,'caught'):!minified.mapped.includes('caught.min.js:'))throw Error('Compressed map must resolve with columns or preserve JS when the line is ambiguous');
await assertNativeCertificate(nativeCertificate);
const godotVersion=/Godot Engine v([^\s]+)/.exec(result.log)?.[1];
if(await sdkFingerprint()!==sdkSourceHash)throw Error("SDK changed during certification");
const report={passed:true,project,nativeCertificate,sdkSourceHash,editorIsolation,runtimeDebuggerPort:0,godotVersion,lines,caught,compressed:{rawHasColumn:hasColumns,...minified},uncaughtAuthorLineVerified:true,inspectorTransportErrorsRejected:true,scope:'Independent intentional exceptions; no application BootReport'};
await fs.writeFile(path.join(project,'source-map-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
