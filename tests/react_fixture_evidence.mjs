import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

export async function sdkFingerprint(){
  const root=fileURLToPath(new URL('../',import.meta.url)),inputs={};
  const visit=async directory=>{for(const item of await fs.readdir(path.join(root,directory),{withFileTypes:true})){const filename=`${directory}/${item.name}`;if(item.isDirectory())await visit(filename);else if(item.isFile())inputs[filename]=await fileSha256(path.join(root,filename));}};
  for(const pkg of ['scripts/jsb.react','scripts/jsb.react-build']){
    for(const subdirectory of ['src','dist'])await visit(`${pkg}/${subdirectory}`);
    for(const filename of ['package.json','tsconfig.json','build.mjs'])try{inputs[`${pkg}/${filename}`]=await fileSha256(path.join(root,pkg,filename));}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  inputs['pnpm-lock.yaml']=await fileSha256(path.join(root,'pnpm-lock.yaml'));
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(inputs).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
}

export async function isolateGodotEditor(){
  const xdgConfigHome=await fs.mkdtemp(path.join(os.tmpdir(),'godot-react-qa-editor-'));
  const directory=path.join(xdgConfigHome,'godot'),editorSettings=path.join(directory,'editor_settings-4.6.tres');
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(editorSettings,'[gd_resource type="EditorSettings" format=3]\n\n[resource]\nGodotJS/debugger/editor_port = 0\n');
  process.env.XDG_CONFIG_HOME=xdgConfigHome;
  return {xdgConfigHome,editorSettings,editorDebuggerPort:0};
}
export function assertNoInspectorTransportErrors(output){
  if(/\[JSDebugger\][^\r\n]*(?:\[Error\]|LWS[^\r\n]*(?:\bE:|bind ERROR))/i.test(output))throw Error('Unexpected inspector transport error in certification output');
}

export async function fileSha256(filename){
  const hash=createHash('sha256');for await(const bytes of createReadStream(filename))hash.update(bytes);return hash.digest('hex');
}
export async function captureNativeCertificate(filename){
  const binary=await fs.realpath(filename),reportPath=path.resolve(path.dirname(binary),'../react-native-build.json');
  const report=JSON.parse(await fs.readFile(reportPath,'utf8'));
  if(report.status!=='built')throw Error(`Native binary is not frozen: ${report.status}`);
  const binarySha256=await fileSha256(binary);
  if(report.binarySha256!==binarySha256)throw Error('Native binary differs from its completed build report');
  return {binary,binarySha256,reportPath,sourceCommit:report.sourceCommit,sourceSnapshotHash:report.sourceSnapshotHash,engine:report.engine==='qjs'?'quickjs':report.engine,flags:report.flags,godotBuildRecipe:report.godotBuildRecipe?.kind??report.godotBuildRecipe,godotBuildRecipeSha256:report.godotBuildRecipeSha256};
}
export async function assertNativeCertificate(certificate){
  const current=await captureNativeCertificate(certificate.binary);
  if(current.binarySha256!==certificate.binarySha256||current.sourceCommit!==certificate.sourceCommit||current.sourceSnapshotHash!==certificate.sourceSnapshotHash||current.engine!==certificate.engine||JSON.stringify(current.flags)!==JSON.stringify(certificate.flags)||current.godotBuildRecipeSha256!==certificate.godotBuildRecipeSha256)throw Error('Native certification tuple changed during the test run');
}
