import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildProject, checkProject } from '../dist/index.js';

test('a package-shaped SDK with hoisted React types checks and builds outside the workspace', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'react-installed-package-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = fileURLToPath(new URL('../../jsb.react/', import.meta.url));
  const installed = path.join(root, 'node_modules/@godot-js/react');
  await fs.mkdir(installed, { recursive: true });
  await fs.cp(path.join(runtime, 'dist'), path.join(installed, 'dist'), { recursive: true });
  const metadata=JSON.parse(await fs.readFile(path.join(runtime,'package.json'),'utf8'));
  for(const name of metadata.files.filter(name=>name!=='dist'))await fs.cp(path.join(runtime,name),path.join(installed,name),{recursive:true});
  await fs.copyFile(path.join(runtime, 'package.json'), path.join(installed, 'package.json'));
  for (const dependency of ['react', 'react-reconciler', 'scheduler', '@types/react']) {
    const target = path.join(root, 'node_modules', dependency);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(await fs.realpath(path.join(runtime, 'node_modules', dependency)), target, 'junction');
  }
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true }));
  await fs.writeFile(path.join(root, 'project.godot'), 'config_version=5\n[application]\nconfig/name="installed-package"\n');
  await fs.writeFile(path.join(root, 'godot-react.config.mjs'), 'export default {entries:{app:"src/App.tsx"}};');
  await fs.writeFile(path.join(root, 'src/App.tsx'), 'import {Label} from "@godot-js/react";export default function App(){return <Label text="installed"/>}');
  await assert.rejects(fs.access(path.join(installed, 'node_modules')));
  assert.equal((await checkProject({ projectRoot: root })).ok, true);
  const result = await buildProject({ projectRoot: root });
  assert(result.manifest.modules.runtime); assert(result.manifest.entries.app);
  // Adding React's private type root must preserve the application's own ambient packages.
  await fs.mkdir(path.join(root, 'node_modules/@types/review-model'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules/@types/review-model/index.d.ts'), 'interface ReviewModel { label: string }');
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: ['review-model'] }, include: ['src'] }));
  await fs.writeFile(path.join(root, 'src/App.tsx'), 'import {Label} from "@godot-js/react";const model:ReviewModel={label:"consumer types"};export default function App(){return <Label text={model.label}/>}');
  assert.equal((await checkProject({ projectRoot: root })).ok, true);
});
