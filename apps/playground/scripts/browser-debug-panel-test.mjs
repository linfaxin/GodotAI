import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { launchBrowser } from './browser-harness.mjs';
import { createStaticServer } from './serve.mjs';
import { listenBrowserTestServer as listen, closeBrowserTestServer as close } from './browser-contract-report.mjs';

const app = fileURLToPath(new URL('../', import.meta.url));
const testMessage = '<img id="debug-injected" src=x onerror="document.body.dataset.injected=1">';
const harness = await build({
  stdin: {
    resolveDir: app,
    loader: 'ts',
    contents: `
      import { createDebugRecorder, debugFailure } from './src/debug-api';
      import { createPlaygroundApi } from './src/playground-api';
      import { createAgentPanel } from './src/workbench/agent-panel';
      import { createDebugPanel } from './src/workbench/debug-panel';
      import { createWorkbench } from './src/workbench/workbench';
      const workbench = createWorkbench({ selectFile() {}, focusEditor() {}, toast() {} });
      const recorder = createDebugRecorder();
      recorder.setContext({ release: { status: 'unsupported' }, preview: { status: 'unsupported' } });
      const release = { releaseId: 'a'.repeat(64), engineProfile: 'full-engine-v1', descriptorSha256: 'b'.repeat(64) };
      const configuration = { executionBackend: 'worker', presentationBackend: 'direct' };
      const artifact = { variant: 'single-pack', buildKey: 'c'.repeat(64), artifactId: 'd'.repeat(64) };
      let serial = 0;
      let last;
      let delayNextReplay = false;
      let delayedAttempt;
      function buildProject(diagnostics = [], attemptId = recorder.startBuild('fixture-project', 1)) {
        recorder.recordCompileResponse(attemptId, { variant: artifact.variant, manifest: artifact, pack: new Uint8Array([1]), diagnostics });
        recorder.beginPreview(attemptId);
        return attemptId;
      }
      window.debugPanelFixture = {
        run(delayed) {
          recorder.setContext({ projectId: 'fixture-project', editorRevision: 1, release: { status: 'available', value: release }, preview: { status: 'available', value: configuration } });
          const attemptId = buildProject([{ category: 'warning', code: 'W_LINKED_BUILD_FIXTURE', message: 'fixture build warning' }], delayed), generation = ++serial;
          last = { runId: 'run-' + generation, buildKey: artifact.buildKey, generation, revision: 1, documentId: 'doc-' + generation, workerId: 'worker-' + generation, runConfigurationHash: 'e'.repeat(64) };
          const releasePreview = recorder.registerPreview(attemptId, { generation, release, configuration });
          recorder.recordRunEvent({ ...last, type: 'state', state: 'loading-frame' });
          recorder.recordRunEvent({ ...last, type: 'state', state: 'running' });
          releasePreview();
          recorder.recordRunEvent({ ...last, type: 'log', level: 'log', text: 'fixture stdout ' + generation, untrusted: true });
          recorder.recordRunEvent({ ...last, type: 'log', level: 'warn', text: ${JSON.stringify(testMessage)}, untrusted: true });
          return attemptId;
        },
        delayReplay() {
          delayNextReplay = true;
          const schedule = window.setTimeout;
          window.setTimeout = (callback, timeout, ...args) => {
            if (timeout === 30000) {
              window.setTimeout = schedule;
              timeout = 1;
            }
            return schedule.call(window, callback, timeout, ...args);
          };
        },
        finishDelayedReplay() {
          const attemptId = window.debugPanelFixture.run(delayedAttempt);
          delayedAttempt = undefined;
          return {attemptId, runId: last.runId};
        },
        rejectPreview() {
          recorder.rejectPreview(buildProject(), debugFailure('preview-prepare', new Error(${JSON.stringify(testMessage)})));
          workbench.logAdded('error', true);
        },
        workbenchError() {
          const line = document.createElement('div');
          line.className = 'log-line error';
          line.textContent = 'fixture workbench action failed';
          document.querySelector('#logs').append(line);
          workbench.logAdded('error');
        },
        showsRun: runId => panel.showsRun(runId),
        failBuild() {
          const attemptId = recorder.startBuild('fixture-project', 1);
          recorder.recordCompileResponse(attemptId, { diagnostics: [{ category: 'error', code: 2322, file: '/src/start.ts', line: 1, column: 1, message: 'fixture type error' }] });
          workbench.showProblems();
        },
        losePreview() {
          recorder.recordRunEvent({ type: 'exit', report: { ...last, reason: 'forced-frame-disposal' } });
        },
        trimEvents() {
          for (let index = 0; index < 500; index++) recorder.recordRunEvent({ ...last, type: 'project', data: { index } });
          recorder.recordRunEvent({ ...last, type: 'log', level: 'warn', text: 'fixture retained after trim', untrusted: true });
        },
      };
      const playground = createPlaygroundApi(recorder, {
        supportsProject: () => true,
        check: async () => recorder.finishCheck(recorder.startCheck('fixture-project', 1), {
          diagnostics: [{ category: 'warning', message: ${JSON.stringify(testMessage)} }],
        }),
        play: () => {
          if (delayNextReplay) {
            delayNextReplay = false;
            delayedAttempt = recorder.startBuild('fixture-project', 1);
            return delayedAttempt;
          }
          if (recorder.api.getContext().result.activeRunId) window.debugPanelFixture.losePreview();
          return window.debugPanelFixture.run();
        },
        stopRun: runId => {
          if (last?.runId !== runId) return undefined;
          window.debugPanelFixture.losePreview();
          return Promise.resolve();
        },
      });
      window.godotPlayground = playground.api;
      const panel = createDebugPanel(recorder.api, playground.api);
      recorder.subscribe(panel.refresh);
      createAgentPanel(playground);
    `,
  },
  bundle: true,
  write: false,
  platform: 'browser',
});

