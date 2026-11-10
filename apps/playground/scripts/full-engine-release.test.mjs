import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync,gunzipSync} from 'node:zlib';
import {assembleFullEngineRelease,validateProductionApiCapture,describeAsset,sha256,canonical,FULL_ENGINE_MODULE_EXPORTS,REQUIRED_BINDING_AUDIT_CHECKS} from './full-engine-release.mjs';
import {resolvedBrowserModules} from '../../../scripts/test/build-browser-engine.mjs';
import {engineApiCaptureFiles} from './capture-engine-api.mjs';
import {auditEngineBinding} from './engine-api-binding-audit.mjs';
import {FULL_WEB_MODULE_BASELINE} from './full-engine-profile.mjs';
import {createRequire} from 'node:module';
const {ENGINE_SDK_MODULES}=createRequire(new URL('../../../scripts/jsb.react/package.json',import.meta.url))('@godot-js/react/engine-modules');
const sdkDeclarations=()=>Object.fromEntries(Object.values(ENGINE_SDK_MODULES).map(entry=>[entry.declaration,'export {};\n']));

function fixture({compressed=false}={}){
 const wasm=Buffer.from([0,97,115,109,1,0,0,0]),javascript=Buffer.from('/* production fixture */'),audio=Buffer.from('/* audio */'),position=Buffer.from('/* position */');
 const engine={javascript:describeAsset('engine/godot.js',javascript),wasm:compressed?describeAsset('engine/godot.wasm.gz',gzipSync(wasm),{encoding:'gzip',decodedSha256:sha256(wasm),decodedBytes:wasm.length}):describeAsset('engine/godot.wasm',wasm),worklets:[describeAsset('engine/godot.audio.worklet.js',audio),describeAsset('engine/godot.audio.position.worklet.js',position)]};
 const ir={schemaVersion:1,apiVersion:'godotjs-engine-api/1',engineVersion:'4.6.1.test',bindingVersion:'godotjs-test/1',namingVersion:'godotjs-public-names/1',bindingNaming:'snake',modules:[...FULL_WEB_MODULE_BASELINE],classes:[{nativeName:'Node',publicName:'Node'}],builtins:[],utilities:[],globalConstants:[],singletons:[]};
 const irBytes=Buffer.from(JSON.stringify(ir,null,2)+'\n');
 const capture={schemaVersion:1,kind:'godotjs-production-engine-api-capture',status:'captured',naming:'snake',entry:'godot-jsb.internal.get_engine_api',engineJsSha256:sha256(javascript),engineWasmSha256:sha256(wasm),worklets:{'godot.audio.worklet.js':sha256(audio),'godot.audio.position.worklet.js':sha256(position)},irSha256:sha256(irBytes)};
 capture.bindingAudit={status:'passed',checks:Object.fromEntries(REQUIRED_BINDING_AUDIT_CHECKS.map(name=>[name,true])),details:{bindingMatrix:{counts:{classes:1,methods:0,properties:0,signals:0,virtualDeclarations:0,builtins:0,builtinMethods:0,builtinExtras:0,operators:0},missing:[]}}};
 capture.classInventory={classes:1,bindable:1,classFailures:[],nameMismatches:[]};
 const files={'/godot/index.d.ts':'declare module "godot" {export class Node {}}\n','/godot-jsb/index.d.ts':'declare module "godot-jsb" {}\n','/godot.annotations/index.d.ts':'declare module "godot.annotations" {}\n'};
 const base={engine,ir,irBytes,capture,declarations:{files,coverage:{classes:1},diagnostics:[]},strictTypechecks:{status:'passed',checks:{declarations:true,positiveConsumer:true,negativeConsumer:true}},namingVersion:'godotjs-public-names/1',codegenVersion:'godotjs-engine-declarations/1',sdkVersion:'0.1.0',vendor:'exports.engineReact={};\n',developmentVendor:'exports.engineReact={development:true};\n',typeSnapshot:JSON.stringify({...sdkDeclarations(),...files,'/engine-sdk/engine.d.ts':'export declare function createRoot():unknown;\n'}),build:{actualAPIHash:sha256(canonical(ir))},engineBytes:{'engine/godot.js':javascript,[engine.wasm.path]:compressed?gzipSync(wasm):wasm,'engine/godot.audio.worklet.js':audio,'engine/godot.audio.position.worklet.js':position}};
 const camelIr={...ir,bindingNaming:'camel'},camelBytes=Buffer.from(JSON.stringify(camelIr,null,2)+'\n');
 const camelFiles={...files,'/godot/index.d.ts':files['/godot/index.d.ts']+'// camel API\n'};
 const camel={ir:camelIr,irBytes:camelBytes,capture:{...capture,naming:'camel',irSha256:sha256(camelBytes)},declarations:{files:camelFiles,coverage:{classes:1},diagnostics:[]},strictTypechecks:base.strictTypechecks,namingVersion:base.namingVersion,codegenVersion:base.codegenVersion,actualAPIHash:sha256(canonical(camelIr)),typeSnapshot:JSON.stringify({...sdkDeclarations(),...camelFiles,'/engine-sdk/engine.d.ts':'export declare function createRoot():unknown;\n'})};
 return {...base,namingProfiles:{camel}};
}

