import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateExecutionContract} from '../../../scripts/release/execution-contract.mjs';

export function productOutputPath({app,runtimeProfile='full-engine-v1',target='template_debug',moduleMode='baseline',lto='none',executionModel='window',artifactDirectory,explicitOutput}){
  const worker=executionModel!=='window',dimension=runtimeProfile==='engine-2d-v1'?'2d':'full',mode=target==='template_debug'?'debug':'release';
  const standard=moduleMode==='baseline'&&lto==='none';
  const fallback=standard?path.join(app,worker?'dist-worker-'+dimension+'-'+mode:runtimeProfile==='full-engine-v1'&&mode==='debug'?'dist':'dist-'+dimension+'-'+mode):path.join(artifactDirectory,'site');
  const result=path.resolve(explicitOutput??fallback);
  if(worker){
    const oldDefaults=['dist','dist-full-debug','dist-full-release','dist-2d-debug','dist-2d-release'].map(name=>path.resolve(app,name));
    if(oldDefaults.includes(result))throw Error('E_WORKER_CANDIDATE_OUTPUT: Worker candidates must not replace an existing default product');
  }
  return result;
}
export function productExportPreset({template,execution}){
  validateExecutionContract(execution);
  return '[preset.0]\nname="Playground Web"\nplatform="Web"\nrunnable=true\nexport_filter="all_resources"\ninclude_filter="generated/*.js,shaders/*.gdshader"\nexclude_filter=""\nexport_path=""\n\n[preset.0.options]\ncustom_template/debug='+JSON.stringify(template)+'\ncustom_template/release='+JSON.stringify(template)+'\nvariant/extensions_support=false\nvariant/thread_support='+execution.wasmThreads+'\nvram_texture_compression/for_desktop=true\nvram_texture_compression/for_mobile=false\nhtml/canvas_resize_policy=2\nprogressive_web_app/enabled=false\n';
}
/** Godot's Web exporter renames archive paths with file.replace("godot",name)
 * and copies their bytes. Validate those actual copied bytes before relabeling
 * their location for the product descriptor. */
export async function exportedExecution({execution,siteDirectory,exportDirectory='engine',exportName='game'}){
  validateExecutionContract(execution,{requireWorkerAssets:true});
  const workerAssets=[];
  for(const asset of execution.workerAssets??[]){
    const exported=path.posix.join(exportDirectory,asset.path.replaceAll('godot',exportName));
    const bytes=await readFile(path.resolve(siteDirectory,exported)),sha256=createHash('sha256').update(bytes).digest('hex');
    if(sha256!==asset.sha256||bytes.length!==asset.bytes)throw Error('E_EXPORTED_WORKER_IDENTITY: Exported bytes differ from source-bound template '+asset.path);
    workerAssets.push({path:exported,sha256,bytes:bytes.length,role:asset.role});
  }
  const result={...execution,workerAssets};validateExecutionContract(result,{requireWorkerAssets:true});return result;
}
