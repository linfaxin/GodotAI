import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {captureEngineApi} from './capture-engine-api.mjs';
import {getEngineProfile,validateEngineProfile} from '../../../scripts/release/engine-profiles.mjs';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const sdk=path.join(repo,'scripts/jsb.react');
const sdkRequire=createRequire(path.join(sdk,'package.json'));
export const FULL_ENGINE_PROFILE='full-engine-v1';
const {ENGINE_SDK_MODULES}=sdkRequire('@godot-js/react/engine-modules');
export const FULL_ENGINE_MODULE_EXPORTS=Object.freeze(Object.fromEntries(Object.entries(ENGINE_SDK_MODULES).map(([name,entry])=>[name,entry.exportName])));
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 return JSON.stringify(value);
}
const safe=relative=>{if(typeof relative!=='string'||!relative||relative.startsWith('/')||relative.includes('\\')||relative.split('/').some(v=>!v||v==='.'||v==='..'))throw Error('E_FULL_ENGINE_PATH: '+relative);return relative;};
export const describeAsset=(path,bytes,extra={})=>({path:safe(path),sha256:sha256(bytes),bytes:bytes.length,...extra});
export const runtimeModuleSource=key=>`module.exports=require('res://.playground/vendor.js').${key};\n`;
export const REQUIRED_BINDING_AUDIT_CHECKS=Object.freeze(['constructorInheritance','methodPropertyOperator','indexed','keyed','stringUtility','constantName','bufferHelper','arrayHelper','dictionaryHelper','callableHelper','signalHelper','readonlyProperty','methodOnlyProperty','bindingMatrix']);

function validateBindingAudit(ir,capture){
 const audit=capture.bindingAudit,inventory=capture.classInventory;
 const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 const reject=message=>{throw Error('E_FULL_ENGINE_AUDIT: '+message);};
 if(!record(audit)||audit.status!=='passed'||!record(audit.checks)||REQUIRED_BINDING_AUDIT_CHECKS.some(name=>!Object.hasOwn(audit.checks,name)||audit.checks[name]!==true)||Object.values(audit.checks).some(value=>value!==true))reject('A complete passing native binding audit is required');
 const matrix=audit.details?.bindingMatrix;
 if(!record(matrix)||!record(matrix.counts)||!Array.isArray(matrix.missing)||matrix.missing.length)reject('Binding matrix must include counts and an empty missing list');
 if(!Array.isArray(ir.classes)||!Array.isArray(ir.builtins))reject('Class and builtin metadata are required to verify coverage');
 const expected={classes:ir.classes.length,methods:0,properties:0,signals:0,virtualDeclarations:0,builtins:0,builtinMethods:0,builtinExtras:0,operators:0};
 for(const cls of ir.classes){
  for(const method of cls.methods??[]){if(method.binding==='accessor')continue;if(method.flags&8)expected.virtualDeclarations++;else expected.methods++;}
  expected.properties+=(cls.properties??[]).filter(property=>property.binding==='property').length;
  expected.signals+=(cls.signals??[]).length;
 }
 for(const builtin of ir.builtins){
  if(!builtin.bindingKind||builtin.bindingKind==='unbound')continue;
  expected.builtins++;expected.builtinMethods+=(builtin.methods??[]).length;
  expected.builtinExtras+=Object.keys(builtin.bindingExtras??{}).filter(kind=>kind!=='builtinType').length;
  expected.operators+=(builtin.bindingOperators??[]).length;
 }
 if(Object.keys(matrix.counts).length!==Object.keys(expected).length)reject('Binding matrix coverage fields are incomplete or unknown');
 for(const [name,count]of Object.entries(expected))if(!Number.isSafeInteger(matrix.counts[name])||matrix.counts[name]!==count)reject('Binding matrix coverage does not match captured IR: '+name);
 if(!record(inventory)||!Number.isSafeInteger(inventory.classes)||inventory.classes!==expected.classes||!Number.isSafeInteger(inventory.bindable)||inventory.bindable!==expected.classes||!Array.isArray(inventory.classFailures)||inventory.classFailures.length||!Array.isArray(inventory.nameMismatches)||inventory.nameMismatches.length)reject('Class inventory must resolve every captured class without failures or name mismatches');
}