test('full engine release seals executable, native API, generated types and runtime modules under one identity',()=>{
 const input=fixture(),result=assembleFullEngineRelease(input),{manifest,outputs}=result;
 assert.equal(manifest.schemaVersion,2);assert.equal(manifest.runtimeProfile,'full-engine-v1');
 assert.equal(manifest.api.ir.path,manifest.api.namingProfiles.snake.ir.path);
 assert.equal(manifest.api.typeSnapshot.path,'types.json');assert.equal(manifest.api.namingProfiles.camel.typeSnapshot.path,'types.camel.json');
 assert.notEqual(manifest.api.actualAPIHash,manifest.api.namingProfiles.camel.actualAPIHash);
 for(const naming of ['snake','camel']){const evidence=JSON.parse(outputs.get(manifest.api.namingProfiles[naming].strictTypechecks.path));assert.equal(evidence.status,'passed');assert.equal(evidence.actualAPIHash,manifest.api.namingProfiles[naming].actualAPIHash);}
 assert.equal(manifest.verifiedRelease.releaseId,manifest.id);
 assert.deepEqual(manifest.verifiedRelease.worklets,input.engine.worklets.map(item=>({url:item.path,sha256:item.sha256,name:item.path.split('/').at(-1)})));
 const {id,verifiedRelease,...content}=manifest;const {releaseId,...verified}=verifiedRelease;
 assert.equal(id,sha256(canonical({...content,verifiedRelease:verified})));
 assert.deepEqual(JSON.parse(outputs.get('engine-release.json')),manifest);
 for(const [name,asset]of Object.entries(manifest.payloads)){
  const bytes=outputs.get(name)??input.engineBytes[name];assert.ok(bytes,name);
  assert.equal(sha256(bytes),asset.sha256,name);assert.equal(bytes.length,asset.bytes,name);
 }
 assert.equal(manifest.sdk.moduleExports['@godot-js/react'],'engineReact');
 assert.notEqual(manifest.sdk.vendors.production.sha256,manifest.sdk.vendors.development.sha256);
 for(const [specifier,key]of Object.entries(FULL_ENGINE_MODULE_EXPORTS)){
  const asset=manifest.sdk.runtimeModules[specifier];
  assert.equal(outputs.get(asset.path).toString(),`module.exports=require('res://.playground/vendor.js').${key};\n`);
 }
 assert.equal(manifest.sdk.runtimeModules.godot,undefined,'Native modules remain engine resolved');
 assert.equal(manifest.sdk.runtimeModules['godot-jsb'],undefined);
 assert.equal(assembleFullEngineRelease(input).manifest.id,id,'Same inputs reproduce identity');
 assert.notEqual(assembleFullEngineRelease({...input,vendor:'changed vendor'}).manifest.id,id);
});

test('production capture refuses IR from another engine, changed worklets, and inspector templates',()=>{
 const input=fixture();
 for(const field of ['engineJsSha256','engineWasmSha256'])assert.throws(()=>validateProductionApiCapture(input.ir,{...input.capture,[field]:sha256('different')},input.engine),/E_FULL_ENGINE_IDENTITY/);
 assert.throws(()=>validateProductionApiCapture(input.ir,{...input.capture,worklets:{}},input.engine),/E_FULL_ENGINE_IDENTITY/);
 assert.throws(()=>validateProductionApiCapture(input.ir,input.capture,{...input.engine,worklets:[]}),/E_FULL_ENGINE_IDENTITY/);
 assert.throws(()=>validateProductionApiCapture({...input.ir,modules:['GodotJS','text_server_fb','godotai_api_probe']},input.capture,input.engine),/E_FULL_ENGINE_MODULES/);
 assert.throws(()=>validateProductionApiCapture({...input.ir,modules:input.ir.modules.filter(name=>name!=='noise')},input.capture,input.engine),/E_FULL_ENGINE_MODULES.*noise/);
 assert.throws(()=>validateProductionApiCapture({...input.ir,classes:[{nativeName:'P0EngineApiProbe'}]},input.capture,input.engine),/E_FULL_ENGINE_INSPECTOR/);
 assert.throws(()=>validateProductionApiCapture(input.ir,{...input.capture,entry:'P0EngineApiProbe.describe_json'},input.engine),/E_FULL_ENGINE_CAPTURE/);
});

