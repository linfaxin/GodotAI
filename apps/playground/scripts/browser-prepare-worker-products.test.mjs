import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {withSdkFixtureVersion} from './browser-prepare-worker-products.mjs';

test('CI fixture builds restore the complete original SDK package bytes after success and failure',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'worker-ci-version-')),filename=path.join(directory,'package.json'),original=Buffer.from('{ "name": "example", "version": "1.2.3", "custom": [1, 2] }\n');
 try{
  await fs.writeFile(filename,original);
  await withSdkFixtureVersion(filename,'1.2.3-worker-ci.previous',async()=>assert.equal(JSON.parse(await fs.readFile(filename)).version,'1.2.3-worker-ci.previous'));
  assert.deepEqual(await fs.readFile(filename),original);
  await assert.rejects(withSdkFixtureVersion(filename,'1.2.3-worker-ci.previous',async()=>{throw Error('native export failed');}),/native export failed/);
  assert.deepEqual(await fs.readFile(filename),original);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('an interrupted CI fixture child restores the original SDK package before exiting',{timeout:10000},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'worker-ci-interrupt-')),filename=path.join(directory,'package.json'),original=Buffer.from('{"name":"example","version":"1.2.3"}\n');
 let child;
 try{
  await fs.writeFile(filename,original);
  const source=`import {withSdkFixtureVersion} from ${JSON.stringify(new URL('./browser-prepare-worker-products.mjs',import.meta.url).href)};await withSdkFixtureVersion(process.argv[1],'1.2.3-worker-ci.previous',signal=>new Promise((resolve,reject)=>{const timer=setInterval(()=>{},1000);signal.addEventListener('abort',()=>{clearInterval(timer);reject(signal.reason);},{once:true});process.stdout.write('ready\\n');}));`;
  child=spawn(process.execPath,['--input-type=module','-e',source,filename],{stdio:['ignore','pipe','pipe']});
  const ready=new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',resolve);});await ready;
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});child.kill('SIGTERM');const result=await exited;
  assert.notEqual(result.code,0);assert.deepEqual(await fs.readFile(filename),original);
 }finally{child?.kill('SIGKILL');await fs.rm(directory,{recursive:true,force:true});}
});
