/** Actual Main::setup acceptance. Requires an engine built with the early mount
 * hook; an old engine is a failed test, never evidence that staging mounts PCKs. */
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createArtifactSet} from '../../packages/project-tools/dist/artifact-set.js';
import {prepareResourceUidCache} from '../../packages/project-tools/dist/resource-uids.js';
import {packProject,readPckIndex} from '../../packages/project-tools/dist/pck.js';
import {ARTIFACT_SET_INDEX,artifactBytesHash} from '../../packages/engine/dist/artifact-set.js';

const root=fileURLToPath(new URL('../../',import.meta.url)),args=process.argv.slice(2);
const option=(name,fallback)=>{const at=args.indexOf(name);return at<0?fallback:args[at+1];};
const godot=path.resolve(option('--godot',path.join(root,'tests/bin/godot-host-qjs')));
const directory=path.resolve(option('--out',path.join(root,'work/artifact-set-native'))),encoder=new TextEncoder();
await mkdir(directory,{recursive:true});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),binarySha256=digest(await readFile(godot)),buildReportPath=option('--engine-report');
let nativeBuild;
if(buildReportPath){const bytes=await readFile(buildReportPath);nativeBuild=JSON.parse(bytes);if(nativeBuild.status!=='built'||path.resolve(nativeBuild.binary)!==godot||nativeBuild.binarySha256!==binarySha256)throw Error('E_ARTIFACT_SET_NATIVE_SOURCE: report/binary differs');nativeBuild={path:path.resolve(buildReportPath),sha256:digest(bytes),sourceSnapshotHash:nativeBuild.sourceSnapshotHash,engine:nativeBuild.engine};}
const mainUid='uid://abcd',resourceUid='uid://abcde';
function sourceFiles(marker){
 const text=value=>encoder.encode(value),files=new Map([
  ['res://project.godot',text('config_version=5\n[application]\nconfig/name="ArtifactSet native"\nrun/main_scene="'+mainUid+'"\n[autoload]\nBoot="*res://autoload.gd"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')],
  ['res://autoload.gd',text('extends Node\nfunc _init():\n\tvar file=FileAccess.open('+JSON.stringify(marker)+',FileAccess.WRITE)\n\tfile.store_string("autoload-ran")\n\tassert(FileAccess.get_file_as_string("res://assets/data.txt")=="resource pack data")\n\tassert(ResourceLoader.exists("'+resourceUid+'"))\n')],
  ['res://main.tscn',text('[gd_scene load_steps=2 format=3 uid="'+mainUid+'"]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Root" type="Node"]\nscript=ExtResource("1")\n')],
  ['res://main.gd',text('extends Node\nfunc _ready():\n\tvar data=load("'+resourceUid+'")\n\tassert(data!=null)\n\tassert(data.resource_name=="from-resource-pack")\n\tassert(get_node("/root/Boot")!=null)\n\tprint("ARTIFACT_SET_EARLY_OK")\n\tget_tree().quit(0)\n')],
  ['res://.godot/exported/1/export-resource.tres',text('[gd_resource type="Resource" format=3 uid="'+resourceUid+'"]\n[resource]\nresource_name="from-resource-pack"\n')],
  ['res://assets/data.txt',text('resource pack data')],
  ['res://.godot/global_script_class_cache.cfg',text('list=Array[Dictionary]([])\n')],
 ]);
 const uids=prepareResourceUidCache(files);if(uids.diagnostics.some(d=>d.category==='error'))throw Error(JSON.stringify(uids.diagnostics));files.set('res://.godot/uid_cache.bin',uids.cache);return files;
}
function unpack(bytes){return new Map(readPckIndex(bytes).entries.map(entry=>[entry.path,bytes.slice(entry.offset,entry.offset+entry.bytes)]));}
async function writeSet(folder,set){await mkdir(path.join(folder,'packs'),{recursive:true});for(const item of [set.manifest.bootstrap,...set.manifest.resources])await writeFile(path.join(folder,item.path),set.packs.get(item.sha256));await writeFile(path.join(folder,'artifact-set.json'),JSON.stringify(set.manifest,null,2));}
async function corruptChild(set,mutate){
 const bootstrap=unpack(set.packs.get(set.manifest.bootstrap.sha256)),index=JSON.parse(new TextDecoder().decode(bootstrap.get(ARTIFACT_SET_INDEX))),old=index.resources[0];
 const oldBytes=set.packs.get(old.sha256),changed=mutate(oldBytes),sha256=await artifactBytesHash(changed);
 index.resources[0]={path:`packs/${sha256}.pck`,sha256,bytes:changed.length};for(const row of index.files)if(row.source===old.sha256)row.source=sha256;
 bootstrap.set(ARTIFACT_SET_INDEX,encoder.encode(JSON.stringify(index)));const packed=packProject(bootstrap).pack,bootHash=await artifactBytesHash(packed);
 return {manifest:{...set.manifest,bootstrap:{path:'application.pck',sha256:bootHash,bytes:packed.length},resources:index.resources},packs:new Map([[bootHash,packed],[sha256,changed]])};
}
const report={schemaVersion:1,kind:'godotjs-artifact-set-native-acceptance',status:'failed',godot,binarySha256,...(nativeBuild?{nativeBuild}:{}),cases:[]};
try{
 for(const kind of ['valid','data-checksum-corrupt','directory-flags','global-metadata-smuggle','valid-after-rejected-run']){
  const folder=await mkdtemp(path.join(directory,kind+'-')),marker=path.join(folder,'autoload.marker');
  let set=await createArtifactSet(sourceFiles(marker));
  if(kind==='data-checksum-corrupt')set=await corruptChild(set,bytes=>{const copy=bytes.slice(),entry=readPckIndex(bytes).entries.find(item=>item.bytes>0);copy[entry.offset]^=1;return copy;});
  if(kind==='directory-flags')set=await corruptChild(set,bytes=>{const copy=bytes.slice();new DataView(copy.buffer).setUint32(copy.length-4,1,true);return copy;});
  if(kind==='global-metadata-smuggle')set=await corruptChild(set,bytes=>{const files=unpack(bytes);files.set('res://project.godot',encoder.encode('config_version=5\n'));return packProject(files).pack;});
  await writeSet(folder,set);
  const run=spawnSync(godot,['--headless','--audio-driver','Dummy','--main-pack',path.join(folder,'application.pck'),'--quit-after','12'],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
  const output=(run.stdout??'')+(run.stderr??'');await writeFile(path.join(folder,'native.log'),output);
  const marked=await readFile(marker,'utf8').then(()=>true,()=>false),success=output.includes('ARTIFACT_SET_EARLY_OK');
  const passed=kind.startsWith('valid')?run.status===0&&marked&&success&&!output.includes('SCRIPT ERROR'):run.status!==0&&!marked&&!success&&output.includes('E_ARTIFACT_SET_MOUNT');
  report.cases.push({kind,status:passed?'passed':'failed',exitCode:run.status,signal:run.signal,autoloadRan:marked,mainSceneRan:success,folder});
  if(!passed)throw Error('Native early-mount case failed: '+kind+'; '+path.join(folder,'native.log'));
 }
 if(digest(await readFile(godot))!==binarySha256)throw Error('E_ARTIFACT_SET_NATIVE_SOURCE: binary changed during the probe');report.status='passed';
}catch(error){report.error=String(error);process.exitCode=1;}
await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
