import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { checkProject, buildProject } from '../dist/index.js';

async function project(t, source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'react-host-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/App.tsx'), source);
  await fs.writeFile(path.join(root, 'project.godot'), 'config_version=5\n[application]\nconfig/name="host-profile"\n');
  return root;
}
async function configure(root, profileId, assets) {
  await fs.writeFile(path.join(root, 'godot-react.config.mjs'), 'export default ' + JSON.stringify({ entries: { app: 'src/App.tsx' }, profileId, ...(assets ? { assets } : {}) }));
}

test('Node host checks follow canonical SDK identity for media aliases, namespaces, G and re-exports', async t => {
  const forms = [
    ['import {Sprite2D} from "@godot-js/react";', '<Sprite2D/>'],
    ['import {Sprite2D as Image} from "@godot-js/react";', '<Image/>'],
    ['import * as SDK from "@godot-js/react";', '<SDK.Sprite2D/>'],
    ['import {G} from "@godot-js/react";', '<G.Sprite2D/>'],
    ['import {Picture} from "./hosts.js";', '<Picture/>'],
  ];
  const root = await project(t, '');
  await fs.writeFile(path.join(root, 'src/hosts.ts'), 'export {Sprite2D as Picture} from "@godot-js/react";');
  for (const [imports, element] of forms) {
    await fs.writeFile(path.join(root, 'src/App.tsx'), imports + 'export default function App(){return ' + element + ';}');
    await configure(root, 'core-ui-v1');
    await assert.rejects(checkProject({ projectRoot: root }), error => error.code === 'E_PROFILE_UNSUPPORTED' && /Sprite2D/.test(error.message), imports);
    await configure(root, 'game-2d-v1');
    assert.equal((await checkProject({ projectRoot: root })).ok, true, imports);
  }
});

test('unified Node profile accepts mixed hosts, preserves old gates and ignores same-named user components', async t => {
  const root = await project(t, 'import {G} from "@godot-js/react"; export default function App(){return <G.CharacterBody2D><G.CollisionShape2D/><G.Sprite2D/><G.ProgressBar value={25}/></G.CharacterBody2D>;}');
  await configure(root, 'ui-media-v1');
  await assert.rejects(checkProject({ projectRoot: root }), error => error.code === 'E_PROFILE_UNSUPPORTED' && /CharacterBody2D/.test(error.message));
  await configure(root, 'game-2d-v1');
  assert.equal((await checkProject({ projectRoot: root })).ok, true);
  await fs.writeFile(path.join(root, 'src/App.tsx'), 'function Sprite2D(){return null;} function CharacterBody2D(){return null;} export default function App(){return <><Sprite2D/><CharacterBody2D/></>;}');
  await configure(root, 'core-ui-v1');
  assert.equal((await checkProject({ projectRoot: root })).ok, true);
});

test('unified Node profile retains the existing tres pipeline and does not imply browser image imports', async t => {
  const root = await project(t, 'import {CharacterBody2D,CollisionShape2D,asset} from "@godot-js/react";export default function App(){return <CharacterBody2D><CollisionShape2D shape={asset("shape","CircleShape2D")}/></CharacterBody2D>;}');
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets/shape.tres'), '[gd_resource type="CircleShape2D" format=3]\n[resource]\nradius=12.0\n');
  await configure(root, 'game-2d-v1', { shape: { source: 'assets/shape.tres', type: 'CircleShape2D' } });
  assert.equal((await checkProject({ projectRoot: root })).ok, true);
  await assert.rejects(buildProject({ projectRoot: root }), error => error.code === 'E_IMPORT_REQUIRED');
  await fs.writeFile(path.join(root, 'src/App.tsx'), 'import {CharacterBody2D,CollisionShape2D,Sprite2D} from "@godot-js/react";export default function App(){return <CharacterBody2D><CollisionShape2D/><Sprite2D/></CharacterBody2D>;}');
  await configure(root, 'game-2d-v1');
  const result = await buildProject({ projectRoot: root });
  assert.equal(result.manifest.profile.id, 'game-2d-v1');
  assert.equal(result.manifest.profile.version, 1);
  await fs.writeFile(path.join(root, 'assets/actor.png'), new Uint8Array([137, 80, 78, 71]));
  await configure(root, 'game-2d-v1', { actor: { source: 'assets/actor.png', type: 'Texture2D' } });
  await assert.rejects(checkProject({ projectRoot: root }), error => error.code === 'E_IMPORT_RESOURCE');
});
