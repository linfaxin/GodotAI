import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {canonical,digest} from '../site-evidence.mjs';
/** Small byte-backed contract fixture. No Native execution or timing claim. */
export async function performanceSiteFixture(directory,{demos=['scene']}={}){
 const save=async(name,value)=>{const filename=path.join(directory,name);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,JSON.stringify(value,null,2)+'\n');};
 const asset=async(name)=>{const bytes=Buffer.from('contract fixture: '+name);await mkdir(path.dirname(path.join(directory,name)),{recursive:true});await writeFile(path.join(directory,name),bytes);return {path:name,sha256:digest(bytes),bytes:bytes.length};};
 const sourceInputs={'sdk/src/index.ts':digest('SDK source')},outputs={'sdk/dist/index.js':{sha256:digest('SDK output'),bytes:10}};
 const api={};for(const naming of ['snake','camel'])api[naming]={actualAPIHash:digest('API '+naming),bindingVersion:'1',namingVersion:'1',codegenVersion:'1',declarationsSnapshot:await asset('api/'+naming+'.json'),typeSnapshot:await asset('types.'+naming+'.json')};
 const release={schemaVersion:2,id:digest('current release'),runtimeProfile:'full-engine-v1',runtimeFamily:'native',runtimeAbi:{protocolVersion:2,host:1,audio:1,presentation:1},engine:{version:'4.6.1',modules:['GodotJS'],javascript:await asset('engine/game.js'),wasm:await asset('engine/game.wasm'),worklets:[]},api:{namingProfiles:api},sdk:{version:'1',moduleExports:{'react':'React'},moduleContract:{version:1},runtimeModules:{react:await asset('.playground/runtime-modules/react.js')},vendors:{production:await asset('vendor.production.js'),development:await asset('vendor.development.js')}},build:{commit:'current',sdkBuild:{sourceInputs,outputs,sourceSnapshotHash:digest(canonical(sourceInputs)),outputSnapshotHash:digest(canonical(outputs))}}};
 const site={schemaVersion:3,runtimeProfile:release.runtimeProfile,engineReleaseId:release.id,engineTarget:'template_debug'};
 await asset('engine/game.pck');
 await save('engine-release.json',release);await save('manifest.json',site);
 await save('demo-release.json',{schemaVersion:1,runtimeProfile:release.runtimeProfile,demoApiVersion:1,assetIds:['fixture'],runtime:await asset('demo-runtime.js'),resources:await asset('demo-resources.pck'),types:await asset('demo-api.d.ts')});
 await save('catalog.json',demos.map(id=>({id,source:'export const fixture = '+JSON.stringify(id)+';'})));
 for(const id of demos)await save('examples/'+id+'.project.json',{schemaVersion:3,engineProfile:release.runtimeProfile,demoApiVersion:1,runtime:'react',demoId:id,entry:'/src/App.tsx',files:{'/src/App.tsx':'export const App = () => null;','/project.godot':'fixture','/README.md':'Documentation'},controls:{},mode:'production'});
 return {directory,save,release,site};
}