export async function buildEngineVendor({mode='production'}={}){
 if(!['production','development'].includes(mode))throw Error('E_FULL_ENGINE_SDK_MODE: '+mode);
 const {build}=await import('esbuild');
 const members={engineModules:sdkRequire.resolve('@godot-js/react/engine-modules'),React:sdkRequire.resolve('react'),jsxRuntime:sdkRequire.resolve('react/jsx-runtime'),jsxDevRuntime:sdkRequire.resolve('react/jsx-dev-runtime'),sdk:sdkRequire.resolve('./dist/index.js'),legacy:sdkRequire.resolve('./dist/legacy.js'),godot:sdkRequire.resolve('./dist/godot.js'),engineReact:sdkRequire.resolve('./dist/engine.js'),scheduler:sdkRequire.resolve('./dist/scheduler.js'),contracts:sdkRequire.resolve('./dist/contracts/index.js'),schema:sdkRequire.resolve('./dist/schema/index.js'),nativeInterfaces:sdkRequire.resolve('./dist/native-interfaces.js'),ui:sdkRequire.resolve('./dist/ui.js'),testing:sdkRequire.resolve('./dist/testing.js')};
 const result=await build({stdin:{contents:Object.entries(members).map(([key,filename])=>`exports.${key}=require(${JSON.stringify(filename)});`).join('\n')+'\nexports.engine=exports.engineReact;\n',resolveDir:sdk,sourcefile:'full-engine-vendor.js'},bundle:true,write:false,platform:'neutral',format:'cjs',target:'es2022',define:{'process.env.NODE_ENV':JSON.stringify(mode)},external:['godot','godot-jsb'],inject:[path.join(sdk,'dist/internal/performance.mjs')]});
 return result.outputFiles[0].contents;
}

/** Seal only metadata observed from the same engine bytes that will be served. */
export function validateProductionApiCapture(ir,capture,engine,runtimeProfile=FULL_ENGINE_PROFILE){
 if(capture?.kind!=='godotjs-production-engine-api-capture'||capture.status!=='captured'||capture.entry!=='godot-jsb.internal.get_engine_api')throw Error('E_FULL_ENGINE_CAPTURE: A production native API capture is required');
 if(capture.engineJsSha256!==engine.javascript.sha256||capture.engineWasmSha256!==(engine.wasm.decodedSha256??engine.wasm.sha256))throw Error('E_FULL_ENGINE_IDENTITY: API capture belongs to different JS/WASM bytes');
 if(!Array.isArray(engine.worklets)||engine.worklets.length!==2||!engine.worklets.some(item=>/\.audio\.worklet\.js$/.test(item.path))||!engine.worklets.some(item=>/\.audio\.position\.worklet\.js$/.test(item.path)))throw Error('E_FULL_ENGINE_IDENTITY: Both production audio worklets are required');
 for(const item of engine.worklets)if(capture.worklets?.[path.basename(item.path)]!==item.sha256)throw Error('E_FULL_ENGINE_IDENTITY: Audio worklet differs from captured engine');
 if(!Array.isArray(ir.modules)||!ir.modules.length||ir.modules.some(name=>typeof name!=='string'||/godotai_api_probe|p0engineapiprobe/i.test(name))||new Set(ir.modules).size!==ir.modules.length)throw Error('E_FULL_ENGINE_MODULES: Missing production module list or inspector module present');
 if(!ir.modules.some(name=>name.toLowerCase()==='godotjs')||!ir.modules.includes('text_server_fb'))throw Error('E_FULL_ENGINE_MODULES: GodotJS and fallback text server are required');
 try{validateEngineProfile(runtimeProfile,{modules:ir.modules,classes:ir.classes});}catch(error){throw Error('E_FULL_ENGINE_MODULES: '+error.message);}
 if(ir.instrumentation||ir.classes?.some(item=>/P0EngineApiProbe/.test(item.nativeName??item.name??'')))throw Error('E_FULL_ENGINE_INSPECTOR: Inspector API cannot be released');
 if(ir.schemaVersion!==1||ir.apiVersion!=='godotjs-engine-api/1'||!ir.engineVersion||!ir.bindingVersion||!['snake','camel'].includes(ir.bindingNaming))throw Error('E_FULL_ENGINE_API: Unsupported production API identity');
 validateBindingAudit(ir,capture);
}

