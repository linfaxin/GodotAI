import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { buildProject, loadConfig, watchProject } from '../dist/index.js';
import { startManagedPreview } from '../dist/preview.js';
import { activeRunLeases, processAlive } from '../dist/publication.js';

const source = text => `import {Label} from "@godot-js/react";export default function App(){return <Label text=${JSON.stringify(text)}/>}`;
async function waitFor(predicate, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(r => setTimeout(r, 25)); }
  throw Error('Timed out waiting for watch/preview state');
}
async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'react-watch-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/App.tsx'), source('one'));
  await fs.writeFile(path.join(root, 'project.godot'), 'config_version=5\n[application]\nconfig/name="watch-test"\n');
  const executable = path.join(root, 'process-stand-in');
  // This stand-in exercises real process/lease handoff. Native behavior is covered by Godot fixtures.
  await fs.writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const args=process.argv.slice(2),root=args[args.indexOf('--path')+1];
if(root.endsWith('binary-descriptor')){console.log('GODOT_REACT_NATIVE_DESCRIPTOR '+JSON.stringify({engine:'quickjs',godotVersion:'4.6.1.test',nativeBridgeAbi:'godot-react-native/1'}));process.exit(0);}
if(args.includes('--import'))process.exit(0);
const base=path.join(root,'generated/react'),active=JSON.parse(fs.readFileSync(path.join(base,'active.json'),'utf8'));
const identity='stand-in:'+process.pid,name=process.pid+'-'+crypto.createHash('sha256').update(identity).digest('hex')+'.json';
const marker=path.join(base,'run-leases',name);fs.mkdirSync(path.dirname(marker),{recursive:true});
fs.writeFileSync(marker,JSON.stringify({schemaVersion:1,pid:process.pid,rootId:'app',rootInstance:identity,createdAtMs:Date.now()}));
fs.appendFileSync(path.join(base,'processes.jsonl'),JSON.stringify({pid:process.pid,generation:active.generation,headless:args.includes('--headless')})+'\\n');
setInterval(()=>{if(fs.existsSync(marker+'.shutdown')){fs.rmSync(marker,{force:true});fs.rmSync(marker+'.shutdown',{force:true});process.exit(0);}},10);
`, { mode: 0o755 });
  await fs.writeFile(path.join(root, 'godot-react.config.mjs'), `export default {entries:{app:"src/App.tsx"},godot:${JSON.stringify(executable)}};`);
  const config = await loadConfig({ projectRoot: root });
  const processes = async () => (await fs.readFile(path.join(root, 'generated/react/processes.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { root, config, processes };
}

test('watch shuts down before rebuilding, waits through a failed build and restarts the selected preview', async t => {
  const { root, config, processes } = await project(t), abort = new AbortController(), events = [];
  const watching = watchProject({ projectRoot: root, entry: 'app', headless: true, signal: abort.signal, pollMs: 25, onEvent: e => events.push(e) });
  try {
    const [first] = await waitFor(async () => { const runs = await processes(); return runs.length === 1 && runs; });
    await fs.writeFile(path.join(root, 'src/App.tsx'), 'import {Label} from "@godot-js/react";export default function App(){return <Label text={123}/>}');
    await waitFor(() => events.some(e => e.event === 'error' && e.error.includes('E_TYPESCRIPT')));
    assert.equal(processAlive(first.pid), false); assert.equal((await processes()).length, 1);
    await fs.writeFile(path.join(root, 'src/App.tsx'), source('fixed'));
    const runs = await waitFor(async () => { const current = await processes(); return current.length === 2 && current; });
    assert.notEqual(runs[0].generation, runs[1].generation); assert.notEqual(runs[0].pid, runs[1].pid);
    assert(runs.every(run => run.headless));
  } finally { abort.abort(); await watching; }
  for (const run of await processes()) assert.equal(processAlive(run.pid), false);
  assert.deepEqual(await activeRunLeases(config), []);
});

for (const selectedEntry of [undefined, 'app']) test(`${selectedEntry ? 'watch --entry' : 'plain watch'} resumes an existing SDK preview without duplicating it`, async t => {
  const { root, config, processes } = await project(t), abort = new AbortController(),events=[];
  const build = await buildProject({ projectRoot: root });
  const preview = await startManagedPreview(config, build.generation, 'app', { headless: true });
  await waitFor(async () => (await processes()).length === 1);
  const watching = watchProject({ projectRoot: root, entry: selectedEntry, skipInitial: true, signal: abort.signal, pollMs: 25, onEvent:event=>events.push(event) });
  try {
    await waitFor(()=>events.some(event=>event.event==='watching'));
    await fs.writeFile(path.join(root, 'src/App.tsx'), source('two'));
    await waitFor(async () => (await processes()).length === 2);
    assert.equal((await preview.result).code, 0);
    assert((await processes()).every(run => run.headless));
  } finally { abort.abort(); await watching; await preview.stop(); }
  for (const run of await processes()) assert.equal(processAlive(run.pid), false);
  assert.deepEqual(await activeRunLeases(config), []);
});

test('watch refuses to stop or adopt an external application with no SDK preview supervisor', async t => {
  const { root } = await project(t), abort = new AbortController(), events = [];
  const lease = path.join(root, 'generated/react/run-leases/external.json');
  await fs.mkdir(path.dirname(lease), { recursive: true });
  await fs.writeFile(lease, JSON.stringify({ schemaVersion: 1, pid: process.pid, rootId: 'app', rootInstance: 'external', createdAtMs: Date.now() }));
  const watching = watchProject({ projectRoot: root, skipInitial: true, signal: abort.signal, pollMs: 25, onEvent: e => events.push(e) });
  try {
    await waitFor(()=>events.some(event=>event.event==='watching')); await fs.writeFile(path.join(root, 'src/App.tsx'), source('changed'));
    await waitFor(() => events.some(e => e.event === 'error' && e.error.includes('E_RUN_ACTIVE')));
    await fs.access(lease); await assert.rejects(fs.access(`${lease}.shutdown`));
  } finally { abort.abort(); await watching; }
});
