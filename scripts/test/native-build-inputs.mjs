/** Capture the bytes consumed by the native module and its preset generators. */
import {readdirSync,readFileSync,existsSync,statSync,realpathSync} from 'node:fs';
import {join,relative,basename,resolve,delimiter} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const fail=message=>{throw Error('E_NATIVE_BUILD_INPUT: '+message);};
const roots=['bridge','compat','impl','internal','weaver','weaver-editor','tests','quickjs','quickjs-ng'];
const ignored=new Set(['.git','node_modules','.godot','__pycache__','work','.browser-engine']);
export const NATIVE_PRESET_INPUTS=Object.freeze([
 'scripts/out/jsb.runtime.bundle.js','scripts/out/jsb.editor.bundle.js',
 'scripts/out/jsb.runtime.bundle.d.ts','scripts/out/jsb.runtime.bundle.js.map',
 'scripts/out/jsb.editor.bundle.d.ts','scripts/out/jsb.editor.bundle.js.map',
 'scripts/typings/godot.minimal.d.ts','scripts/typings/godot.mix.d.ts','scripts/typings/godot.worker.d.ts',
 'scripts/presets/package.json.txt','scripts/presets/tsconfig.json.txt','scripts/presets/jsconfig.json.txt','scripts/presets/gdignore.txt',
]);
const nativeFile=name=>name==='SCsub'||(!/\.gen\.(?:h|cpp)$/.test(name)&&/\.(?:h|hpp|hxx|cpp|cc|cxx|c|inc|py|[sS])$/.test(name));
export function captureNativeModuleInputs(root){
 const paths=new Set();
 for(const item of readdirSync(root,{withFileTypes:true}))if(item.isFile()&&nativeFile(item.name))paths.add(join(root,item.name));
 const walk=directory=>{
  for(const entry of readdirSync(directory,{withFileTypes:true})){
   if(ignored.has(entry.name))continue;
   const path=join(directory,entry.name);
   if(entry.isDirectory())walk(path);
   else if(entry.isFile()&&(nativeFile(entry.name)||/\.[jt]s\.cs$/.test(entry.name)))paths.add(path);
  }
 };
 for(const name of roots)if(existsSync(join(root,name)))walk(join(root,name));
 for(const name of NATIVE_PRESET_INPUTS){const path=join(root,name);if(!existsSync(path))throw Error('E_NATIVE_BUILD_INPUT: Missing '+name);paths.add(path);}
 return Object.fromEntries([...paths].map(path=>[relative(root,path).replaceAll('\\','/'),path]).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,path])=>[key,hash(readFileSync(path))]));
}
/** Conservative closure of exposed include trees and the selected linked files.
 * Object files, other platform libraries and downloaded archives are not inputs.
 * OS headers/libraries and compiler runtime support remain a separate boundary. */
