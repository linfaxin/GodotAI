import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createBootFaultFixture} from './boot-fixture.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..'),directory=resolve(repo,'work/playground/p0/boot-fault-native');
const fixture=await createBootFaultFixture();for(const [uri,bytes]of fixture.files){const file=resolve(directory,uri.slice(6));await mkdir(dirname(file),{recursive:true});await writeFile(file,bytes);}
const result=spawnSync(process.env.GODOT??resolve(repo,'tests/bin/godot-host-qjs'),['--headless','--path',directory,'--quit-after','100','--fixed-fps','60'],{encoding:'utf8',timeout:30000});
const output=(result.stdout??'')+(result.stderr??'');await writeFile(resolve(directory,'run.log'),output);process.stdout.write(output);
assert.equal(result.status,0,'A recoverable _ready error must not be equated to engine failure');
assert(output.includes(fixture.expectedError),'Expected engine-side script error missing');
assert(output.includes(fixture.marker),'Engine must continue process callbacks');
const mapped=output.includes(fixture.expectedSource);const line=output.split('\n').find(v=>v.includes(fixture.marker+' '));const report=JSON.parse(line.slice(line.indexOf(fixture.marker)+fixture.marker.length));
assert(report.readyBegan&&report.processContinued);assert(mapped,'Native source-map location must point to original TS line');
await writeFile(resolve(directory,'report.json'),JSON.stringify({status:'passed',target:'native',expectedError:fixture.expectedError,originalSourceMapped:mapped,report},null,2));console.log('P0_BOOT_FAULT_NATIVE_OK');
