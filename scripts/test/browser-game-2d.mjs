import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function game2DProject(page, repo, sdkMode = 'production') {
  const source = await readFile(resolve(repo, 'scripts/test/fixtures/browser-game-2d.tsx'), 'utf8');
  const images = await page.evaluate(async () => {
    const result = [];
    for (const colors of [['#f00', '#0f0'], ['#00f', '#ff0']]) {
      const canvas = new OffscreenCanvas(2, 1), context = canvas.getContext('2d');
      colors.forEach((color, index) => { context.fillStyle = color; context.fillRect(index, 0, 1, 1); });
      result.push(Array.from(new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())));
    }
    return result;
  });
  return { config: { schemaVersion: 1, entry: '/src/App.tsx', mode: sdkMode, profileId: 'game-2d-v1', dependencies: {}, assets: {
    markerA: { source: '/assets/marker-a.png', type: 'Texture2D' }, markerB: { source: '/assets/marker-b.png', type: 'Texture2D' },
    floorShape: { source: '/assets/floor.tres', type: 'RectangleShape2D' }, actorShape: { source: '/assets/actor.tres', type: 'CapsuleShape2D' },
  } }, selected: '/src/App.tsx', files: {
    '/src/App.tsx': source, '/assets/marker-a.png': images[0], '/assets/marker-b.png': images[1],
    '/assets/floor.tres': '[gd_resource type="RectangleShape2D" format=3]\n[resource]\nsize = Vector2(400, 20)\n',
    '/assets/actor.tres': '[gd_resource type="CapsuleShape2D" format=3]\n[resource]\nradius = 8.0\nheight = 30.0\n',
  } };
}

export async function waitGame2D(page, runId) {
  await page.waitForFunction(runId => playground.events.some(event => event.runId === runId && event.text?.includes('GAME2D_NATIVE_COMPOSITION_OK')),
    runId, { timeout: 90000 });
  const events = await page.evaluate(runId => playground.events.filter(event => event.runId === runId), runId);
  assert(events.some(event => event.text?.includes('GAME2D_COLD_LOADING')), 'the cold mixed resource load passes through Suspense');
  assert(events.some(event => event.text?.includes('GAME2D_COLLISION_OK')));
  assert(events.some(event => event.text?.includes('GAME2D_STABLE_SWAP_HUD_PAUSE_OK')));
  assert(!events.some(event => event.type === 'log' && event.level === 'error'), JSON.stringify(events));
  const event = events.find(event => event.text?.includes('GAME2D_NATIVE_COMPOSITION_OK'));
  const state = JSON.parse(event.text.slice(event.text.indexOf('{')));
  for (const name of ['realMoveAndSlide', 'mixedResources', 'resetObserved', 'stableTextureSwap', 'hudPreservedPhysics', 'oldHandleInvalid', 'staleCommandRejected']) assert.equal(state[name], true, name);
  assert(state.pausedFrames >= 8 && state.collisions > 5);
  return state;
}