const server = createStaticServer(new URL('../web/', import.meta.url).pathname);
let browser;
try {
  await listen(server);
  browser = await launchBrowser({ browser: 'chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1152, height: 780 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/main.js', route => route.fulfill({ contentType: 'text/javascript', body: harness.outputFiles[0].text }));
  await page.route('**/main.css', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);

  await page.locator('#console-tab').focus();
  await page.keyboard.press('End');
  await page.locator('#debug-panel').waitFor();
  assert.equal(await page.locator('#debug-tab').getAttribute('aria-selected'), 'true');
  await page.waitForFunction(() => document.querySelector('#debug-build')?.dataset.status === 'empty');
  assert.match(await page.locator('#debug-context').textContent(), /仅提供编辑器/);
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#problems-tab').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#debug-tab').getAttribute('aria-selected'), 'true');

  await page.locator('#debug-open-docs').click();
  assert(await page.locator('#debug-docs #debug-run-example').isVisible());
  assert(await page.locator('#debug-docs #agent-replay').isVisible());
  const documented = await page.locator('#debug-docs code').allTextContents();
  for (const field of ['diagnostics.observed', 'preview.status', 'exit.evidence']) assert(documented.includes(field));
  const source = await page.locator('#debug-api-example').textContent();
  await page.locator('#debug-copy-example').click();
  await page.waitForFunction(() => document.querySelector('#debug-example-status')?.textContent === '已复制');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), source);
  async function assertExample() {
    const result = await page.evaluate(source);
    await page.locator('#debug-run-example').click();
    assert.deepEqual(JSON.parse(await page.locator('#debug-example-result').textContent()), result);
  }
  await assertExample();
  await page.locator('#debug-open-docs').click();
  assert(await page.locator('#agent-replay').isHidden());

  await page.evaluate(() => window.debugPanelFixture.run());
  await page.locator('#debug-run[data-run-id="run-1"]').waitFor();
  assert(await page.locator('#debug-linked-build').isHidden());
  await page.evaluate(() => window.debugPanelFixture.rejectPreview());
  await page.locator('#debug-build[data-status="succeeded"][data-preview-status="rejected"]').waitFor();
  assert.equal(await page.locator('#debug-tab').getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('#debug-build-notes').textContent(), /preview-prepare/);
  assert.equal(await page.locator('#debug-run').getAttribute('data-run-id'), 'run-1');
  await page.locator('#debug-linked-build[data-attempt-id="build-1"][data-status="succeeded"]').waitFor();
  assert.match(await page.locator('#debug-linked-build-notes').textContent(), /W_LINKED_BUILD_FIXTURE.*fixture build warning/);
  await page.locator('#debug-linked-build-details summary').click();
  await page.waitForFunction(() => document.querySelector('#debug-linked-build-json')?.textContent.includes('build-1'));
  const linkedBuild = await page.evaluate(() => window.godotPlayground.get_build({attemptId: 'build-1'}).result);
  assert.deepEqual(JSON.parse(await page.locator('#debug-linked-build-json').textContent()), linkedBuild);
  assert.match(await page.locator('#debug-events').textContent(), /fixture stdout 1/);
  assert.ok((await page.locator('#debug-events').textContent()).includes(testMessage));
  assert.ok((await page.locator('#debug-build-notes').textContent()).includes(testMessage));
  assert.equal(await page.locator('#debug-injected').count(), 0);
  await page.locator('#debug-log-filter').selectOption('warn');
  await page.waitForFunction(() => !document.querySelector('#debug-events')?.textContent.includes('fixture stdout'));
  assert.equal(await page.locator('#debug-events [data-level="warn"]').count(), 1);

  await page.evaluate(() => window.debugPanelFixture.failBuild());
  await page.locator('#debug-build[data-status="failed"]').waitFor();
  assert.equal(await page.locator('#debug-tab').getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('#debug-build-notes').textContent(), /\/src\/start\.ts:1:1/);

  await page.evaluate(() => { window.debugPanelFixture.losePreview(); window.debugPanelFixture.run(); });
  await page.locator('#debug-run[data-run-id="run-2"]').waitFor();
  await page.locator('#debug-show-previous').click();
  await page.locator('#debug-run[data-run-id="run-1"][data-exit-evidence="editor-local"]').waitFor();
  assert.deepEqual(await page.evaluate(() => [window.debugPanelFixture.showsRun('run-1'), window.debugPanelFixture.showsRun('run-2')]), [true, false]);
  assert.doesNotMatch(await page.locator('#debug-run-fields').textContent(), /原生退出码|宿主清理/);
  await page.locator('#debug-show-current').click();
  await page.locator('#debug-run[data-run-id="run-2"]').waitFor();
  await page.locator('#debug-run-details summary').click();
  await page.waitForFunction(() => document.querySelector('#debug-run-json')?.textContent.includes('run-2'));
  assert.equal(JSON.parse(await page.locator('#debug-run-json').textContent()).runId, 'run-2');
  await page.evaluate(() => window.debugPanelFixture.trimEvents());
  await page.locator('#debug-events-gap').waitFor();
  assert.match(await page.locator('#debug-events-gap').textContent(), /移出记录/);
  assert.equal(await page.locator('#debug-events li').count(), 1);
  assert.match(await page.locator('#debug-events').textContent(), /fixture retained after trim/);
  await page.locator('#debug-open-docs').click();
  await assertExample();

  await page.locator('#debug-show-previous').click();
  await page.locator('#debug-run[data-run-id="run-1"]').waitFor();
  await page.locator('#debug-events li').waitFor();
  await page.evaluate(() => {
    window.debugPanelFixture.losePreview(); window.debugPanelFixture.run();
    window.debugPanelFixture.losePreview(); window.debugPanelFixture.run();
  });
  await page.locator('#debug-run[data-state="not-found"]').waitFor();
  assert.equal(await page.locator('#debug-events li').count(), 0);
  assert(await page.locator('#debug-events-gap').isHidden());
  assert(await page.locator('#debug-linked-build').isHidden());
  assert.equal(await page.locator('#debug-linked-build-json').textContent(), '');
  await page.locator('#debug-events-empty').waitFor();
  assert.match(await page.locator('#debug-events-empty').textContent(), /超出保留范围/);
  await page.locator('#debug-show-current').click();
  await page.locator('#debug-run[data-run-id="run-4"]').waitFor();
  await page.locator('#debug-events li').waitFor();

  await page.locator('#agent-replay').click();
  await page.getByText('预览已启动', { exact: true }).waitFor();
  assert.match(await page.locator('#agent-trace').textContent(), /"name": "wait_for_event"/);
  assert.ok((await page.locator('#agent-trace').textContent()).includes(JSON.stringify(testMessage).slice(1, -1)));
  await page.locator('#agent-stop').click();
  await page.getByText('已取得退出回执', { exact: true }).waitFor();
  assert.match(await page.locator('#agent-trace').textContent(), /editor-local/);

  await page.evaluate(() => window.debugPanelFixture.delayReplay());
  await page.locator('#agent-replay').click();
  await page.getByText('等待超时，仍在跟踪本次预览', { exact: true }).waitFor();
  assert.equal(await page.locator('#agent-stop').isDisabled(), true);
  const late = await page.evaluate(() => window.debugPanelFixture.finishDelayedReplay());
  await page.getByText('预览已启动', { exact: true }).waitFor();
  assert.equal(await page.locator('#agent-stop').isEnabled(), true);
  const crossRealmAbort = await page.evaluate(async runId => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    try {
      const controller = new frame.contentWindow.AbortController();
      const pending = window.godotPlayground.wait_for_event({runId, until: 'exited'}, controller.signal);
      controller.abort();
      return await pending;
    } finally { frame.remove(); }
  }, late.runId);
  assert.equal(crossRealmAbort.error.code, 'cancelled');
  await page.locator('#agent-stop').click();
  await page.getByText('已取得退出回执', { exact: true }).waitFor();
  const lateRun = await page.evaluate(runId => window.godotPlayground.get_run({runId}).result, late.runId);
  assert.equal(lateRun.attemptId, late.attemptId);
  assert.equal(lateRun.state, 'exited');

  await page.setViewportSize({ width: 320, height: 720 });
  assert.equal(await page.locator('#debug-panel').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.evaluate(() => window.debugPanelFixture.workbenchError());
  assert.equal(await page.locator('#console-tab').getAttribute('aria-selected'), 'true');
  await page.getByText('fixture workbench action failed', { exact: true }).waitFor();
  assert.equal(await page.locator('.dock-toolbar').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  assert.equal(await page.locator('body').getAttribute('data-injected'), null);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', scope: 'controlled-debug-panel', engineExecuted: false }));
} finally {
  await browser?.close();
  await close(server);
}
