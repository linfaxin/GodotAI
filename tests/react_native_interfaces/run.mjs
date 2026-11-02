import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {buildProject,exportProject} from '../../scripts/jsb.react-build/dist/index.js';
import {captureNativeCertificate,assertNativeCertificate,isolateGodotEditor,assertNoInspectorTransportErrors,sdkFingerprint} from '../react_fixture_evidence.mjs';

const argv=process.argv.slice(2),binary=argv.shift();if(!binary)throw Error('Usage: node tests/react_native_interfaces/run.mjs /absolute/path/to/godot [project-directory] [--mode production|development] [--also-development-source]');
const fixture=path.dirname(fileURLToPath(import.meta.url));
const project=argv[0]&&!argv[0].startsWith('--')?argv.shift():await fs.mkdtemp(path.join(os.tmpdir(),'godot-react-rpc-'));
let sourceMode='production',alsoDevelopmentSource=false;
while(argv.length){const option=argv.shift();if(option==='--mode'){sourceMode=argv.shift();if(!['production','development'].includes(sourceMode))throw Error('Invalid --mode');}else if(option==='--also-development-source')alsoDevelopmentSource=true;else throw Error(`Unknown option ${option}`);}
const nativeCertificate=await captureNativeCertificate(binary);
const sdkSourceHash=await sdkFingerprint();
const editorIsolation=await isolateGodotEditor();
await fs.mkdir(project,{recursive:true});
await fs.writeFile(path.join(project,'native-certificate.json'),JSON.stringify(nativeCertificate,null,2));
for(const file of ['App.tsx','interface.json','verification.ts','godot-react.config.mjs','tsconfig.json','project.godot'])await fs.copyFile(path.join(fixture,file),path.join(project,file));
await fs.writeFile(path.join(project,'package.json'),JSON.stringify({name:'godot-react-rpc-fixture',private:true}));
const build=await buildProject({projectRoot:project,godot:path.resolve(binary),mode:sourceMode});
async function runPair(mode,buildMode,root,pack){
  await assertNativeCertificate(nativeCertificate);const label=`${mode}-${buildMode}`;
  const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});
  let listeningResolve;const listening=new Promise(resolve=>listeningResolve=resolve);
  const launch=role=>{
    const args=['--headless','--path',root,...(pack?['--main-pack',pack]:[]),'--','--godot-react-business-verify','--role='+role,'--port='+port,'--expected-mode='+buildMode];
    const child=spawn(path.resolve(binary),args,{cwd:root,stdio:['ignore','pipe','pipe']});
    let output='';const collect=bytes=>{const text=bytes.toString();output+=text;process.stdout.write(`[${label}/${role}] ${text}`);if(role==='server'&&output.includes('"event":"LISTEN"'))listeningResolve();};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    const deadline=setTimeout(()=>child.kill('SIGKILL'),20000);
    return {child,result:new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>{clearTimeout(deadline);resolve({role,code,signal,output});});})};
  };
  const server=launch('server');
  await Promise.race([listening,server.result.then(result=>{throw Error('Server exited before listening: '+result.output);})]);
  const client=launch('client');
  const results=await Promise.all([server.result,client.result]);
  for(const result of results){await fs.writeFile(path.join(project,`${label}-${result.role}.log`),result.output);if(result.code!==0||!result.output.includes('"event":"OK"'))throw Error(`${label}/${result.role} RPC failed: ${result.code}/${result.signal}`);}
  for(const result of results)assertNoInspectorTransportErrors(result.output);
  // These are deliberate transport negatives, not permission to ignore other
  // engine errors just because the application eventually returned a reply.
  for(const {role,output} of results){const lines=output.split(/\r?\n/),unexpected=[];for(let index=0;index<lines.length;index++){const line=lines[index];if(!line.startsWith('ERROR:'))continue;const known=/^ERROR: RPC 'rpcAuthority' is not allowed on node /.test(line)||/^ERROR: Unable to send packet on channel \d+, max channels: \d+$/.test(line)||/^ERROR: Node not found: "[^"\n]*\/WrongEndpoint" \(relative to "\/root"\)\.$/.test(line)||/^ERROR: Failed to get path from RPC: [^\n]*\/WrongEndpoint\.$/.test(line)||line==='ERROR: Invalid packet received. Requested node was not found.'||line==='ERROR: Parameter "node" is null.'&&lines[index+1]?.includes('process_simplify_path');if(!known)unexpected.push(line);}if(unexpected.length)throw Error(`${label}/${role}: unexpected native errors: ${unexpected.slice(0,3).join(' | ')}`);}
  const serverLog=results.find(result=>result.role==='server').output,clientLog=results.find(result=>result.role==='client').output;
  if(!/RPC 'rpcAuthority'.*not allowed/.test(serverLog))throw Error(`${mode}: missing native authority rejection evidence`);
  if(!/WrongEndpoint/.test(serverLog)||!/not found/i.test(serverLog))throw Error(`${mode}: missing native wrong-path rejection evidence`);
  if(!/Unable to send packet on channel/.test(clientLog))throw Error(`${mode}: missing native unnegotiated-channel rejection evidence`);
  const evidence=results.map(({role,code,output})=>{const records=output.split(/\r?\n/).flatMap(line=>{const marker='REACT_NATIVE_RPC ',at=line.indexOf(marker);return at<0?[]:[JSON.parse(line.slice(at+marker.length))];});const strict=records.find(record=>record.event==='STRICT_MODE')?.data,verified=records.find(record=>record.event==='OK')?.data;if(!strict||strict.mode!==buildMode||!verified||verified.ready!==1)throw Error(`${label}/${role}: missing mode or ready-once evidence`);return {role,code,strictMode:strict,verified};});
  await assertNativeCertificate(nativeCertificate);return {mode,buildMode,root,results:evidence};
}
const source=await runPair('source',sourceMode,project),runs=[{...source,generation:build.generation}];
if(alsoDevelopmentSource&&sourceMode!=='development'){const development=await buildProject({projectRoot:project,godot:path.resolve(binary),mode:'development'});runs.push({...await runPair('source','development',project),generation:development.generation});}
const exported=await exportProject({projectRoot:project,godot:path.resolve(binary),output:'rpc-fixture.pck'});
const empty=await fs.mkdtemp(path.join(os.tmpdir(),'godot-react-rpc-empty-'));
const packed=await runPair('packed','production',empty,exported.output);runs.push({...packed,generation:exported.generation});
await assertNativeCertificate(nativeCertificate);
if(await sdkFingerprint()!==sdkSourceHash)throw Error("SDK changed during certification");
const report={passed:true,project,nativeCertificate,sdkSourceHash,editorIsolation,runtimeDebuggerPort:0,target:build.manifest.target,react:build.manifest.react,runtimeAbi:build.manifest.runtimeAbi,nativeBridgeAbi:build.manifest.nativeBridgeAbi,sourceGeneration:build.generation,packedGeneration:exported.generation,packMode:'production',checks:['exactNativeLeaf','nativeScriptMetadata','DTO','stableNetworkId','capturedSenderPeerId','authorityRejected','wrongPathNotApplied','unnegotiatedChannelNotApplied','callLocal','transferChannel','unreliableOrdered','latestCommittedHandler','readyOnce','reconnect','formalExport','emptyDirectoryPckTwoProcess','inspectorTransportErrorsRejected',...(runs.some(run=>run.buildMode==='development')?['developmentStrictModeEffectReplay']:[])],runs};
await fs.writeFile(path.join(project,'rpc-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
