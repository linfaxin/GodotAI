// Explicit online smoke; unit tests remain entirely fixture-backed.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import ts from 'typescript';
import {build} from 'esbuild';
import {createResolver} from '../dist/resolve.js';
import {createJsDelivrTransport} from '../dist/transport.js';
import {createSnapshot} from '../dist/snapshot.js';

const args=process.argv.slice(2),outIndex=args.indexOf('--out'),out=outIndex<0?undefined:args[outIndex+1];
const cases=[
  {name:'clsx',version:'2.1.1',source:'import {clsx} from "clsx";export const result=clsx("a",false,"b");',expected:'a b'},
  {name:'camel-case',version:'4.1.2',source:'import {camelCase} from "camel-case";export const result=camelCase("hello world");',expected:'helloWorld'},
];
const report={schemaVersion:1,status:'running',validatedAt:new Date().toISOString(),runtime:process.version,transport:'raw-jsdelivr-npm',cases:[]};
for(const input of cases){
  let phase='resolve';const requests=[];
  const transport=createJsDelivrTransport({fetch:async(url,init)=>{
    const response=await fetch(url,init);requests.push({phase,url:String(url),status:response.status});return response;
  }});
  const snapshot=await createSnapshot({revision:`cdn-${input.name}`,files:{'/src/App.ts':input.source},config:{schemaVersion:1,entry:'/src/App.ts',dependencies:{[input.name]:input.version},mode:'production',profileId:'core-ui-v1'}});
  const release={id:'resolver-cdn-smoke-neutral-v1',specifiers:{}};
  const resolver=createResolver({...transport,typescript:ts});
  const result=await resolver.resolveProject(snapshot,release,{signal:AbortSignal.timeout(60000)});
  assert.deepEqual(result.typeGraph.unresolved,[]);
  phase='replay';
  const replay=await createResolver({fetchFile:transport.fetchFile,typescript:ts,resolveVersion:()=>{throw Error('Version selection is forbidden during lock replay');}}).resolveProject({...snapshot,lock:result.lock},release,{signal:AbortSignal.timeout(60000)});
  assert.equal(replay.hash,result.hash);assert.deepEqual(replay.lock,result.lock);
  const bundle=await build({entryPoints:result.runtimeGraph.entries,bundle:true,write:false,format:'cjs',platform:'neutral',target:'es2022',logLevel:'silent',logOverride:{'unsupported-require-call':'error','unsupported-dynamic-import':'error','indirect-require':'error'},plugins:[{name:'locked-cdn-graph',setup(api){
    api.onResolve({filter:/.*/},args=>{
      if(args.kind==='entry-point')return{path:args.path,namespace:'locked'};
      const mode=args.kind.startsWith('require')?'require':'import';
      const edge=result.runtimeGraph.edges.find(edge=>edge.importer===args.importer&&edge.specifier===args.path&&edge.mode===mode);
      assert(edge,`Every bundle import must exist in the resolved graph: ${args.importer} -> ${args.path}`);
      assert(!edge.external,'The CDN smoke has no host module externals');return{path:edge.resolved,namespace:'locked'};
    });
    api.onLoad({filter:/.*/,namespace:'locked'},args=>{
      const bytes=result.files[args.path];assert(bytes,`Missing locked bytes for ${args.path}`);
      return{contents:bytes,loader:args.path.endsWith('.json')?'json':/\.tsx$/.test(args.path)?'tsx':/\.[cm]?ts$/.test(args.path)?'ts':'js'};
    });
  }}]});
  const module={exports:{}};new Function('module','exports',bundle.outputFiles[0].text)(module,module.exports);
  assert.equal(module.exports.result,input.expected);
  report.cases.push({name:input.name,version:input.version,sourceHash:snapshot.sourceHash,resolutionHash:result.hash,replayHash:replay.hash,output:module.exports.result,
    instances:Object.values(result.instances).map(instance=>({id:instance.id,name:instance.name,version:instance.version,peerBindings:instance.peerBindings,dependencies:instance.dependencies})),
    runtimeGraph:result.runtimeGraph,typeGraph:result.typeGraph,lock:result.lock,requests});
}
report.status='passed';
if(out)await writeFile(resolve(out),JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,cases:report.cases.map(input=>({name:input.name,instances:input.instances.map(instance=>`${instance.name}@${instance.version}`),files:Object.keys(input.lock.files).length,runtimeNodes:Object.keys(input.runtimeGraph.nodes).length,typeNodes:Object.keys(input.typeGraph.nodes).length,output:input.output,replayMatches:input.resolutionHash===input.replayHash}))}));