test('capture IR, declaration snapshot and full renderer declaration identities cannot drift',()=>{
 const input=fixture();
 assert.throws(()=>assembleFullEngineRelease({...input,irBytes:Buffer.from('{}')}),/E_FULL_ENGINE_IDENTITY/);
 assert.throws(()=>assembleFullEngineRelease({...input,ir:{...input.ir,engineVersion:'different'}}),/E_FULL_ENGINE_IDENTITY/);
 assert.throws(()=>assembleFullEngineRelease({...input,typeSnapshot:'{}'}),/E_FULL_ENGINE_DECLARATIONS/);
 assert.throws(()=>assembleFullEngineRelease({...input,declarations:{...input.declarations,diagnostics:[{severity:'error',message:'not represented'}]}}),/E_FULL_ENGINE_DECLARATIONS/);
 const changed={...input.declarations,files:{...input.declarations.files,'/godot/index.d.ts':'incorrect native declaration'}};
 assert.throws(()=>assembleFullEngineRelease({...input,declarations:changed}),/E_FULL_ENGINE_DECLARATIONS/);
});

test('gzip release binds both served WASM and decoded production capture bytes',()=>{
 const input=fixture({compressed:true}),{manifest}=assembleFullEngineRelease(input),asset=manifest.verifiedRelease.engineWasm;
 assert.equal(asset.encoding,'gzip');assert.equal(asset.url,'engine/godot.wasm.gz');
 assert.equal(sha256(gunzipSync(input.engineBytes[asset.url])),asset.decodedSha256);
 assert.notEqual(asset.sha256,asset.decodedSha256);
});

test('build report resolves actual enabled modules and rejects an inspector-enabled header',()=>{
 const header='#define MODULE_GODOTJS_ENABLED\n#define MODULE_NOISE_ENABLED\n#define MODULE_TEXT_SERVER_FB_ENABLED\n';
 assert.deepEqual(resolvedBrowserModules(header),['GodotJS','noise','text_server_fb']);
 assert.throws(()=>resolvedBrowserModules(header+'#define MODULE_GODOTAI_API_PROBE_ENABLED\n'),/E_BROWSER_MODULES/);
 assert.throws(()=>resolvedBrowserModules('#define MODULE_GODOTJS_ENABLED\n'),/E_BROWSER_MODULES/);
});

test('production naming profiles require independent captures from the same WASM and matching declaration snapshots',()=>{
 const input=fixture();
 assert.throws(()=>assembleFullEngineRelease({...input,namingProfiles:undefined}),/E_FULL_ENGINE_NAMING/);
 const wrongCapture={...input.namingProfiles.camel,capture:{...input.namingProfiles.camel.capture,engineWasmSha256:sha256('other engine')}};
 assert.throws(()=>assembleFullEngineRelease({...input,namingProfiles:{camel:wrongCapture}}),/E_FULL_ENGINE_IDENTITY/);
 const wrongNaming={...input.namingProfiles.camel,capture:{...input.namingProfiles.camel.capture,naming:'snake'}};
 assert.throws(()=>assembleFullEngineRelease({...input,namingProfiles:{camel:wrongNaming}}),/E_FULL_ENGINE_NAMING/);
 const wrongTypes={...input.namingProfiles.camel,typeSnapshot:input.typeSnapshot};
 assert.throws(()=>assembleFullEngineRelease({...input,namingProfiles:{camel:wrongTypes}}),/E_FULL_ENGINE_DECLARATIONS/);
 const wrongSdk={...input.namingProfiles.camel,typeSnapshot:JSON.stringify({...JSON.parse(input.namingProfiles.camel.typeSnapshot),'/engine-sdk/engine.d.ts':'different SDK declarations'})};
 assert.throws(()=>assembleFullEngineRelease({...input,namingProfiles:{camel:wrongSdk}}),/E_FULL_ENGINE_IDENTITY/);
 assert.throws(()=>assembleFullEngineRelease({...input,strictTypechecks:{status:'failed'}}),/E_FULL_ENGINE_TYPECHECK/);
 for(const naming of ['snake','camel']){
  const config=new TextDecoder().decode(engineApiCaptureFiles(naming).get('res://project.godot'));
  assert.match(config,new RegExp('camel_case_bindings_enabled='+String(naming==='camel')));
 }
 assert.throws(()=>engineApiCaptureFiles('other'),/E_ENGINE_API_NAMING/);
 const info={...input.declarations,diagnostics:[{code:'I_ENGINE_OPAQUE_TYPE',nativeName:'Opaque',message:'Opaque native metadata'}]};
 assert.doesNotThrow(()=>assembleFullEngineRelease({...input,declarations:info}));
 const error={...input.declarations,diagnostics:[{code:'E_ENGINE_DECLARATION',message:'Invalid declaration'}]};
 assert.throws(()=>assembleFullEngineRelease({...input,declarations:error}),/E_FULL_ENGINE_DECLARATIONS/);
});