function validateGeneratedProfile({ir,capture,irBytes,declarations,namingVersion,codegenVersion,typeSnapshot,actualAPIHash,strictTypechecks},engine,naming,runtimeProfile){
 validateProductionApiCapture(ir,capture,engine,runtimeProfile);
 if(ir.bindingNaming!==naming||capture.naming!==naming)throw Error('E_FULL_ENGINE_NAMING: Capture does not match '+naming+' bindings');
 if(capture.irSha256!==sha256(irBytes))throw Error('E_FULL_ENGINE_IDENTITY: Captured IR bytes changed');
 if(canonical(ir)!==canonical(JSON.parse(Buffer.from(irBytes).toString('utf8'))))throw Error('E_FULL_ENGINE_IDENTITY: Parsed API differs from captured IR');
 if(!namingVersion||!codegenVersion)throw Error('E_FULL_ENGINE_VERSIONS: API generator and naming versions are required');
 if(ir.namingVersion!==namingVersion)throw Error('E_FULL_ENGINE_VERSIONS: Native and generated naming versions differ');
 if(!/^[a-f0-9]{64}$/.test(actualAPIHash??''))throw Error('E_FULL_ENGINE_IDENTITY: Canonical API hash is required');
 if(!declarations?.files||!Object.keys(declarations.files).length||declarations.diagnostics?.some(item=>item.severity==='error'||item.code?.startsWith('E_')))throw Error('E_FULL_ENGINE_DECLARATIONS: Declaration generation failed');
 if(strictTypechecks?.status!=='passed')throw Error('E_FULL_ENGINE_TYPECHECK: Strict declaration and consumer checks did not pass for '+naming);
 const snapshotTypes=JSON.parse(Buffer.from(typeSnapshot).toString('utf8'));
 for(const required of ['/godot/index.d.ts','/godot-jsb/index.d.ts','/godot.annotations/index.d.ts'])if(!declarations.files[required])throw Error('E_FULL_ENGINE_DECLARATIONS: Missing '+required);
 for(const [name,source]of Object.entries(declarations.files))if(snapshotTypes[name]!==source)throw Error('E_FULL_ENGINE_DECLARATIONS: Type snapshot differs from generated '+name);
 if(!snapshotTypes['/engine-sdk/engine.d.ts'])throw Error('E_FULL_ENGINE_DECLARATIONS: Full renderer declarations are required');
 for(const [specifier,entry]of Object.entries(ENGINE_SDK_MODULES))if(typeof snapshotTypes[entry.declaration]!=='string')throw Error('E_FULL_ENGINE_DECLARATIONS: Missing SDK declaration for '+specifier);
}

