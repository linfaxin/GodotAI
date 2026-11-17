#!/usr/bin/env node
/** Apply the repository's complete native integration before a normal SCons build. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {patchNativeObserverFile,nativeObserverBuildProof,NATIVE_OBSERVER_PATHS} from '../release/patch-native-observer.mjs';
import {patchNativeLifecycleFile,nativeLifecycleBuildProof,NATIVE_LIFECYCLE_PATHS} from '../release/patch-native-lifecycle.mjs';
import {patchArtifactSetMount,artifactSetMountBuildProof} from '../release/patch-artifact-set-mount.mjs';
import {MANAGED_SHUTDOWN_PATHS,patchManagedShutdownQueue,managedShutdownBuildProof} from '../release/patch-managed-shutdown-queue.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
export async function prepareNativeEngine(root,{out}={}){
 root=resolve(root);
 const paths=[...new Set([...NATIVE_OBSERVER_PATHS,...NATIVE_LIFECYCLE_PATHS])];
 const original=new Map(await Promise.all(paths.map(async path=>[path,await readFile(resolve(root,path),'utf8')])));
 const current=new Map(original),patches=[];
 const apply=async(path,patcher,implementationPath)=>{
  const before=current.get(path),result=patcher(path,before);
  current.set(path,result.code);
  patches.push({path,patchId:result.patchId,beforeSha256:sha(before),afterSha256:sha(result.code),changed:result.changed,
   implementation:{path:implementationPath,sha256:sha(await readFile(resolve(repository,implementationPath)))}});
 };
 for(const path of NATIVE_OBSERVER_PATHS)await apply(path,patchNativeObserverFile,'scripts/release/patch-native-observer.mjs');
 for(const path of NATIVE_LIFECYCLE_PATHS)await apply(path,patchNativeLifecycleFile,'scripts/release/patch-native-lifecycle.mjs');
 await apply('main/main.cpp',(_path,value)=>patchArtifactSetMount(value),'scripts/release/patch-artifact-set-mount.mjs');
 for(const path of MANAGED_SHUTDOWN_PATHS)await apply(path,patchManagedShutdownQueue,'scripts/release/patch-managed-shutdown-queue.mjs');
 // Validate every input before mutating any source file. A concurrently edited
 // tree is never overwritten by a stale preparation pass.
 for(const path of paths)if(await readFile(resolve(root,path),'utf8')!==original.get(path))throw Error('E_NATIVE_SOURCE_CHANGED: '+path);
 for(const path of paths)if(current.get(path)!==original.get(path))await writeFile(resolve(root,path),current.get(path));
 const report={schemaVersion:1,kind:'godotjs-native-integration',patches,...nativeObserverBuildProof(patches),...nativeLifecycleBuildProof(patches),...artifactSetMountBuildProof(patches),...managedShutdownBuildProof(patches)};
 if(out){await mkdir(dirname(resolve(out)),{recursive:true});await writeFile(resolve(out),JSON.stringify(report,null,2)+'\n');}
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),option=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
 const root=option('--godot-source');if(!root)throw Error('Usage: node scripts/test/prepare-native-engine.mjs --godot-source DIR [--out REPORT]');
 const result=await prepareNativeEngine(root,{out:option('--out')});
 console.log(JSON.stringify({status:'prepared',observerAbi:result.observerAbi,nativeLifecycleAbi:result.nativeLifecycleAbi,artifactSetAbi:result.artifactSetAbi,files:[...new Set(result.patches.map(item=>item.path))]}));
}
