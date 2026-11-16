import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {engineApiCaptureFiles} from './capture-engine-api.mjs';

test('native API capture retries rejected chunks on later frames and exits only after every chunk is accepted',()=>{
 let auditCalls=0;
 const inventory={classes:[],padding:'x'.repeat(65536*6+7)},accepted=[],attempts=[],quit=[],logs=[];
 const names={get_member:value=>value,get_class:value=>value,get_internal_mapping:value=>value};
 const J={internal:{names,get_engine_api:()=>inventory}},G={Node:class{},ClassDB:{class_exists:()=>false}};
 const chunks=new Set();let rejecting=true,acknowledge,unbound=0;
 const host={bindProjectCommand(handler){acknowledge=handler;return()=>{unbound++;};},emitProjectEvent(value){attempts.push(value.index);if(rejecting)return false;assert(!chunks.has(value.index));chunks.add(value.index);accepted.push(value);return true;}};
 let source=new TextDecoder().decode(engineApiCaptureFiles().get('res://.godot/GodotJS/src/EngineApiCapture.js'));
 // Keep the actual generated project and transport loop. The expensive native
 // binding audit is independent of queue admission and is replaced at its call.
 source=source.replace(/const bindingAudit=\([^]*?\)\(G,J\);/,"const bindingAudit=globalThis.audit();");
 const scope={require:id=>id==='godot'?G:J,exports:{},__godotjsRuntimeHost:host,console:{error:message=>logs.push(message)},audit(){auditCalls++;return{status:'passed'};}};
 vm.runInNewContext(source,scope);
 const project=new scope.exports.default();project.get_tree=()=>({quit:code=>quit.push(code)});
 project._ready();assert.equal(auditCalls,1);assert.deepEqual(attempts,[]);assert.deepEqual(quit,[]);
 for(let frame=0;frame<5;frame++)project._process();assert.deepEqual(attempts,[0,0,0,0,0]);assert.deepEqual(quit,[]);
 rejecting=false;
 project._process();assert.equal(accepted.length,4);assert.deepEqual(quit,[]);
 project._process();assert(accepted.length>4);assert.equal(accepted.length,accepted[0].total);assert.deepEqual(quit,[]);
 for(let frame=0;frame<5;frame++)project._process();assert.deepEqual(quit,[],'Local admission alone does not prove host receipt');
 acknowledge({type:'engine-api-capture-received'});project._process();assert.equal(unbound,1);
 project._process();assert.deepEqual(quit,[]);project._process();assert.deepEqual(quit,[0]);
 assert.deepEqual(JSON.parse(accepted.map(item=>item.data).join('')).ir,inventory);assert.deepEqual(logs,[]);
});

test('native API capture delivers the standalone Window bridge and exits normally',()=>{
 const received=[],quit=[],names={get_member:value=>value,get_class:value=>value,get_internal_mapping:value=>value};
 const ir={classes:[],bindingNaming:'camel'},J={internal:{names,get_engine_api:()=>ir}};
 const window={call(name,raw,audit){assert.equal(name,'__captureEngineApi');received.push({ir:JSON.parse(raw),audit:JSON.parse(audit)});}};
 const G={Node:class{},ClassDB:{class_exists:()=>false},JavaScriptBridge:{get_interface:name=>{assert.equal(name,'window');return window;}}};
 let source=new TextDecoder().decode(engineApiCaptureFiles('camel').get('res://.godot/GodotJS/src/EngineApiCapture.js'));
 source=source.replace(/const bindingAudit=\([^]*?\)\(G,J\);/,"const bindingAudit={status:'passed'};");
 const scope={require:id=>id==='godot'?G:J,exports:{},console:{error:message=>{throw Error(message);}}};vm.runInNewContext(source,scope);
 const project=new scope.exports.default();project.get_tree=()=>({quit:code=>quit.push(code)});project._ready();
 assert.equal(received.length,1);assert.deepEqual(received[0].ir,ir);
 project._process();project._process();assert.deepEqual(quit,[]);project._process();assert.deepEqual(quit,[0]);
});