/** Both naming snapshots are captured from the same production engine bytes. */
export function assembleFullEngineRelease({engine,ir,capture,irBytes,declarations,namingVersion,codegenVersion,sdkVersion,vendor,developmentVendor,typeSnapshot,namingProfiles,strictTypechecks,build={},runtimeProfile=FULL_ENGINE_PROFILE}){
 const definition=getEngineProfile(runtimeProfile);
 const profiles={snake:{ir,capture,irBytes,declarations,namingVersion,codegenVersion,typeSnapshot,strictTypechecks,actualAPIHash:build.actualAPIHash},camel:namingProfiles?.camel};
 if(!profiles.camel)throw Error('E_FULL_ENGINE_NAMING: Both snake and camel captures are required');
 for(const [naming,profile]of Object.entries(profiles))validateGeneratedProfile(profile,engine,naming,runtimeProfile);
 for(const field of ['engineVersion','bindingVersion','namingVersion','platform'])if(ir[field]!==profiles.camel.ir[field])throw Error('E_FULL_ENGINE_IDENTITY: Naming profiles target different '+field);
 if(namingVersion!==profiles.camel.namingVersion||codegenVersion!==profiles.camel.codegenVersion)throw Error('E_FULL_ENGINE_VERSIONS: Naming profiles use different generators');
 if(canonical([...ir.modules].sort())!==canonical([...profiles.camel.ir.modules].sort()))throw Error('E_FULL_ENGINE_IDENTITY: Naming profiles target different modules');
 const sdkTypes=profile=>{const files=JSON.parse(Buffer.from(profile.typeSnapshot).toString('utf8'));for(const filename of Object.keys(profile.declarations.files))delete files[filename];return files;};
 if(canonical(sdkTypes(profiles.snake))!==canonical(sdkTypes(profiles.camel)))throw Error('E_FULL_ENGINE_IDENTITY: Naming profiles use different SDK type snapshots');
 if(!sdkVersion)throw Error('E_FULL_ENGINE_VERSIONS: SDK version is required');
 if(!vendor?.length||!developmentVendor?.length)throw Error('E_FULL_ENGINE_SDK_MODE: Both production and development vendors are required');
 const outputs=new Map(),payloads={};
 const add=(name,bytes,extra={})=>{const buffer=Buffer.from(bytes);outputs.set(safe(name),buffer);const item=describeAsset(name,buffer,extra);payloads[name]=item;return item;};
 for(const item of [engine.javascript,engine.wasm,...engine.worklets])payloads[item.path]=item;
 const apiProfiles={};
 for(const [naming,profile]of Object.entries(profiles)){
  const prefix=naming==='snake'?'api/':'api/camel/';
  const apiIr=add(prefix+'engine-ir.json',profile.irBytes),captureAsset=add(prefix+'capture.json',JSON.stringify(profile.capture,null,2)+'\n');
  const declarationFiles={};
  for(const [virtualPath,source]of Object.entries(profile.declarations.files).sort()){
   if(!virtualPath.startsWith('/'))throw Error('E_FULL_ENGINE_DECLARATIONS: Expected absolute virtual path');
   declarationFiles[virtualPath]=add(prefix+'declarations/'+safe(virtualPath.slice(1)),source,{virtualPath,naming});
  }
  const declarationSnapshot=add(prefix+'declarations.json',JSON.stringify(profile.declarations.files));
  const coverage=add(prefix+'coverage.json',JSON.stringify({coverage:profile.declarations.coverage,diagnostics:profile.declarations.diagnostics??[]},null,2)+'\n');
  const strictChecks=add(prefix+'strict-typechecks.json',JSON.stringify({...profile.strictTypechecks,actualAPIHash:profile.actualAPIHash,declarationsHash:sha256(canonical(profile.declarations.files)),naming},null,2)+'\n');
  const snapshot=add(naming==='snake'?'types.json':'types.camel.json',profile.typeSnapshot);
  apiProfiles[naming]={version:profile.ir.apiVersion,schemaVersion:profile.ir.schemaVersion,bindingVersion:profile.ir.bindingVersion,bindingNaming:naming,namingVersion:profile.namingVersion,codegenVersion:profile.codegenVersion,actualAPIHash:profile.actualAPIHash,ir:apiIr,capture:captureAsset,declarations:declarationFiles,declarationsSnapshot:declarationSnapshot,declarationsHash:sha256(canonical(profile.declarations.files)),coverage,strictTypechecks:strictChecks,typeSnapshot:snapshot,typeSnapshotHash:snapshot.sha256};
 }
 const vendorAsset=add('.playground/vendor.js',vendor,{sdkMode:'production'});
 const developmentVendorAsset=add('.playground/vendor.development.js',developmentVendor,{sdkMode:'development'});
 const runtimeModules={};
 for(const [specifier,key]of Object.entries(FULL_ENGINE_MODULE_EXPORTS))runtimeModules[specifier]=add('.playground/runtime-modules/'+sha256(specifier)+'.js',runtimeModuleSource(key));
 const verifiedAsset=item=>({url:item.path,sha256:item.sha256,...(item.encoding?{encoding:item.encoding,decodedSha256:item.decodedSha256,decodedBytes:item.decodedBytes}:{})});
 const manifest={schemaVersion:2,runtimeProfile,profile:runtimeProfile,runtimeFamily:definition.runtimeFamily,capabilities:{audio:definition.audio,dimensions:runtimeProfile==='engine-2d-v1'?2:3},
  engine:{...engine,version:ir.engineVersion,modules:ir.modules},modules:ir.modules,
  api:{...apiProfiles.snake,namingProfiles:apiProfiles},
  sdk:{version:sdkVersion,vendor:vendorAsset,vendors:{production:vendorAsset,development:developmentVendorAsset},moduleExports:FULL_ENGINE_MODULE_EXPORTS,moduleContract:ENGINE_SDK_MODULES,runtimeModules},payloads,build,
  verifiedRelease:{profile:runtimeProfile,engineJs:verifiedAsset(engine.javascript),engineWasm:verifiedAsset(engine.wasm),worklets:engine.worklets.map(item=>({...verifiedAsset(item),name:path.basename(item.path)})),allowedOrigins:[]},
 };
 const id=sha256(canonical(manifest));manifest.id=id;manifest.verifiedRelease.releaseId=id;
 add('engine-release.json',JSON.stringify(manifest,null,2)+'\n');
 // The descriptor cannot list its own hash; every executable/API/type payload
 // it consumes is listed before its immutable identity is calculated.
 delete manifest.payloads['engine-release.json'];
 return {manifest,outputs};
}