/** The same exact combination is exercised independently in each SDK mode. */
export async function verifyGame2D(page, { repo, out, browserFamily, browserVersion, expectedProfile }) {
  const checks = [], coverage = [];
  let productionProject;
  for (const sdkMode of ['production', 'development']) {
    const project = await game2DProject(page, repo, sdkMode);
    if (sdkMode === 'production') productionProject = project;
    await page.evaluate(project => playground.importProject(project), project);
    const runId = await page.evaluate(() => playground.runs.at(-1).runId);
    const native = await waitGame2D(page, runId);
    // Validate actual PCK payloads, not merely the pre-pack source Map.
    const packed = await page.evaluate(async () => {
      const artifact = playground.lastArtifact, pack = artifact.pack;
      const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength), decoder = new TextDecoder();
      if (view.getUint32(0, true) !== 0x43504447 || view.getUint32(4, true) !== 3) throw Error('Bad PCK header');
      const base = Number(view.getBigUint64(24, true)); let cursor = Number(view.getBigUint64(32, true));
      const count = view.getUint32(cursor, true), entries = {}; cursor += 4;
      for (let index = 0; index < count; index++) {
        const length = view.getUint32(cursor, true); cursor += 4;
        const name = decoder.decode(pack.slice(cursor, cursor + length)).replace(/\0+$/, ''); cursor += length;
        const offset = Number(view.getBigUint64(cursor, true)) + base; cursor += 8;
        const size = Number(view.getBigUint64(cursor, true)); cursor += 8 + 16 + 4;
        if (offset < base || offset + size > pack.length) throw Error('Invalid PCK payload');
        entries['res://' + name] = pack.slice(offset, offset + size);
      }
      const sha = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
      const resources = [];
      for (const [id, resource] of Object.entries(artifact.manifest.resources)) {
        const bytes = entries[resource.uri];
        resources.push({ id, type: resource.type, sha256: await sha(bytes), sealedSha256: resource.sha256, text: decoder.decode(bytes) });
      }
      return { profile: artifact.manifest.profile, mode: artifact.manifest.mode, buildKey: artifact.buildKey,
        packSha256: await sha(pack), project: decoder.decode(entries['res://project.godot']), resources };
    });
    assert.deepEqual(packed.profile, expectedProfile);
    assert.equal(packed.mode, sdkMode);
    assert.match(packed.project, /2d\/physics_engine="GodotPhysics2D"/);
    assert.match(packed.project, /3d\/physics_engine="Dummy"/);
    assert.equal(packed.resources.length, 4);
    for (const resource of packed.resources) {
      assert.equal(resource.sha256, resource.sealedSha256);
      assert.match(resource.text, resource.type === 'Texture2D' ? /type="ImageTexture"/ : new RegExp('type="' + resource.type + '"'));
    }
    // Browser screenshots observe the compositor, so this also verifies native
    // parent-transform inheritance instead of only trusting a local position.
    const canvas = page.frameLocator('#preview iframe').locator('canvas');
    const canvasSize = await canvas.evaluate(element => ({ width: element.width, height: element.height }));
    const screenshot = await canvas.screenshot({ path: resolve(out, 'game-2d-' + sdkMode + '-canvas.png') });
    const rendered = await page.evaluate(async ({ png, canvasSize, position, local }) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(png)], { type: 'image/png' }));
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
        const scaleX = bitmap.width / canvasSize.width, scaleY = bitmap.height / canvasSize.height;
        const x = (position.x + local.x) * scaleX, y = (position.y + local.y) * scaleY;
        let spritePixels = 0;
        for (let row = Math.max(0, Math.floor(y - 8 * scaleY)); row < Math.min(bitmap.height, y + 8 * scaleY); row++) {
          for (let col = Math.max(0, Math.floor(x - 10 * scaleX)); col < Math.min(bitmap.width, x + 10 * scaleX); col++) {
            const offset = (row * bitmap.width + col) * 4, r = data[offset], g = data[offset + 1], b = data[offset + 2];
            if ((b > 180 && r < 70 && g < 70) || (r > 180 && g > 180 && b < 70)) spritePixels++;
          }
        }
        return { spritePixels, width: bitmap.width, height: bitmap.height, expectedX: x, expectedY: y };
      } finally { bitmap.close(); }
    }, { png: Array.from(screenshot), canvasSize, position: native.position, local: native.spriteLocal });
    assert(rendered.spritePixels >= 8, 'the blue/yellow sprite is rendered at its moved parent position: ' + JSON.stringify(rendered));
    await page.screenshot({ path: resolve(out, 'game-2d-' + sdkMode + '.png'), fullPage: true });
    if (sdkMode === 'production') {
      const source = project.files['/assets/floor.tres'];
      await page.evaluate(() => playground.setFile('/assets/floor.tres', '[gd_resource type="RectangleShape2D" format=3]\n[resource]\nsize = Broken(1)\n'));
      const failure = await page.evaluate(() => playground.run().then(() => '', error => String(error)));
      assert.match(failure, /E_ASSET_/);
      assert.equal(await page.locator('#preview iframe').count(), 1, 'bad mixed assets retain the last working engine');
      assert.equal(await page.evaluate(() => playground.runs.at(-1).runId), runId);
      await page.evaluate(source => playground.setFile('/assets/floor.tres', source), source);
      checks.push({ name: 'game-2d-invalid-asset-preserves-preview', status: 'passed', profileId: 'game-2d-v1', sdkMode, browserFamily, browserVersion });
    }
    const exit = await page.evaluate(() => playground.stop());
    assert.equal(exit.reason, 'clean-exit'); assert.equal(exit.code, 0); assert.equal(exit.runId, runId);
    checks.push({ name: 'game-2d-native-composition', status: 'passed', profileId: 'game-2d-v1', sdkMode, runId, browserFamily, browserVersion,
      evidence: { ...packed, resources: packed.resources.map(({ text, ...resource }) => resource), native, rendered } });
    coverage.push({ profileId: 'game-2d-v1', sdkMode, browserFamily, browserVersion, status: 'passed', checks: ['game-2d-native-composition'] });
  }
  return { checks, coverage, productionProject };
}