export function captureNativeDependencies(root,{engine,platform='linuxbsd',arch='x86_64'}={}){
 if(!['qjs','v8'].includes(engine))fail('Unknown dependency engine');
 const target={engine,platform,arch},dependencies={},files={};
 const add=(name,role)=>{
  const path=join(root,name);if(!existsSync(path)||!statSync(path).isFile())fail('Missing dependency '+name);
  if(realpathSync(path)!==resolve(path))fail('Dependency symlinks are not a closed input: '+name);
  const bytes=readFileSync(path);files[name]={role,bytes:bytes.length,sha256:hash(bytes)};
 };
 const includes=directory=>{
  const walk=path=>{
   if(!existsSync(join(root,path)))fail('Missing dependency include root '+path);
   for(const entry of readdirSync(join(root,path),{withFileTypes:true})){
    const name=path+'/'+entry.name;
    if(entry.isSymbolicLink())fail('Dependency include symlink is not closed: '+name);
    if(entry.isDirectory())walk(name);
    else if(entry.isFile()&&(/\.(?:h|hpp|hxx|inc|inl|ipp|tcc|def)$/.test(entry.name)||['DEPS','VERSION'].includes(entry.name)))add(name,'header');
   }
  };walk(directory);
 };
 if(engine==='v8'){
  const nativePlatform=platform==='linuxbsd'?'linux':platform;
  const supported={linux:['x86_64','arm64'],windows:['x86_64','arm64'],macos:['x86_64','arm64'],android:['x86_64','arm64','arm32'],ios:['x86_64','arm64','arm32']};
  if(!supported[nativePlatform]?.includes(arch))fail('Unsupported native dependency target');
  const v8Base=`${nativePlatform}${nativePlatform==='windows'?'_':'.'}${arch}${nativePlatform==='windows'?'_':'.'}release`;
  const lwsDelimiter=nativePlatform==='ios'||nativePlatform==='macos'&&arch==='x86_64'?'.':'_';
  const lwsBase=`${nativePlatform}${lwsDelimiter}${arch}${lwsDelimiter}release`;
  const v8Include='v8/include',lwsInclude=`lws/${lwsBase}/include`;
  const v8Library=`v8/${v8Base}/${nativePlatform==='windows'?'v8_monolith.lib':'libv8_monolith.a'}`;
  const lwsLibrary=`lws/${lwsBase}/${nativePlatform==='windows'?'websockets_static.lib':'libwebsockets.a'}`;
  const recipe=readFileSync(join(root,'SCsub'),'utf8');
  const version=name=>{const value=recipe.match(new RegExp(`^deps_${name}_version\\s*=\\s*["']([^"']+)["']`,'m'))?.[1];if(!value)fail('Missing declared '+name+' version');return value;};
  const withLws=nativePlatform!=='ios'||arch==='arm64';
  includes(v8Include);add(v8Library,'library');
  if(withLws){includes(lwsInclude);add(lwsLibrary,'library');}
  for(const required of [v8Include+'/v8.h',v8Include+'/v8-version.h',...(withLws?[lwsInclude+'/libwebsockets.h',lwsInclude+'/lws_config.h']:[])])if(!files[required])fail('Missing dependency '+required);
  const v8Version=readFileSync(join(root,v8Include,'v8-version.h'),'utf8');
  const actualV8=['MAJOR_VERSION','MINOR_VERSION','BUILD_NUMBER','PATCH_LEVEL'].map(key=>v8Version.match(new RegExp('^#define\\s+V8_'+key+'\\s+(\\d+)','m'))?.[1]);
  if(actualV8.some(value=>value===undefined))fail('Missing V8 header version');
  dependencies.v8={declaredVersion:version('v8'),headerVersion:actualV8.join('.'),includeRoots:[v8Include],libraries:[v8Library]};
  if(withLws){const actualLws=readFileSync(join(root,lwsInclude,'lws_config.h'),'utf8').match(/^#define\s+LWS_LIBRARY_VERSION\s+"([^"]+)"/m)?.[1];if(!actualLws)fail('Missing LWS header version');dependencies.lws={declaredVersion:version('lws'),headerVersion:actualLws,includeRoots:[lwsInclude],libraries:[lwsLibrary]};}
 }
 return {schemaVersion:1,kind:'godotjs-native-dependency-inputs',target,dependencies,files:Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b))),coverage:'Selected external libraries and conservative include-tree inputs; bundled QuickJS source is in module inputs. OS/system libraries and compiler runtime support are not asserted.'};
}
export function nativeDependencyManifestHash(manifest){return hash(canonical(manifest));}

/** These are the exact compiler driver commands passed to the scoped producer.
 * Version/executable identities do not claim an entire operating-system image. */
export function captureNativeToolchain({scons='scons',cc='gcc',cxx='g++',link=cxx,ar='ar',python='python3'}={}){
 const executable=command=>{
  if(!command||/\s/.test(command))fail('Use an executable path, not a compiler shell command');
  const file=command.includes('/')?resolve(command):process.env.PATH?.split(delimiter).map(directory=>join(directory,command)).find(path=>existsSync(path)&&statSync(path).isFile());
  if(!file||!existsSync(file)||!statSync(file).isFile())fail('Missing toolchain command '+command);return realpathSync(file);
 };
 const backend=spawnSync(executable(link),['-print-prog-name=ld'],{encoding:'utf8',maxBuffer:256*1024});
 const backendLinker=backend.status===0?(backend.stdout??'').trim():link;
 if(!backendLinker)fail('Cannot identify selected compiler linker');
 const tools={};
 for(const [role,command]of Object.entries({scons,cc,cxx,link,backendLinker,ar,python})){
  const executablePath=executable(command),result=spawnSync(executablePath,['--version'],{encoding:'utf8',maxBuffer:256*1024});
  if(result.error||result.status!==0)fail('Cannot identify '+role+': '+(result.error?.message??result.stderr));
  const version=(result.stdout||result.stderr).trim();if(!version)fail('Missing toolchain version '+role);
  tools[role]={command,executablePath,executableSha256:hash(readFileSync(executablePath)),version};
 }
 return {schemaVersion:1,kind:'godotjs-native-toolchain',tools,producer:{node:process.version,nodeExecutableSha256:hash(readFileSync(process.execPath))},coverage:'Selected compiler/link drivers, archiver, SCons and Python versions/executable bytes. OS/system libraries, compiler runtime support and interpreter package closures are not asserted.'};
}
export function nativeToolchainHash(manifest){return hash(canonical(manifest));}

export function nativeBuildSourceHash(inputs,integration,recipeSha256,environment){
 // Use final compiled leaves and producer identities. `changed`, intermediate
 // edge hashes and original-before hashes are preparation telemetry.
 const proofs=Object.fromEntries(Object.entries(integration??{}).filter(([key])=>key.endsWith('Patch')));
 if(environment){
  const {dependencyManifestSha256,toolchainSha256}=environment;
  if(![dependencyManifestSha256,toolchainSha256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))fail('Incomplete native build environment identity');
  return hash(canonical({kind:'godotjs-native-source-inputs-v3',inputs,proofs,recipeSha256,dependencyManifestSha256,toolchainSha256}));
 }
 return hash(JSON.stringify({kind:'godotjs-native-source-inputs-v2',inputs,proofs,recipeSha256}));
}