export async function loadProductionApi({engineJs,engineWasm,irPath,reportPath,captureDirectory,naming='snake'}){
 if(!irPath){irPath=path.join(captureDirectory,'engine-ir.json');reportPath=irPath+'.capture.json';await captureEngineApi({engineJs,engineWasm,output:irPath,reportPath,naming});}
 if(!reportPath)throw Error('E_FULL_ENGINE_CAPTURE: An existing IR requires its exact production capture report');
 const [irBytes,captureBytes,api]=await Promise.all([readFile(irPath),readFile(reportPath),import(path.join(repo,'scripts/jsb.react-browser/dist/engine-api.js'))]);
 const ir=api.parseEngineApi(JSON.parse(irBytes.toString('utf8'))),capture=JSON.parse(captureBytes.toString('utf8'));
 if(ir.namingVersion!==api.ENGINE_NAMING_VERSION)throw Error('E_FULL_ENGINE_VERSIONS: Unsupported native naming version');
 if(ir.bindingNaming!==naming||capture.naming!==naming)throw Error('E_FULL_ENGINE_NAMING: Expected '+naming+' API capture');
 const declarations=api.generateEngineDeclarations(ir),{verifyEngineTypes}=await import('./engine-api-typecheck.mjs');
 const strictTypechecks=await verifyEngineTypes(ir,declarations.files);
 if(strictTypechecks.status!=='passed')throw Error('E_FULL_ENGINE_TYPECHECK: '+naming+' '+JSON.stringify(strictTypechecks));
 return {ir,capture,irBytes,declarations,strictTypechecks,namingVersion:api.ENGINE_NAMING_VERSION,codegenVersion:api.ENGINE_DECLARATIONS_VERSION,actualAPIHash:sha256(api.canonicalEngineApi(ir))};
}

export async function loadProductionApiProfiles({engineJs,engineWasm,captureDirectory,namingProfiles={}}){
 const result={};
 // Each browser is fully retired before loading the same large WASM again.
 for(const naming of ['snake','camel'])result[naming]=await loadProductionApi({engineJs,engineWasm,captureDirectory:path.join(captureDirectory,naming),...namingProfiles[naming],naming});
 return result;
}

export async function writeFullEngineOutputs(directory,outputs){for(const [name,bytes]of outputs){const filename=path.join(directory,safe(name));await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,bytes);}}
