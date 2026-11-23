import assert from 'node:assert/strict';

export const consoleElement = (page, name) => page.locator('.api-console-card:visible').getByTestId('api-console-' + name);

export async function openConsoleOperation(page, operationId) {
  const tab = page.locator(`[data-api-tab="${operationId}"]`);
  if (await tab.count()) {await tab.click(); return;}
  const navigation = page.locator('#api-navigation');
  if (!await navigation.isVisible()) await page.locator('#open-files:visible, #toggle-files:visible').first().click();
  if (!await navigation.evaluate(node => node.open)) await navigation.locator('summary').click();
  await navigation.locator(`[data-api-operation="${operationId}"]`).click();
}

export async function viewConsoleCall(page, callId) {
  await consoleElement(page, 'history').locator(`[data-call-id="${callId}"] [data-action="view-history"]`).click();
}

/** Execute through the visible UI. Reading the public API is unnecessary here. */
export async function invokeConsole(page, operationId, input, {refreshTarget = true, timeout = 30_000} = {}) {
  await openConsoleOperation(page, operationId);
  if (refreshTarget) await consoleElement(page, 'update-target').click();
  await consoleElement(page, 'input').fill(JSON.stringify(input, null, 2));
  return submitConsole(page, operationId, {timeout});
}

/** Execute the current draft without replacing the IDs populated by the page. */
export async function submitConsole(page, operationId, {timeout = 30_000} = {}) {
  assert.equal(await page.locator('.api-console-card:visible').getAttribute('data-api-card'), operationId);
  const previous = await consoleElement(page, 'history').locator('[data-call-id]').evaluateAll(nodes => nodes.map(node => node.dataset.callId));
  await consoleElement(page, 'execute').click();
  const clientError = await consoleElement(page, 'client-error').textContent();
  assert.equal(clientError?.trim(), '', 'Console refused ' + operationId + ': ' + clientError);
  const handle = await page.waitForFunction(previous => {
    const rows = [...document.querySelectorAll('.api-console-card:not([hidden]) [data-testid="api-console-history"] [data-call-id]')];
    return rows.find(row => !previous.includes(row.dataset.callId))?.dataset.callId;
  }, previous, {timeout});
  const callId = await handle.jsonValue();
  await page.waitForFunction(callId => {
    const row = document.querySelector('.api-console-card:not([hidden]) [data-testid="api-console-history"] [data-call-id="' + callId + '"]');
    return row && (row.dataset.phase === 'settled' || row.dataset.phase === 'thrown');
  }, callId, {timeout});
  const row = consoleElement(page, 'history').locator('[data-call-id="' + callId + '"]');
  assert.equal(await row.getAttribute('data-phase'), 'settled', await row.textContent());
  const text = await consoleElement(page, 'result').textContent();
  let reply;
  try { reply = JSON.parse(text); }
  catch { throw Error('Console result is not complete JSON for ' + operationId + ': ' + text?.slice(0, 2048)); }
  return {callId, reply};
}

export function consoleResult(reply) {
  assert.equal(reply?.ok, true, JSON.stringify(reply));
  return reply.result;
}
export function summerResult(reply) { return consoleResult(reply).data; }

export async function readConsolePng(page) {
  const image = consoleElement(page, 'attachments').locator('img').last();
  await image.waitFor();
  const result = await image.evaluate(async element => {
    await element.decode();
    const blob = await (await fetch(element.src)).blob();
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const rgba = (x, y) => Array.from(context.getImageData(Math.floor(x * bitmap.width / 960), Math.floor(y * bitmap.height / 640), 1, 1).data);
      return {bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), mimeType: blob.type,
        width: bitmap.width, height: bitmap.height,
        pixels: {initialMarker: rgba(64, 256), movedMarker: rgba(192, 256), health40: rgba(80, 32), health100: rgba(160, 32)}};
    } finally { bitmap.close(); }
  });
  assert.equal(result.mimeType, 'image/png');
  assert(result.width > 0 && result.height > 0);
  assert.deepEqual(result.bytes.slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
  return result;
}
