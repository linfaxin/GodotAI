#!/usr/bin/env node
/** Measure the exact archive bound by a build report; never estimates WASM size. */
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync,brotliCompressSync,brotliDecompressSync,constants} from 'node:zlib';
import {options} from '../release/web-release-utils.mjs';
import {getEngineProfile} from '../release/engine-profiles.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function unzip(archive,args){const result=spawnSync('unzip',[...args,archive],{maxBuffer:256*1024*1024});if(result.error||result.status!==0)throw Error('E_MEASURE_ARCHIVE: '+(result.error?.message??result.stderr?.toString()));return result.stdout;}
function sectionSizes(bytes){
 let cursor=8;const result=[];const names=['custom','type','import','function','table','memory','global','export','start','element','code','data','data_count','tag'];
 const uleb=()=>{let value=0,shift=0,byte;do{if(cursor>=bytes.length||shift>49)throw Error('E_MEASURE_WASM_SECTION');byte=bytes[cursor++];value+=(byte&127)*2**shift;shift+=7;}while(byte&128);return value;};
 while(cursor<bytes.length){const start=cursor,id=bytes[cursor++],size=uleb(),payload=cursor;if(payload+size>bytes.length)throw Error('E_MEASURE_WASM_SECTION');let custom;if(id===0){const length=uleb();if(cursor+length>payload+size)throw Error('E_MEASURE_WASM_SECTION');custom=bytes.subarray(cursor,cursor+length).toString('utf8');}result.push({section:names[id]??id,...(custom?{custom}:{}),bytes:size,totalBytes:payload-start+size});cursor=payload+size;}
 return result;
}
export async function measureBrowserEngine(configuration){
 if(!configuration.report)throw Error('E_MEASURE_OPTION: --report is required');
 const reportPath=resolve(configuration.report),reportBytes=await readFile(reportPath),report=JSON.parse(reportBytes);
 if(report.kind!=='godot-js-browser-engine-build'||!['built','existing-development'].includes(report.status))throw Error('E_MEASURE_REPORT: Expected a completed engine build report');
 if(report.runtimeProfile&&report.runtimeProfile!=='legacy-profiles-v1')getEngineProfile(report.runtimeProfile);
 if(!report.template?.path||!report.template.sha256)throw Error('E_MEASURE_REPORT: Missing archive identity');
 const archive=resolve(dirname(reportPath),report.template.path),archiveBytes=await readFile(archive);
 if(sha(archiveBytes)!==report.template.sha256)throw Error('E_MEASURE_ARCHIVE: Archive differs from build report');
 const names=unzip(archive,['-Z1']).toString('utf8').trim().split('\n'),matches=names.filter(name=>name==='godot.wasm'||name.endsWith('/godot.wasm'));
 if(matches.length!==1||matches[0].startsWith('/')||matches[0].split('/').includes('..'))throw Error('E_MEASURE_ARCHIVE: Expected one safe godot.wasm entry');
 // unzip places the member after the archive; avoid shell interpolation entirely.
 const extracted=spawnSync('unzip',['-p',archive,matches[0]],{maxBuffer:256*1024*1024});
 if(extracted.error||extracted.status!==0)throw Error('E_MEASURE_ARCHIVE: Cannot read WASM');
 const wasm=extracted.stdout;
 if(!wasm.subarray(0,8).equals(Buffer.from([0,97,115,109,1,0,0,0]))||!WebAssembly.validate(wasm))throw Error('E_MEASURE_WASM: Invalid WebAssembly module');
 const gzip=gzipSync(wasm,{level:9}),brotli=brotliCompressSync(wasm,{params:{[constants.BROTLI_PARAM_QUALITY]:11}});
 if(!gunzipSync(gzip).equals(wasm)||!brotliDecompressSync(brotli).equals(wasm))throw Error('E_MEASURE_DECODE: Compression roundtrip changed bytes');
 const sizes=Object.fromEntries(Object.entries({raw:wasm,gzip9:gzip,brotli11:brotli}).map(([key,value])=>[key,{bytes:value.length,MB:value.length/1e6,MiB:value.length/1048576,sha256:sha(value),percentOfRaw:100*value.length/wasm.length}]));
 const result={schemaVersion:1,kind:'godot-js-browser-engine-measurement',status:'passed',measuredAt:new Date().toISOString(),runtimeProfile:report.runtimeProfile??'unrecorded',target:report.engineTarget,sourceCertified:report.sourceCertified===true,certificationScope:'sourceCertified only references the supplied build report flag. Measurement checks archive identity, valid WASM and compression roundtrips; it does not recertify source or certify browser/product behavior.',buildReport:{path:reportPath,sha256:sha(reportBytes)},source:report.source?{commit:report.source.commit,snapshotHash:report.source.snapshotHash}:undefined,godotSource:report.godotSource?{commit:report.godotSource.commit,snapshotHash:report.godotSource.snapshotHash}:undefined,recipeSha256:report.recipeSha256,requestedArgs:report.requestedArgs??report.recipe?.args,resolvedBuildOptions:report.resolvedBuildOptions,resolvedFeatures:report.resolvedFeatures,modules:report.modules,toolchains:report.toolchains,compression:{gzip:{level:9},brotli:{quality:11},node:process.version,zlib:process.versions.zlib,brotliVersion:process.versions.brotli},archive:{path:archive,bytes:archiveBytes.length,sha256:sha(archiveBytes),entry:matches[0]},sizes,sections:sectionSizes(wasm)};
 if(configuration.performance){const path=resolve(configuration.performance),bytes=await readFile(path);result.performance={source:path,sha256:sha(bytes),measurements:JSON.parse(bytes)};}
 if(configuration.baseline){
  const baseline=JSON.parse(await readFile(resolve(configuration.baseline),'utf8'));if(baseline.kind!=='godot-js-browser-engine-measurement')throw Error('E_MEASURE_BASELINE');
  const toolchainsComparable=Boolean(baseline.toolchains?.emscripten&&result.toolchains?.emscripten)&&JSON.stringify(baseline.toolchains)===JSON.stringify(result.toolchains)&&JSON.stringify(baseline.compression)===JSON.stringify(result.compression);
  const hasSnapshot=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const sourceMatches={godotjs:hasSnapshot(baseline.source?.snapshotHash)&&hasSnapshot(result.source?.snapshotHash)&&baseline.source.snapshotHash===result.source.snapshotHash,godot:hasSnapshot(baseline.godotSource?.snapshotHash)&&hasSnapshot(result.godotSource?.snapshotHash)&&baseline.godotSource.snapshotHash===result.godotSource.snapshotHash};
  const sameSource=sourceMatches.godotjs&&sourceMatches.godot,comparable=toolchainsComparable&&sameSource;
  const reasons=[];if(!toolchainsComparable)reasons.push('Compiler/compression toolchains differ or are missing.');if(!sameSource)reasons.push('GodotJS/Godot source snapshots differ or are missing.');
  result.comparison={baseline:resolve(configuration.baseline),toolchainsComparable,sourceMatches,sameSource,comparable,note:comparable?'Source snapshots and compiler/compression toolchains match; inspect requested/resolved flags to confirm the intended experimental factor.':reasons.join(' ')+' Size deltas are observational and must not be attributed solely to a selected build flag.',deltaBytes:Object.fromEntries(Object.keys(sizes).map(key=>[key,sizes[key].bytes-baseline.sizes[key].bytes]))};
 }

 if(configuration.out){const out=resolve(configuration.out);await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(result,null,2)+'\n');}
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const result=await measureBrowserEngine(options(process.argv.slice(2)));console.log(JSON.stringify(result,null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
