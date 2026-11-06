import assert from 'node:assert/strict';
import { resolve } from 'node:path';

/** Play the editable demos through real Godot canvas input. No engine mocks. */
export async function verifyDemos(page, out) {
  const checks = [];
  let runId;
  const canvas = () => page.frameLocator('#preview iframe').locator('canvas');
  const click = (x, y) => canvas().click({ position: { x, y } });
  async function latest(tag) {
    return page.evaluate(({ runId, tag }) => {
      const event = playground.events.findLast(event => event.runId === runId && event.text?.startsWith(tag + ' '));
      return event ? JSON.parse(event.text.slice(event.text.indexOf('{'))) : null;
    }, { runId, tag });
  }
  async function wait(tag, values) {
    await page.waitForFunction(({ runId, tag, values }) => {
      const event = playground.events.findLast(event => event.runId === runId && event.text?.startsWith(tag + ' '));
      if (!event) return false;
      const state = JSON.parse(event.text.slice(event.text.indexOf('{')));
      return Object.entries(values).every(([key, value]) => state[key] === value);
    }, { runId, tag, values }, { timeout: 15000 });
    return latest(tag);
  }
  async function start(name) {
    const previousRuns = await page.evaluate(() => playground.runs.length);
    await page.click('#examples-menu > summary');
    await page.click(`[data-example="${name}"]`);
    assert.equal(await page.locator('#examples-menu').getAttribute('open'), null);
    await page.waitForFunction(name => {
      const project = playground.exportProject(), source = project.files['/src/App.tsx'];
      return name === 'starter' ? '/src/game.ts' in project.files
        : source.includes(({ state: 'Theme.Provider', media: 'PIXEL_STUDIO', physics: 'BOUNCE_STATUS', game2d: 'GAME2D_STATUS' })[name]);
    }, name);
    assert.equal(await page.locator('#focus-preview').getAttribute('aria-pressed'), 'false');
    await page.waitForFunction(previous => playground.runs.length > previous && document.getElementById('status').textContent === '运行中', previousRuns, { timeout: 90000 });
    assert.deepEqual(await page.evaluate(() => playground.diagnostics), [], name + ': automatic build diagnostics');
    runId = await page.evaluate(() => playground.runs.at(-1).runId);
    await page.waitForFunction(id => playground.events.some(event => event.runId === id && event.text?.includes('GODOT_REACT_BOOT_REPORT')), runId, { timeout: 45000 });
  }
  async function finish(name) {
    assert(!await page.evaluate(id => playground.events.some(event => event.runId === id && event.type === 'log' && event.level === 'error'), runId));
    await page.screenshot({ path: resolve(out, 'demo-' + name + '.png'), fullPage: true });
    assert.equal((await page.evaluate(() => playground.stop())).reason, 'clean-exit');
    checks.push({ name, status: 'passed' });
  }

  await start('starter');
  for (let n = 1; n <= 8; n++) { await click(200, 174); await wait('OUTPOST', { mined: n }); }
  await click(110, 212); await wait('OUTPOST', { drill: 2, ore: 0, mined: 8 });
  for (let n = 1; n <= 6; n++) { await click(200, 174); await wait('OUTPOST', { mined: 8 + n * 2 }); }
  await click(315, 212); await wait('OUTPOST', { drones: 1, ore: 0 });
  await wait('OUTPOST', { mined: 21, ore: 1 });
  await click(110, 274); const paused = await wait('OUTPOST', { paused: true });
  await page.waitForTimeout(1250);
  await click(200, 174); assert.deepEqual(await latest('OUTPOST'), paused, 'Pause disables mining and cleans up the automation timer');
  await click(110, 274); await wait('OUTPOST', { paused: false });
  // Finish the full default mission through native input, including automation.
  for (let n = 0; n < 60 && (await latest('OUTPOST')).mined < 120; n++) {
    const before = await latest('OUTPOST');
    // Automation can finish between the loop condition and this fresh read.
    // At the capped goal the disabled button cannot produce another increase.
    if (before.mined >= 120) break;
    await click(200, 174);
    await page.waitForFunction(({ id, mined }) => {
      const event = playground.events.findLast(event => event.runId === id && event.text?.startsWith('OUTPOST '));
      return event && JSON.parse(event.text.slice(event.text.indexOf('{'))).mined > mined;
    }, { id: runId, mined: before.mined });
  }
  await wait('OUTPOST', { mined: 120 });
  await page.screenshot({ path: resolve(out, 'demo-starter-complete.png'), fullPage: true });
  await click(315, 274); await wait('OUTPOST', { ore: 0, mined: 0, drill: 1, drones: 0, paused: false });
  await finish('starter');

  await start('state');
  await click(348, 134); await wait('SQUAD', { power: 85, energy: 5 });
  await click(348, 188); assert.equal((await latest('SQUAD')).power, 85, 'Over-budget recruitment is disabled');
  await click(120, 262); await wait('SQUAD', { deployed: true });
  await page.screenshot({ path: resolve(out, 'demo-state-deployed.png'), fullPage: true });
  await click(330, 262); await wait('SQUAD', { power: 35, energy: 2, deployed: false });
  await finish('state');

  await start('media');
  await click(207, 44); await wait('PIXEL_STUDIO', { selected: 1 });
  await click(68, 211); await wait('PIXEL_STUDIO', { flipped: true });
  await click(208, 211); await wait('PIXEL_STUDIO', { large: true });
  await click(347, 211); await wait('PIXEL_STUDIO', { palette: 1 });
  await click(347, 44); await wait('PIXEL_STUDIO', { selected: 2 });
  await finish('media');

  await start('physics');
  await wait('BOUNCE_STATUS', { bounces: 1 });
  const snapshot = await latest('BOUNCE_LAB');
  if (snapshot) assert(snapshot.x >= 40 && snapshot.x <= 416 && snapshot.y >= 130 && snapshot.y <= 298);
  await click(165, 70); await wait('BOUNCE_STATUS', { lowGravity: true });
  await click(55, 70);
  await click(286, 70); await wait('BOUNCE_STATUS', { paused: true });
  const frozen = await latest('BOUNCE_LAB');
  await page.waitForTimeout(1250); assert.deepEqual(await latest('BOUNCE_LAB'), frozen, 'Pause freezes the physics callback');
  await click(286, 70); await wait('BOUNCE_STATUS', { paused: false });
  await click(385, 70); await wait('BOUNCE_STATUS', { round: 1, bounces: 0 });
  await wait('BOUNCE_STATUS', { round: 1, bounces: 1 });
  await finish('physics');

  await start('game2d');
  await wait('GAME2D_READY', { round: 0 });
  const layout = await wait('GAME2D_LAYOUT', {});
  const viewport = await canvas().evaluate(element => ({ width: element.width, height: element.height }));
  const floorImage = await page.evaluate(() => {
    const project = playground.exportProject(), bytes = project.files[project.config.assets.crystal.source];
    const view = new DataView(new Uint8Array(bytes).buffer);
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  });
  const floorBounds = {
    left: layout.floor.x - floorImage.width * Math.abs(layout.floorScale.x) / 2,
    right: layout.floor.x + floorImage.width * Math.abs(layout.floorScale.x) / 2,
    top: layout.floor.y - floorImage.height * Math.abs(layout.floorScale.y) / 2,
    bottom: layout.floor.y + floorImage.height * Math.abs(layout.floorScale.y) / 2,
  };
  assert(floorBounds.left >= 0 && floorBounds.right <= viewport.width && floorBounds.top >= 0 && floorBounds.bottom <= viewport.height,
    'the complete native floor sprite must fit inside the real embedded canvas: ' + JSON.stringify({ viewport, floorBounds, layout }));
  assert(layout.rightWall.x > layout.floor.x && layout.rightWall.x < viewport.width, 'the native right wall is inside the canvas');
  assert(layout.hud.x >= 0 && layout.hud.y >= 0 && layout.hud.x + layout.hud.width <= viewport.width && layout.hud.y + layout.hud.height <= viewport.height,
    'the HUD minimum rectangle fits inside the embedded canvas: ' + JSON.stringify({ viewport, layout }));
  const floorScreenshot = await canvas().screenshot({ path: resolve(out, 'demo-game2d-visible-floor.png') });
  const renderedFloor = await page.evaluate(async ({ bytes, viewport, bounds }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const scaleX = bitmap.width / viewport.width, scaleY = bitmap.height / viewport.height;
      let floorPixels = 0, sampledPixels = 0;
      for (let y = Math.ceil(bounds.top * scaleY); y < Math.floor(bounds.bottom * scaleY); y++) {
        for (let x = Math.ceil(bounds.left * scaleX); x < Math.floor(bounds.right * scaleX); x++) {
          const offset = (y * bitmap.width + x) * 4, r = data[offset], g = data[offset + 1], b = data[offset + 2];
          sampledPixels++;
          if (b > 80 && g > 45 && b > r * 1.4) floorPixels++;
        }
      }
      return { floorPixels, sampledPixels, width: bitmap.width, height: bitmap.height };
    } finally { bitmap.close(); }
  }, { bytes: Array.from(floorScreenshot), viewport, bounds: floorBounds });
  assert(renderedFloor.floorPixels >= Math.max(128, renderedFloor.sampledPixels * 0.12),
    'the floor texture must actually be visible in the compositor screenshot: ' + JSON.stringify(renderedFloor));
  checks.push({ name: 'game2d-visible-floor-and-native-layout', status: 'passed', viewport, floorBounds, layout, renderedFloor });
  const initialNative = await latest('GAME2D_NATIVE');
  assert(initialNative?.body && initialNative?.sprite, 'game2d publishes native body and sprite refs');
  await click(195, 102); await wait('GAME2D_STATUS', { paused: true });
  const pausedTick = await wait('GAME2D_TICK', { round: 0, paused: true });
  await click(415, 102); await wait('GAME2D_STATUS', { skin: 'ship', paused: true });
  const changedSkin = await wait('GAME2D_SKIN', { round: 0, skin: 'ship' });
  assert.deepEqual(changedSkin.body, initialNative.body, 'changing a preloaded texture preserves the physical body');
  assert.deepEqual(changedSkin.sprite, initialNative.sprite, 'changing a texture updates the existing native sprite');
  await page.waitForTimeout(1250);
  const stillPaused = await latest('GAME2D_TICK');
  assert.deepEqual(stillPaused, pausedTick, 'HUD/texture changes leave the paused body position and velocity unchanged');
  await click(85, 102); assert.equal((await latest('GAME2D_STATUS')).paused, true, 'Launch stays disabled while paused');
  await click(195, 102); await wait('GAME2D_STATUS', { paused: false });
  await click(85, 102);
  await click(305, 102); await wait('GAME2D_STATUS', { round: 1, skin: 'ship', bounces: 0 });
  const replacement = await wait('GAME2D_NATIVE', { round: 1 });
  assert.notDeepEqual(replacement.body, initialNative.body, 'Reset replaces the native body');
  assert.notDeepEqual(replacement.sprite, initialNative.sprite, 'Reset replaces the full actor subtree');
  await wait('GAME2D_READY', { round: 1 });
  await finish('game2d');
  return checks;
}
