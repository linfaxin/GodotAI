import test from 'node:test';import assert from 'node:assert/strict';
import {CompilerSourceSender,CompilerSourceReceiver} from '../src/compiler-source-sync.ts';

test('editor queries send no unchanged binary data and revisions preserve owned previous snapshots',()=>{
 const sender=new CompilerSourceSender(),receiver=new CompilerSourceReceiver(),asset=new Array(1024*1024).fill(17),input={'/start.ts':'export const value=1','/asset.bin':asset};
 const first=sender.prepare('project-a',1,input),old=receiver.apply(first.patch);assert(first.patch.reset);assert.equal(first.patch.changed['/asset.bin'].byteLength,asset.length);
 first.patch.changed['/asset.bin'][0]=99;asset[0]=23;assert.equal(old['/asset.bin'][0],17);
 const same=sender.prepare('project-a',1,input);assert.deepEqual(same.patch.changed,{});assert.equal(receiver.apply(same.patch)['/asset.bin'],old['/asset.bin']);
 const text=sender.prepare('project-a',2,{...input,'/asset.bin':new Array(asset.length).fill(17),'/start.ts':'export const value=2'});assert.deepEqual(Object.keys(text.patch.changed),['/start.ts']);
 const next=receiver.apply(text.patch);assert.equal(next['/asset.bin'],old['/asset.bin']);assert.equal(old['/start.ts'],'export const value=1');
 const changed=sender.prepare('project-a',3,input);assert.equal(changed.patch.changed['/asset.bin'][0],23);receiver.apply(changed.patch);assert.equal(old['/asset.bin'][0],17);
 const pin=first.snapshotFiles();pin['/asset.bin'][0]=100;assert.equal(first.snapshotFiles()['/asset.bin'][0],17);
});

test('source patches reject stale bases, reused revisions and unsafe document switches without losing the current snapshot',()=>{
 const sender=new CompilerSourceSender(),receiver=new CompilerSourceReceiver(),input={'/a.ts':'one','/b.bin':[1,2]};
 const first=sender.prepare('a',1,input),snapshot=receiver.apply(first.patch),next=sender.prepare('a',2,{'/a.ts':'two'});assert.deepEqual(next.patch.removed,['/b.bin']);
 receiver.apply(next.patch);assert.throws(()=>receiver.apply(first.patch),/STALE/);
 assert.throws(()=>receiver.apply({...next.patch,sequence:next.patch.sequence+1,revision:3}),/E_SOURCE_SYNC_BASE/);
 assert.throws(()=>sender.prepare('a',2,{'/a.ts':'different'}),/reused/);
 const query=sender.prepare('a',2,{'/a.ts':'two'});assert.equal(receiver.apply(query.patch)['/a.ts'],'two');assert.equal(snapshot['/a.ts'],'one');
 const other=sender.prepare('b',1,{'/new.ts':'other'});assert(other.patch.reset);assert.equal(other.patch.baseRevision,null);assert.deepEqual(Object.keys(receiver.apply(other.patch)),['/new.ts']);
 assert.throws(()=>receiver.apply(query.patch),/E_SOURCE_SYNC_STALE/);
 sender.reset();assert(sender.prepare('a',10,input).patch.reset);
});

test('source admission counts Unicode bytes before allocation and preserves the admitted revision after budget rejection',()=>{
 const sender=new CompilerSourceSender(),receiver=new CompilerSourceReceiver({maxBytes:8});
 const admitted=receiver.apply(sender.prepare('unicode',1,{'/a.ts':'😀中'}).patch);assert.equal(admitted['/a.ts'],'😀中');
 const oversized=sender.prepare('unicode',2,{'/a.ts':'😀😀a'}).patch;assert.throws(()=>receiver.apply(oversized),/byte budget/);
 const recovery={...oversized,revision:3,baseRevision:1,changed:{'/a.ts':'é😀ab'}};
 assert.equal(receiver.apply(recovery)['/a.ts'],'é😀ab');assert.equal(admitted['/a.ts'],'😀中');
 assert.throws(()=>new CompilerSourceReceiver({maxBytes:0}),/budget/);
});
