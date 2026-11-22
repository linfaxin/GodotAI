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
      import { createSummerDispatcher } from './src/summer-adapter';
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
      let legacyColor = 'red';
      let writeEnabled = false, playerX = 64, renderSerial = 0, sampleSeq = 0;
      let propertiesEnabled=false,health=100,moveStep=64,propertySequence=0;
      let holdPropertyRead=false,propertyReadPending=false,finishPropertyRead;
      const player = {name: 'Player', type: 'Node2D', path: '/root/Player', parentPath: '/root', instanceId: '42'};
      function buildProject(diagnostics = [], attemptId = recorder.startBuild('fixture-project', 1)) {
        recorder.recordCompileResponse(attemptId, {
          variant: artifact.variant, manifest: artifact, pack: new Uint8Array([1]), diagnostics, sourceHash: 'f'.repeat(64)
        });
        recorder.beginPreview(attemptId);
        return attemptId;
      }
      window.debugPanelFixture = {
        run(delayed) {
          playerX = 64;
          health=100;moveStep=64;propertySequence=0;
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
        enableRuntimeWrite() { writeEnabled = true; },
        enableRuntimeProperties() { propertiesEnabled=true;writeEnabled=true;player.path='/root/Main/Player'; },
        holdPropertyRead() { holdPropertyRead=true; },
        propertyReadPending:()=>propertyReadPending,
        switchPropertyProject() { recorder.setContext({projectId:'other-project',editorRevision:2});finishPropertyRead(); },
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
          if (writeEnabled) recorder.recordRunEvent({type: 'exit', report: {
            ...last, reason: 'clean-exit', engineOutcome: {kind: 'native-exit', code: 0},
            hostCleanup: {status: 'complete'}, sessionFacts: {nativeExit: {code: 0}, hostCleanup: 'complete'},
          }});
          else window.debugPanelFixture.losePreview();
          return Promise.resolve();
        },
        observation: () => ({
          observationState: () => ({supported: writeEnabled, ready: writeEnabled}),
          async getRuntimeTree() { return {ok: true, result: {nodes: [player], run: last,releaseId:release.releaseId}}; },
          async inspectRuntimeNode() { return {ok: true, result: {
            node: player, run: last, sampleSeq: ++sampleSeq,
            properties: [{name: 'position', value: {x: playerX, y: 256}}],
          }}; },
        }),
        runtimeWrite: () => ({
          runtimeWriteState: () => ({supported: writeEnabled, ready: writeEnabled}),
          async setRuntimeProperty({path, expectedInstanceId, value}) {
            if (path !== player.path || expectedInstanceId !== player.instanceId) throw Error('Wrong player');
            playerX = value.x;
            return {ok: true, result: {requestId: 'fixture-write', run: last, releaseId: release.releaseId,
              expectedInstanceId, outcome: 'applied', observedValue: value}};
          },
        }),
        runtimeProperties:()=>({
          runtimePropertiesState:runId=>({supported:propertiesEnabled,ready:propertiesEnabled&&recorder.api.getRun(runId).result?.state==='running',version:1}),
          async describeRuntimeProperties(input){
            const types={health:'int',move_step:'float',can_move:'bool',display_name:'string'};
            const properties=input.names.map(name=>types[name]?{name,status:'found',descriptor:{name,type:types[name],origin:'godotjs_export',declaredType:{variantType:{int:2,float:3,bool:1,string:4}[types[name]],name:types[name]},readAccess:{status:'candidate'},writeAccess:{status:'candidate'},readMayExecuteScript:true,writeMayExecuteScript:true,shadowedExport:false}}:{name,status:'absent'}).sort((a,b)=>a.name.localeCompare(b.name));
            return {ok:true,receipt:propertyReceipt(input),result:{mode:'names',properties,frame:frame(),scan:{metadataEntriesVisited:4,inheritanceLevelsVisited:1,truncated:false,reasons:[]}}};
          },
          async readRuntimeProperties(input,signal){
            if(holdPropertyRead){
              holdPropertyRead=false;propertyReadPending=true;
              try{await new Promise((resolve,reject)=>{finishPropertyRead=resolve;signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});});}
              finally{propertyReadPending=false;finishPropertyRead=undefined;}
            }
            const values={health,move_step:moveStep,can_move:true,display_name:'Player 你好',position:{x:playerX,y:256}};
            return {ok:true,receipt:propertyReceipt(input),result:{outcome:'completed',frame:frame(),properties:input.properties.map(({name,expectedType})=>({name,expectedType,status:'value',readEntered:true,value:{type:expectedType,value:values[name]}}))}};
          },
          async writeRuntimeProperty(input){
            const before=input.property==='health'?health:input.property==='move_step'?moveStep:{x:playerX,y:256};
            if(input.property==='health')health=input.value.value;
            else if(input.property==='move_step')moveStep=input.value.value;
            else playerX=input.value.value.x;
            return {ok:true,receipt:propertyReceipt(input),result:{property:input.property,requestedValue:input.value,outcome:'applied',phase:'readback',writeEntered:true,frame:frame(),beforeValue:{type:input.value.type,value:before},comparisonValue:input.value,observedValue:input.value}};
          },
        }),
        summerCall:(input,signal)=>summer(input,signal),
        interaction: () => ({
          interactionState: () => ({supported: true, ready: true}),
          async screenshot() {
            if (writeEnabled) {
              const canvas = new OffscreenCanvas(96, 64), context = canvas.getContext('2d');
              context.fillStyle = 'red';
              context.fillRect(0, 0, 96, 64);
              context.fillStyle = 'white';
              context.fillRect(Math.floor(playerX / 10) - 1, 24, 3, 4);
              if(propertiesEnabled){context.fillStyle='black';context.fillRect(2.4,2.4,20,1.6);context.fillStyle='lime';context.fillRect(2.4,2.4,health*.2,1.6);}
              const png = await canvas.convertToBlob({type: 'image/png'});
              return {ok: true, result: {width: 96, height: 64, sourceWidth: 96, sourceHeight: 64,
                run:last,releaseId:release.releaseId,requestId:'capture-'+renderSerial,geometry:{epoch:1},iteration:renderSerial,
                renderSerial: ++renderSerial, mimeType: png.type, bytes: await png.arrayBuffer()}};
            }
            const canvas = new OffscreenCanvas(1, 1), context = canvas.getContext('2d');
            context.fillStyle = legacyColor;
            context.fillRect(0, 0, 1, 1);
            const png = await canvas.convertToBlob({type: 'image/png'});
            return {ok: true, result: {width: 1, height: 1, mimeType: png.type, bytes: await png.arrayBuffer()}};
          },
          gameInput({gesture}) {
            if(propertiesEnabled){if(gesture.code==='ArrowRight')playerX+=moveStep;else if(gesture.code==='ArrowDown')playerX=64;else throw Error('Wrong property input');return {ok:true,result:{operationId:'properties-input'}};}
            if (gesture.code !== 'Space') throw Error('Legacy replay must use Space');
            legacyColor = 'lime';
            return {ok: true, result: {operationId: 'legacy-input'}};
          },
          async waitForInput() {
            return {ok: true, result: {operation: {status: 'dispatched',down:'dispatched',up:'dispatched',run:last}}};
          },
        }),
      });
      const frame=()=>({process:String(propertySequence),physics:String(propertySequence),drawn:String(renderSerial)});
      function propertyReceipt(input){const accessSequence=++propertySequence;return {requestId:last.runId+':'+accessSequence,accessSequence,run:last,releaseId:release.releaseId,path:input.path,expectedInstanceId:input.expectedInstanceId};}
      const summer=createSummerDispatcher({
        captureContext:()=>({projectId:'fixture-project',editorRevision:1,activeRunId:recorder.api.getContext().result.activeRunId,pendingAttemptId:null}),
        getProjectContext:()=>playground.api.get_project_context(),play:input=>playground.api.play(input),cancelLaunch(){},
        getBuild:input=>playground.api.get_build(input),getRun:input=>playground.api.get_run(input),stop:input=>playground.api.stop(input),
        getRuntimeTree:(input,signal)=>playground.api.get_runtime_tree(input,signal),inspectRuntimeNode:(input,signal)=>playground.api.inspect_runtime_node(input,signal),
        describeRuntimeProperties:(input,signal)=>playground.api.describe_runtime_properties(input,signal),
        writeRuntimeProperty:(input,signal)=>playground.api.write_runtime_property(input,signal),runtimeSet:(input,signal)=>playground.api.runtime_set(input,signal),
        screenshot:(input,signal)=>playground.api.screenshot(input,signal),
      });
      window.godotPlayground = playground.api;
      const panel = createDebugPanel(recorder.api, playground.api);
      recorder.subscribe(panel.refresh);
      createAgentPanel(playground, {
        unavailable: () => undefined,
        supportsRuntimeObservation: () => false,
        supportsRuntimeWrite: () => writeEnabled,
        supportsRuntimeProperties:()=>propertiesEnabled,
        open: async () => { legacyColor = 'red'; return 'fixture-project'; },
        openProperties:async()=> 'fixture-project',
        cancelLaunch() {},
      });
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
  await page.getByText('编辑器已关闭预览，未收到退出回执', { exact: true }).waitFor();
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
  await page.getByText('编辑器已关闭预览，未收到退出回执', { exact: true }).waitFor();
  const lateRun = await page.evaluate(runId => window.godotPlayground.get_run({runId}).result, late.runId);
  assert.equal(lateRun.attemptId, late.attemptId);
  assert.equal(lateRun.state, 'exited');

  await page.locator('#agent-playtest').click();
  await page.getByText('已验证画面变化，编辑器已关闭预览，未收到退出回执', { exact: true }).waitFor();
  assert.deepEqual(await page.locator('#agent-observations figcaption').allTextContents(), ['输入前', '输入后']);
  const legacyTrace = await page.locator('#agent-trace').textContent();
  assert.match(legacyTrace, /"code": "Space"/);
  assert.doesNotMatch(legacyTrace, /"name": "get_runtime_tree"/);
  const beforeWrite = await page.evaluate(() => window.godotPlayground.get_project_context());
  await page.locator('#agent-runtime-write').click();
  await page.getByText('当前预览不支持运行时属性写入', {exact: true}).waitFor();
  assert.deepEqual(await page.evaluate(() => window.godotPlayground.get_project_context()), beforeWrite);
  await page.evaluate(() => window.debugPanelFixture.enableRuntimeWrite());
  await page.locator('#agent-runtime-write').click();
  await page.getByText('已验证写入、画面变化和重启恢复，并取得两次退出回执', {exact: true}).waitFor();
  const frames = await page.locator('#agent-observations figcaption').allTextContents();
  assert.match(frames[0],/写入前 · Player x=64/);
  assert.match(frames[1],/写入后 · Player x=192/);
  const writeResults = await page.locator('#agent-write-results li').allTextContents();
  assert(writeResults.some(line=>line.includes('fixture-write · applied · x=192')));
  assert.equal(writeResults.filter(line=>line.includes('host-report · clean-exit')).length,2);

  const beforeProperties=await page.evaluate(()=>window.godotPlayground.get_project_context());
  await page.locator('#agent-runtime-properties').click();
  await page.getByText('当前引擎不支持公开脚本属性访问',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.godotPlayground.get_project_context()),beforeProperties);
  await page.evaluate(()=>window.debugPanelFixture.enableRuntimeProperties());
  await page.locator('#agent-runtime-properties').click();
  await page.getByText('已验证公开属性、玩法变化、重启恢复和两次完整退出',{exact:true}).waitFor();
  const propertyEvidence=JSON.parse(await page.locator('#agent-properties-evidence').textContent());
  assert.equal(propertyEvidence.frames.length,4);
  assert(propertyEvidence.checks.some(check=>check.kind==='summer-write'&&check.response.result.data.payload.result.property==='health'));
  assert(propertyEvidence.checks.some(check=>check.kind==='stale-write'&&check.reply.error.code==='run_ended'));
  assert.notEqual(propertyEvidence.first.run.runId,propertyEvidence.second.run.runId);
  assert.equal(propertyEvidence.first.sourceHash,propertyEvidence.second.sourceHash);
  assert.equal(propertyEvidence.first.exit.report.sessionFacts.nativeExit.code,0);
  assert.equal(propertyEvidence.second.exit.report.sessionFacts.hostCleanup,'complete');
  assert.match(await page.locator('#agent-trace').textContent(),/summer_call/);

  await page.evaluate(()=>window.debugPanelFixture.holdPropertyRead());
  await page.locator('#agent-runtime-properties').click();
  await page.waitForFunction(()=>window.debugPanelFixture.propertyReadPending());
  const cancelledRunId=await page.evaluate(()=>window.godotPlayground.get_project_context().result.activeRunId);
  assert(cancelledRunId);
  assert.equal(await page.locator('#agent-replay').isDisabled(),true);
  assert.equal(await page.locator('#agent-playtest').isDisabled(),true);
  assert.equal(await page.locator('#agent-runtime-write').isDisabled(),true);
  await page.locator('#agent-stop').click();
  await page.getByText('已取消属性验证；退出状态见运行记录',{exact:true}).waitFor();
  const cancelledRun=await page.evaluate(runId=>window.godotPlayground.get_run({runId}).result,cancelledRunId);
  assert.equal(cancelledRun.state,'exited');
  assert.equal(cancelledRun.exit.report.reason,'clean-exit');
  assert.equal(cancelledRun.exit.report.sessionFacts.nativeExit.code,0);
  assert.equal(cancelledRun.exit.report.sessionFacts.hostCleanup,'complete');
  assert.equal(await page.locator('#agent-replay').isEnabled(),true);
  assert.equal(await page.locator('#agent-runtime-properties').isEnabled(),true);
  assert.match(await page.locator('#agent-write-results').textContent(),/host-report · clean-exit/);

  await page.evaluate(()=>window.debugPanelFixture.holdPropertyRead());
  await page.locator('#agent-runtime-properties').click();
  await page.waitForFunction(()=>window.debugPanelFixture.propertyReadPending());
  const switchedRunId=await page.evaluate(()=>window.godotPlayground.get_project_context().result.activeRunId);
  await page.evaluate(()=>window.debugPanelFixture.switchPropertyProject());
  await page.getByText('验证期间项目或运行意图已变化',{exact:true}).waitFor();
  const switched=await page.evaluate(runId=>({context:window.godotPlayground.get_project_context().result,run:window.godotPlayground.get_run({runId}).result}),switchedRunId);
  assert.equal(switched.context.projectId,'other-project');
  assert.equal(switched.run.state,'exited');
  assert.equal(switched.run.exit.report.sessionFacts.nativeExit.code,0);
  assert.equal(switched.run.exit.report.sessionFacts.hostCleanup,'complete');
  assert.equal(await page.locator('#agent-runtime-properties').isEnabled(),true);

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
