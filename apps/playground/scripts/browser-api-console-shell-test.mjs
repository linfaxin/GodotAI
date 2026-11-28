import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchBrowser, defaultTestDirectory} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runReportedBrowserTest, listenBrowserTestServer as listen, closeBrowserTestServer as close} from './browser-contract-report.mjs';
import {consoleElement as element, openConsoleOperation, invokeConsole, submitConsole, summerResult, viewConsoleCall} from './api-console-browser-helpers.mjs';

const directory = defaultTestDirectory({shellOnly: true});
const output = path.resolve(process.env.PLAYGROUND_API_CONSOLE_SHELL_OUT ??
  fileURLToPath(new URL('../../../../.godotai-logs/api-console-shell/', import.meta.url)));
const reportFile = path.resolve(process.env.PLAYGROUND_API_CONSOLE_SHELL_REPORT ?? path.join(output, 'report.json'));

await runReportedBrowserTest({scope: 'real-main-api-console-shell',
  reportFile,
  run: async test => {
    const profile = JSON.parse(await readFile(path.join(directory, 'shell-profile.json'), 'utf8'));
    assert.equal(profile.shellOnly, true, 'This smoke test requires an explicit shell-only build.');
    await mkdir(output, {recursive: true});
    test.checkpoint({engineExecuted: false, mainReplaced: false, compilerReplaced: false,
      nodeVersion: process.version, profile});
    const server = createStaticServer(directory);
    await listen(server); test.defer(() => close(server));
    const browser = await launchBrowser({browser: 'chromium', headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      ignoreDefaultArgs: ['--disable-back-forward-cache']});
    test.defer(() => browser.close());
    const page = await browser.newPage({viewport: {width: 1536, height: 1000}});
    await page.addInitScript(() => {
      addEventListener('pageshow', event => {if (event.persisted) document.body.dataset.restoredFromHistory = 'true';});
    });
    const pageErrors = [], consoleErrors = [], failedRequests = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('console', entry => {if (entry.type() === 'error') consoleErrors.push(entry.text());});
    page.on('requestfailed', request => failedRequests.push({url: request.url(), error: request.failure()?.errorText}));
    const screenshots = [];
    async function capture(name, target = page) {
      const filename = path.join(output, name + '.png');
      await target.screenshot({path: filename});
      screenshots.push(path.relative(path.dirname(reportFile), filename).split(path.sep).join('/'));
    }
    test.defer(async () => {
      if (!page.isClosed()) await capture('final-state');
      test.checkpoint({pageErrors, consoleErrors, failedRequests, screenshots});
    });
    const inspect = () => page.evaluate(() => {
      const state = window.__playgroundWorkbench.inspect();
      return {projectId: state.projectId, revision: state.revision, files: state.project.files,
        selected: state.project.selected, build: window.godotPlayground.get_project_context().result.latestBuildAttemptId};
    });
    let initial;
    test.stage = 'run';
    await test.step('load-real-main-and-compiler-without-engine', async () => {
      // No route interception: the built main.js, compiler Worker and CSS are the real application.
      await page.goto(`http://127.0.0.1:${server.address().port}/?project=native`, {waitUntil: 'networkidle'});
      await page.waitForFunction(() => window.__playgroundWorkbench?.inspect().project &&
        document.querySelector('#saved')?.textContent === '已自动保存', null, {timeout: 120000});
      await page.locator('#source .monaco-editor').waitFor();
      assert.equal(await page.locator('iframe').count(), 0);
      assert.equal(await page.locator('#run').isDisabled(), true);
      initial = await inspect();
      assert.equal(initial.build, null);
    });
    await test.step('mode-and-per-operation-drafts-preserve-project', async () => {
      await openConsoleOperation(page, 'engine.get_project_context');
      assert.equal(await page.locator('#api-console-pane').isVisible(), true);
      assert.equal(await page.locator('#code-pane').isVisible(), false);
      assert.equal(await page.locator('#api-list .api-list-summary:visible').count(), 26);
      assert.equal(await page.locator('#api-list .api-list-group').count(), 2);
      assert(await page.locator('#api-list').evaluate(node => node.scrollWidth <= node.clientWidth));
      assert(await page.locator('.api-list-summary').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)));
      await element(page, 'input').fill('{invalid unsent API draft');
      await openConsoleOperation(page, 'engine.is_running');
      await openConsoleOperation(page, 'engine.get_project_context');
      assert.equal(await element(page, 'input').inputValue(), '{invalid unsent API draft');
      const card = page.locator('.api-console-card:visible');
      const beforeScroll = await card.evaluate(node => {node.scrollTop = 180; return node.scrollTop;});
      assert(beforeScroll > 0);
      await page.locator('#tabs [data-file-tab]').first().click();
      await openConsoleOperation(page, 'engine.get_project_context');
      assert.equal(await element(page, 'input').inputValue(), '{invalid unsent API draft');
      assert.equal(await card.evaluate(node => node.scrollTop), beforeScroll);
      const current = await inspect();
      assert.equal(current.revision, initial.revision);
      assert.equal(current.projectId, initial.projectId);
      assert.deepEqual(current.files, initial.files);
      assert.equal(current.build, null);
    }, {after: ['load-real-main-and-compiler-without-engine']});
    await test.step('ctrl-enter-invokes-selected-context-once-without-building', async () => {
      await element(page, 'input').fill('{}');
      assert.equal(await element(page, 'history').locator('[data-call-id]').count(), 0);
      await element(page, 'input').press('Control+Enter');
      await page.waitForFunction(() => document.querySelector('.api-console-card:not([hidden]) [data-testid="api-console-history"] [data-phase="settled"]'));
      assert.equal(await element(page, 'history').locator('[data-call-id]').count(), 1);
      const reply = JSON.parse(await element(page, 'result').textContent());
      assert.equal(reply.ok, true);
      assert.equal(reply.result.data.projectId, initial.projectId);
      assert.equal(reply.result.data.editorRevision, initial.revision);
      assert.equal(reply.result.data.latestBuildAttemptId, null);
      assert.equal(reply.result.godotai.compatibility.payload, 'godotai-typed-v1');
      const card = page.locator('.api-console-card:visible');
      await element(page, 'lessons').locator('summary').click();
      const previousScroll = await card.evaluate(node => {node.scrollTop = node.scrollHeight; return node.scrollTop;});
      await openConsoleOperation(page, 'engine.is_running');
      await openConsoleOperation(page, 'engine.get_project_context');
      assert.equal(await card.evaluate(node => node.scrollTop), previousScroll);
      assert(await card.evaluate(node => node.querySelector('textarea').getBoundingClientRect().bottom < node.getBoundingClientRect().top));
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.apiTab), 'engine.get_project_context');
      await page.keyboard.press('Control+Enter');
      assert.equal(await element(page, 'history').locator('[data-call-id]').count(), 1);
      const current = await inspect();
      assert.deepEqual(current.files, initial.files);
      assert.equal(current.revision, initial.revision);
      assert.equal(current.build, null);
      await element(page, 'input').focus();
      await capture('desktop-api');
    }, {after: ['mode-and-per-operation-drafts-preserve-project']});
    await test.step('file-navigation-restores-code-without-changing-source', async () => {
      const file = page.locator('#files .file[data-path]').first();
      await file.click();
      assert.equal(await page.locator('#code-pane').isVisible(), true);
      assert.equal(await page.locator('#api-console-pane').isVisible(), false);
      const current = await inspect();
      assert.deepEqual(current.files, initial.files);
      assert.equal(current.revision, initial.revision);
      await openConsoleOperation(page, 'engine.get_project_context');
      assert.equal(await element(page, 'input').inputValue(), '{}');
    }, {after: ['ctrl-enter-invokes-selected-context-once-without-building']});
    await test.step('mobile-api-remains-visible-and-usable', async () => {
      await page.setViewportSize({width: 390, height: 844});
      await openConsoleOperation(page, 'engine.is_running');
      await openConsoleOperation(page, 'engine.stop');
      assert.equal(await page.locator('#open-files').getAttribute('aria-expanded'), 'false');
      await openConsoleOperation(page, 'engine.get_project_context');
      await page.locator('.api-console-card:visible .api-console-heading').scrollIntoViewIfNeeded();
      await capture('mobile-api-overview');
      await element(page, 'input').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#api-console-pane').isVisible(), true);
      await element(page, 'input').fill('{"mobile_draft":true}');
      assert.deepEqual((await inspect()).files, initial.files);
      assert.equal((await inspect()).revision, initial.revision);
      const geometry = await element(page, 'input').evaluate(node => {
        const rect = node.getBoundingClientRect();
        return {x: rect.x, right: rect.right, width: rect.width, viewport: innerWidth};
      });
      assert(geometry.width > 100 && geometry.x >= 0 && geometry.right <= geometry.viewport + 1,
        'API input overflows the mobile viewport: ' + JSON.stringify(geometry));
      await capture('mobile-api');
      await element(page, 'input').fill('{}');
      await element(page, 'execute').click();
      await page.waitForFunction(() => document.querySelectorAll('.api-console-card:not([hidden]) [data-testid="api-console-history"] [data-phase="settled"]').length === 2);
      assert.equal(JSON.parse(await element(page, 'result').textContent()).result.data.projectId, initial.projectId);
      assert.equal((await inspect()).build, null);
      await element(page, 'execute').scrollIntoViewIfNeeded();
      await capture('mobile-api-controls');
    }, {after: ['file-navigation-restores-code-without-changing-source']});
    await test.step('opening-example-during-workspace-loading-is-a-client-error', async () => {
      const loading = await browser.newPage({viewport: {width: 1280, height: 900}});
      loading.on('pageerror', error => pageErrors.push('loading: ' + String(error)));
      loading.on('console', entry => {if (entry.type() === 'error') consoleErrors.push('loading: ' + entry.text());});
      loading.on('requestfailed', request => failedRequests.push({url: request.url(), error: request.failure()?.errorText}));
      let releaseCatalog;
      const heldCatalog = new Promise(resolve => {releaseCatalog = resolve;});
      const requestedCatalog = loading.waitForRequest('**/catalog.json');
      await loading.route('**/catalog.json', async route => {
        await heldCatalog;
        await route.continue();
      });
      try {
        await loading.goto(`http://127.0.0.1:${server.address().port}/?project=native`, {waitUntil: 'domcontentloaded'});
        await requestedCatalog;
        await openConsoleOperation(loading, 'engine.get_project_context');
        await element(loading, 'open-example').click();
        await loading.waitForFunction(() => document.querySelector('.api-console-card:not([hidden]) [data-testid="api-console-client-error"]')?.textContent.includes('工作区正在初始化'));
        assert.match(await element(loading, 'client-error').textContent(), /工作区正在初始化/);
        const state = await loading.evaluate(() => ({project: window.__playgroundWorkbench.inspect().project,
          context: window.godotPlayground.get_project_context().result}));
        assert.equal(state.project, undefined, 'Opening early must not publish a partial example project.');
        assert.equal(state.context.projectId, null);
        assert.equal(state.context.latestBuildAttemptId, null);
        assert.equal(await element(loading, 'history').locator('[data-call-id]').count(), 0);
        await capture('initializing-example-client-error', loading);
        await openConsoleOperation(loading, 'engine.is_running');
        await openConsoleOperation(loading, 'engine.get_project_context');
        const focusedApi = () => loading.evaluate(() => document.activeElement?.dataset.apiTab);
        assert.equal(await focusedApi(), 'engine.get_project_context');
        releaseCatalog();
        await loading.waitForFunction(() => window.__playgroundWorkbench?.inspect().project &&
          document.querySelector('#saved')?.textContent === '已自动保存', null, {timeout: 120000});
        assert.equal((await loading.evaluate(() => window.godotPlayground.get_project_context().result)).projectId, 'native');
        assert.equal(await focusedApi(), 'engine.get_project_context');
        await loading.keyboard.press('ArrowRight');
        assert.equal(await focusedApi(), 'engine.is_running');
        assert.equal(await loading.locator('[data-api-tab="engine.is_running"]').getAttribute('aria-selected'), 'true');
      } finally {
        releaseCatalog();
        await loading.close();
      }
    }, {after: ['mobile-api-remains-visible-and-usable']});
    await test.step('browser-back-keeps-the-api-console-and-its-session', async () => {
      const draft = '{"preserveUntilRestored":true}';
      await element(page, 'input').fill(draft);
      const settled = element(page, 'history').locator('[data-phase="settled"]');
      const previousCalls = await settled.count();
      const destination = `http://127.0.0.1:${server.address().port}/history-destination`;
      await page.route(destination, route => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>History destination</title><link rel="icon" href="data:,">',
      }), {times: 1});
      const originalStream = await page.evaluate(async () => {
        const api = window.godotPlayground;
        const {stream_id, next_seq} = (await api.summer_call({op: 'engine.recent_events'})).result.data;
        api.summer_call({op: 'engine.wait_for_event', input: {stream_id, since: next_seq, timeout_seconds: 1}})
          .then(reply => {window.restoredLifecycleWaitResult = reply;});
        return stream_id;
      });
      await page.goto(destination);
      await page.goBack({waitUntil: 'commit'});
      await page.locator('body[data-restored-from-history="true"]').waitFor({timeout: 10000});
      assert.equal(await element(page, 'input').inputValue(), draft);
      assert.equal(await settled.count(), previousCalls);
      const restoredReply = await page.waitForFunction(() => window.restoredLifecycleWaitResult, null, {timeout: 5000});
      const restoredWait = summerResult(await restoredReply.jsonValue());
      assert.equal(restoredWait.stream_id, originalStream);
      assert.equal(restoredWait.timed_out, true);
      await element(page, 'input').fill('{}');
      await element(page, 'execute').click();
      await page.waitForFunction(count => document.querySelectorAll('.api-console-card:not([hidden]) [data-testid="api-console-history"] [data-phase="settled"]').length === count, previousCalls + 1);
      assert.equal(JSON.parse(await element(page, 'result').textContent()).ok, true);
    }, {after: ['opening-example-during-workspace-loading-is-a-client-error']});
    await test.step('lifecycle-cursor-fill-and-cancel-through-the-real-console', async () => {
      await page.setViewportSize({width: 1536, height: 1000});
      await openConsoleOperation(page, 'engine.recent_events');
      await element(page, 'input').fill('{}');
      const recent = await submitConsole(page, 'engine.recent_events');
      const cursor = summerResult(recent.reply);
      assert.equal(cursor.next_seq, 0);
      const count = await element(page, 'history').locator('[data-call-id]').count();
      await openConsoleOperation(page, 'engine.wait_for_event');
      await element(page, 'input').fill('{"kinds":["play.started"],"timeout_seconds":30}');
      await viewConsoleCall(page, recent.callId);
      await element(page, 'use-result').click();
      assert.equal(await element(page, 'history').locator('[data-call-id]').count(), count);
      assert.deepEqual(JSON.parse(await element(page, 'input').inputValue()),
        {kinds: ['play.started'], timeout_seconds: 30, since: 0, stream_id: cursor.stream_id});
      await element(page, 'execute').click();
      await element(page, 'cancel').click();
      await page.waitForFunction(() => document.querySelector('.api-console-card:not([hidden]) [data-testid="api-console-result"]')
        ?.textContent.includes('"cancelled"'));
      assert.equal(await element(page, 'execute').isEnabled(), true);
      assert.equal((await inspect()).build, null);
    }, {after: ['browser-back-keeps-the-api-console-and-its-session']});
    await test.step('guarded-script-edit-uses-the-real-workspace', async () => {
      const file = initial.selected;
      const tab = page.locator(`#tabs [data-file-tab="${file}"]`);
      await tab.click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type('// Manual edit before the API write');
      const previous = await inspect();
      assert.match(previous.files[file], /Manual edit before the API write/);
      const path = 'res:/' + file;
      const read = await invokeConsole(page, 'engine.read_file', {path});
      const source = summerResult(read.reply);
      assert.equal(source.content, previous.files[file]);
      assert.equal(source.sha256, createHash('sha256').update(source.content).digest('hex'));
      const content = source.content + '\n// Source edit from the public API\n';
      await openConsoleOperation(page, 'engine.write_file');
      await element(page, 'input').fill(JSON.stringify({path, content}));
      await viewConsoleCall(page, read.callId);
      await element(page, 'use-result').click();
      assert.deepEqual(JSON.parse(await element(page, 'input').inputValue()), {path, content,
        projectId: previous.projectId, expectedEditorRevision: previous.revision, expected_sha256: source.sha256});
      const written = summerResult((await submitConsole(page, 'engine.write_file')).reply);
      assert.equal(written.editorRevision, previous.revision + 1);
      assert.equal(written.sha256, createHash('sha256').update(content).digest('hex'));
      assert.deepEqual(await inspect(), {...previous, revision: written.editorRevision, files: {...previous.files, [file]: content}});
      await page.waitForFunction(() => document.querySelector('#saved')?.textContent === '已自动保存');
      await tab.click();
      await page.keyboard.press('ControlOrMeta+z');
      assert.deepEqual((await inspect()).files, previous.files, 'Undo should only revert the API write');
    }, {after: ['lifecycle-cursor-fill-and-cancel-through-the-real-console']});
    await test.step('no-page-or-console-errors', async () => {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(failedRequests, []);
    }, {after: ['guarded-script-edit-uses-the-real-workspace']});
    return {status: 'passed', browser: {name: browser.browserType().name(), version: browser.version()},
      engineExecuted: false, mainReplaced: false, compilerReplaced: false, nodeVersion: process.version,
      profile, pageErrors, consoleErrors, failedRequests, screenshots};
  },
});
