import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {runFixture} from './run-probes.mjs';
import {createBootFixture,createBootFaultFixture} from './boot-fixture.mjs';
import {createReactFixture} from './react-fixture.mjs';
import {createReactAbaFixture} from './react-aba-fixture.mjs';

const repo=fileURLToPath(new URL('../../../../',import.meta.url)),directory=path.join(repo,'work/playground/p0');
const engineJs=process.env.P0_ENGINE_JS??path.join(directory,'full-engine/godot.js');
const engineWasm=process.env.P0_ENGINE_WASM??path.join(directory,'full-engine/godot.wasm');
const checks=[];
for(const [name,create,nonAudio]of [
 ['boot',()=>createBootFixture(),false],['boot-uid',()=>createBootFixture({uidMain:true}),false],
 ['boot-fault',createBootFaultFixture,true],['react',createReactFixture,true],['react-aba',createReactAbaFixture,true],
]){
 const fixture=await create();if(nonAudio)fixture.engineArgs=['--audio-driver','Dummy'];
 let error;
 try{await runFixture(fixture,{engineJs,engineWasm});}catch(value){error=String(value).slice(0,1000);}
 const evidence=JSON.parse(await readFile(path.join(directory,fixture.name+'-browser.json'),'utf8'));
 const outcome={name,status:evidence.status,executionStatus:evidence.executionStatus,report:evidence.report,engine:evidence.engine,evidence:fixture.name+'-browser.json',...(error?{runnerAssertion:error}:{})};
 if(fixture.expectedError){const logs=[...evidence.native.events,...evidence.logs.map(item=>item.text)].join('\n');outcome.expectedErrorObserved=logs.includes(fixture.expectedError);outcome.expectedSourceObserved=logs.includes(fixture.expectedSource);if(!outcome.expectedErrorObserved||!outcome.expectedSourceObserved)outcome.status='failed';}
 checks.push(outcome);await writeFile(path.join(directory,'full-integration.json'),JSON.stringify({status:checks.every(item=>item.status==='passed')?'passed':'needs-work',checks},null,2));
 console.log(JSON.stringify({name,status:outcome.status,report:outcome.report}));
}
if(checks.some(item=>item.status!=='passed'))process.exitCode=2;