test('capture requires every actual binding audit check, empty failure lists and a complete class inventory',()=>{
 const input=fixture(),{capture,ir,engine}=input,audit=capture.bindingAudit,matrix=audit.details.bindingMatrix,inventory=capture.classInventory;
 const actualChecks=[...auditEngineBinding.toString().matchAll(/\bcheck\('([^']+)'/g)].map(match=>match[1]);actualChecks.push('bindingMatrix');
 assert.deepEqual([...REQUIRED_BINDING_AUDIT_CHECKS].sort(),actualChecks.sort(),'Capture audit and release schema cover the same native checks');
 const changes=[
  {bindingAudit:undefined},{bindingAudit:{...audit,status:'failed'}},{bindingAudit:{...audit,checks:{}}},
  {bindingAudit:{...audit,checks:{...audit.checks,indexed:false}}},
  {bindingAudit:{...audit,checks:{...audit.checks,keyed:undefined}}},
  {bindingAudit:{...audit,checks:{...audit.checks,bindingMatrix:'true'}}},
  {bindingAudit:{...audit,details:{}}},
  {bindingAudit:{...audit,details:{bindingMatrix:{counts:matrix.counts}}}},
  {bindingAudit:{...audit,details:{bindingMatrix:{...matrix,missing:[{kind:'operator',public:'ADD'}]}}}},
  {bindingAudit:{...audit,details:{bindingMatrix:{...matrix,counts:{...matrix.counts,classes:0}}}}},
  {bindingAudit:{...audit,details:{bindingMatrix:{...matrix,counts:{...matrix.counts,methods:1}}}}},
  {bindingAudit:{...audit,details:{bindingMatrix:{...matrix,counts:{classes:1}}}}},
  {classInventory:undefined},{classInventory:{...inventory,classes:0}},{classInventory:{...inventory,bindable:0}},
  {classInventory:{...inventory,bindable:1.5}},{classInventory:{classes:1,bindable:1}},
  {classInventory:{...inventory,classFailures:[{original:'Node'}]}},
  {classInventory:{...inventory,nameMismatches:[{original:'Node',alias:'Other'}]}},
 ];
 for(const change of changes)assert.throws(()=>validateProductionApiCapture(ir,{...capture,...change},engine),/E_FULL_ENGINE_AUDIT/);
 const camel={...input.namingProfiles.camel,capture:{...input.namingProfiles.camel.capture,bindingAudit:undefined}};
 assert.throws(()=>assembleFullEngineRelease({...input,namingProfiles:{camel}}),/E_FULL_ENGINE_AUDIT/);
});

test('binding audit matrix counts are checked against actual IR binding kinds and flags',()=>{
 const input=fixture(),ir={...input.ir,classes:[
  {nativeName:'Node',publicName:'Node',methods:[{flags:0},{flags:8},{flags:0,binding:'accessor'}],properties:[{binding:'property'},{binding:'methods'}],signals:[{}]},
  {nativeName:'Other',publicName:'Other',methods:[{flags:32},{flags:8,binding:'accessor'}],properties:[{binding:'metadata'}],signals:[{},{}]},
 ],builtins:[
  {bindingKind:'constructor',methods:[{},{}],bindingExtras:{builtinType:'BUILTIN_TYPE',toBuffer:'to_array_buffer',fromBuffer:'from_array_buffer'},bindingOperators:[{publicName:'ADD'},{publicName:'MULTIPLY'}]},
  {bindingKind:'utility',methods:[{}],bindingExtras:{builtinType:'BUILTIN_TYPE'}},
  {bindingKind:'unbound',methods:[{}],bindingOperators:[{publicName:'IGNORE'}]},
 ]};
 const counts={classes:2,methods:2,properties:1,signals:3,virtualDeclarations:1,builtins:2,builtinMethods:3,builtinExtras:2,operators:2};
 const capture={...input.capture,bindingAudit:{...input.capture.bindingAudit,details:{bindingMatrix:{counts,missing:[]}}},classInventory:{classes:2,bindable:2,classFailures:[],nameMismatches:[]}};
 assert.doesNotThrow(()=>validateProductionApiCapture(ir,capture,input.engine));
 for(const field of Object.keys(counts)){
  const changed={...capture,bindingAudit:{...capture.bindingAudit,details:{bindingMatrix:{counts:{...counts,[field]:counts[field]+1},missing:[]}}}};
  assert.throws(()=>validateProductionApiCapture(ir,changed,input.engine),new RegExp('E_FULL_ENGINE_AUDIT:.*'+field));
 }
});
