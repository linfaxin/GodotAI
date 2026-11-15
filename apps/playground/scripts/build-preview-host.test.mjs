import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildPreviewHost,assertPreviewHost,writePreviewHtml} from './build-preview-host.mjs';
test('the exact neutral host bundle is sealed before HTML adds its independent SRI',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'preview-host-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const host=await buildPreviewHost(directory),before=await readFile(path.join(directory,'preview.js'));
 assert.equal(host.sha256,createHash('sha256').update(before).digest('hex'));assert.equal(host.bytes,before.length);
 const text=before.toString('utf8');assert(!text.includes('react-reconciler'));assert(!text.includes('react.production'));assert(!text.includes('createElementSymbol'));
 await writePreviewHtml(directory,host);
 const html=await readFile(path.join(directory,'preview.html'),'utf8');assert(html.includes('src="./preview.js" integrity="sha256-'+Buffer.from(host.sha256,'hex').toString('base64')+'"'));
 assert.deepEqual(await readFile(path.join(directory,'preview.js')),before,'HTML/SRI assembly does not rebuild the host or introduce a self reference');
 await writeFile(path.join(directory,'preview.js'),'changed host');await assert.rejects(assertPreviewHost(directory,host),/E_ENGINE_HOST_CHANGED/);await assert.rejects(writePreviewHtml(directory,host),/E_ENGINE_HOST_CHANGED/);
});
