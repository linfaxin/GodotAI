import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {launchBrowser} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runReportedBrowserTest, listenBrowserTestServer as listen, closeBrowserTestServer as close} from './browser-contract-report.mjs';
import {consoleElement as element, openConsoleOperation, viewConsoleCall, invokeConsole, submitConsole, consoleResult, summerResult, readConsolePng} from './api-console-browser-helpers.mjs';

const app = fileURLToPath(new URL('../', import.meta.url));
const scope = 'controlled-api-console';
await runReportedBrowserTest({scope, reportFile: process.env.PLAYGROUND_API_CONSOLE_REPORT, run: async test => {
  test.checkpoint({engineExecuted: false});
  const harness = await build({stdin: {resolveDir: app, loader: 'ts', contents: `
    import {createConsoleFixture,consoleIdentity,consoleNode,consoleEnvironment} from './scripts/fixtures/api-console-fixture';
    import {createApiConsole} from './src/workbench/api-console';
    import {createWorkbench} from './src/workbench/workbench';
    import {CONSOLE_LESSONS} from './src/workbench/api-console-presets';
    const fixture=createConsoleFixture(),{session,gate}=fixture;
    const createdUrls=[],revokedUrls=[],createUrl=URL.createObjectURL.bind(URL),revokeUrl=URL.revokeObjectURL.bind(URL);
    URL.createObjectURL=blob=>{const url=createUrl(blob);createdUrls.push(url);return url;};
    URL.revokeObjectURL=url=>{revokedUrls.push(url);revokeUrl(url);};
    let compileCount=0,stopCount=0,openCount=0,health=100,moveStep=64,x=64,serial=1,inputSerial=0,frameSerial=0;
    let reportedErrors, debuggerStatus='observed';
    let environment=structuredClone(consoleEnvironment),heldRead,finishRead,replayToken;
    const identity=()=>({...consoleIdentity,runId:environment.anchor.activeRunId,generation:'generation-'+serial,workerId:'worker-'+serial});
    const node=()=>({...consoleNode,instanceId:String(100+serial)});
    const ok=result=>({ok:true,result}),facade=data=>ok({data,godotai:{compatibility:{input:'subset',semantics:'partial',payload:'godotai-typed-v1',summerNativeFixture:false}}});
    const update=()=>fixture.setContext(environment);
    const target=input=>({runId:input.runId,path:input.path,expectedInstanceId:input.expectedInstanceId});
    const receipt=input=>({run:identity(),releaseId:'b'.repeat(64),path:input.path,expectedInstanceId:input.expectedInstanceId});
    fixture.hooks.openExample=async()=>{openCount++;return environment.anchor.editorProjectId;};
    fixture.setReply('summer_call',async input=>{
      switch(input.op){
        case 'engine.get_project_context':return facade({...environment.anchor});
        case 'engine.get_diagnostics':return facade({
          projectId: environment.anchor.editorProjectId, editorRevision: environment.anchor.editorRevision,
          check: {checkId: 'check-1', status: 'completed', diagnostics: {observed: reportedErrors !== undefined,
            counts: reportedErrors === undefined ? undefined : {error: reportedErrors, warning: 0, info: 0}, items: [], omittedCount: 0}},
          build: null, run: null,
        });
        case 'engine.get_debugger_errors':return facade({status:debuggerStatus,entries:debuggerStatus==='observed' ?
          [{source:'runtime-binding',diagnostic:{source:'godotjs',message:'<b>runtime error</b>'}}] : []});
        case 'engine.play':health=100;moveStep=64;x=64;environment.anchor.pendingAttemptId='build-'+serial;update();return facade({accepted:true,state:'pending',attemptId:'build-'+serial,run:null});
        case 'engine.is_running':return facade({playing:environment.activeRunState==='running',capturedRunId:environment.anchor.activeRunId});
        case 'engine.stop':{const runId=environment.anchor.activeRunId;environment.activeRunState='exited';environment.anchor.pendingAttemptId=null;update();return facade({accepted:true,runs:[{runId,receipt:ok({status:'exited',runId})}],no_target:false});}
        case 'engine.get_runtime_tree':return facade({run:identity(),releaseId:'b'.repeat(64),nodes:[node()],truncated:false});
        case 'engine.inspect_runtime_node':return facade({run:identity(),node:node(),sampleSeq:frameSerial+1,properties:[{name:'position',value:{x,y:256}},{name:'rotation',value:0},{name:'visible',value:true}]});
        case 'engine.runtime_set':{const {property,value}=input.input,before=property==='health'?health:property==='move_step'?moveStep:{x,y:256};if(property==='health')health=value;else if(property==='move_step')moveStep=value;else x=Number(/Vector2\\(\\s*([\\d.]+)/.exec(value)?.[1]);return facade({route:'runtime_properties',payload:{...ok({outcome:'applied',writeEntered:true,beforeValue:before,observedValue:value}),receipt:receipt({runId:identity().runId,path:node().path,expectedInstanceId:node().instanceId})}});}
        case 'engine.screenshot':{const canvas=new OffscreenCanvas(960,640),ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,960,640);ctx.fillStyle='white';ctx.fillRect(x-16,240,32,32);ctx.fillStyle='black';ctx.fillRect(24,24,200,16);ctx.fillStyle='lime';ctx.fillRect(24,24,health*2,16);const blob=await canvas.convertToBlob({type:'image/png'});return facade({run:identity(),releaseId:'b'.repeat(64),requestId:'capture-'+(++frameSerial),renderSerial:frameSerial,iteration:frameSerial,width:960,height:640,sourceWidth:960,sourceHeight:640,geometry:{epoch:1,width:960,height:640,devicePixelRatio:1},mimeType:'image/png',bytes:await blob.arrayBuffer()});}
      }
      return {ok:false,error:{code:'unsupported',message:'unsupported fixture operation'}};
    });
    fixture.setReply('wait_for_event',async input=>{environment.anchor.pendingAttemptId=null;if(input.until==='running')environment.activeRunState='running';update();return ok({outcome:'reached',run:{...identity(),projectId:environment.anchor.editorProjectId,attemptId:'build-'+serial,state:input.until==='running'?'running':'exited'}});});
    fixture.setReply('describe_runtime_properties', async input => {
      if (input.limit !== undefined) {
        const properties = Array.from({length:input.limit}, (_, index) => ({name:'stat_'+index,type:'int'}));
        return {...ok({mode:'enumerate',properties}),receipt:receipt(input)};
      }
      const properties = (input.names??['health','move_step']).map(name=>({name,status:'found',descriptor:{name,type:name==='health'?'int':'float',readAccess:{status:'candidate'},writeAccess:{status:'candidate'}}}));
      return {...ok({mode:'names',properties}),receipt:receipt(input)};
    });
    fixture.setReply('read_runtime_properties',async(input,signal)=>{
      if(heldRead){heldRead=false;await new Promise(resolve=>{finishRead=()=>{finishRead=undefined;resolve(undefined);};signal?.addEventListener('abort',()=>{setTimeout(()=>finishRead?.(),25);},{once:true});});if(signal?.aborted)return {ok:false,error:{code:'cancelled',message:'cancelled query; no rollback'}};}
      return {...ok({outcome:'completed',properties:input.properties.map(({name,expectedType})=>({name,status:'value',readEntered:true,value:{type:expectedType,value:name==='health'?health:moveStep}}))}),receipt:receipt(input)};
    });
    fixture.setReply('game_input',input=>{if(input.gesture.code==='ArrowDown')x=64;else if(input.gesture.code==='ArrowRight')x+=moveStep;return ok({operationId:'input-'+(++inputSerial)});});
    fixture.setReply('wait_for_input',async input=>ok({operation:{run:identity(),operationId:input.operationId,status:'dispatched',down:'dispatched',up:'dispatched',nativeConsumption:'unconfirmed'}}));
    fixture.setReply('get_run',input=>ok({...identity(),runId:input.runId,state:'exited',exit:{evidence:'host-report'}}));
    const workbench=createWorkbench({selectFile(){},focusEditor(){},showApi:id=>view.show(id),toast(){}});
    workbench.syncFiles(['/src/Player.ts'],'/src/Player.ts');
    document.querySelector('#source').textContent='source sentinel';
    const view=createApiConsole(document.querySelector('#api-console-pane'),document.querySelector('#api-list'),session,workbench.openApi);
    document.querySelector('#stop').removeAttribute('disabled');
    document.querySelector('#stop').onclick=()=>{stopCount++;if(replayToken){document.body.dataset.replayCancelled='true';return;}environment.activeRunState='exited';update();finishRead?.();};
    window.addEventListener('keydown',event=>{if(event.defaultPrevented||event.isComposing)return;if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();if(workbench.leftMode()==='code')compileCount++;}});
    window.consoleFixture={
      snapshot:()=>session.snapshot(),calls:()=>fixture.calls.map(({name,input})=>({name,input})),
      counts:()=>({compileCount,stopCount,openCount}),lessons:CONSOLE_LESSONS,
      setReportedErrors(value){reportedErrors=value;},
      setDebuggerStatus(value){debuggerStatus=value;},
      setInputExampleAvailable(value){environment.inputExampleAvailable=value;update();},
      resources:()=>({created:createdUrls.length,revoked:revokedUrls.length,attachments:session.snapshot().history.filter(call=>call.attachmentId&&session.getAttachment(call.attachmentId)).length}),
      setContext(anchor,state='running'){environment={anchor:{...environment.anchor,...anchor},activeRunState:state};update();},
      newRun(){serial++;health=100;moveStep=64;x=64;environment.anchor.activeRunId='run-'+serial;environment.activeRunState='running';update();},
      holdRead(){heldRead=true;},finishRead:()=>finishRead?.(),
      beginReplay(){replayToken=gate.acquire('replay');if(!replayToken)throw Error('Replay could not acquire gate');},
      endReplay(){gate.release(replayToken);replayToken=undefined;},
      runStarted:()=>workbench.runStarted(),
      dispose(){view.dispose();session.dispose();}
    };
  `}, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false});
  const server = createStaticServer(new URL('../web/', import.meta.url).pathname);
  await listen(server); test.defer(() => close(server));
  const browser = await launchBrowser({browser: 'chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  test.defer(() => browser.close());
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/main.js', route => route.fulfill({contentType: 'text/javascript', body: harness.outputFiles[0].text}));
  await page.route('**/main.css', route => route.fulfill({contentType: 'text/css', body: ''}));
  await page.route('**/api-console.css', async route => route.fulfill({contentType: 'text/css', body: await readFile(new URL('../web/api-console.css', import.meta.url), 'utf8')}));
  test.stage = 'run';
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await openConsoleOperation(page, 'engine.get_project_context');
  await element(page, 'input').waitFor();
  const cases = [];
  async function step(name, body) { await test.step(name, async () => { await body(); cases.push(name); }); }

  await step('directory-drafts-shortcuts-and-modes', async () => {
    const entries = page.locator('#api-list [data-api-operation]');
    assert.equal(await entries.count(), 26);
    assert.equal(await page.locator('#api-list .api-list-group').count(), 2);
    for (const entry of await entries.all()) {
      assert.equal(await entry.locator('.api-list-name').textContent(), await entry.getAttribute('data-api-operation'));
      const summary = entry.locator('.api-list-summary');
      assert((await summary.textContent()).trim().length > 0);
      assert.equal(await summary.evaluate(node => getComputedStyle(node).whiteSpace), 'nowrap');
    }
    await element(page, 'input').fill('{invalid draft');
    await openConsoleOperation(page, 'engine.is_running');
    await openConsoleOperation(page, 'engine.get_project_context');
    assert.equal(await element(page, 'input').inputValue(), '{invalid draft');
    const before = await page.evaluate(() => window.consoleFixture.calls().length);
    await element(page, 'execute').click();
    assert.equal(await page.evaluate(() => window.consoleFixture.calls().length), before);
    await element(page, 'input').fill('{}');
    await element(page, 'input').dispatchEvent('compositionstart');
    await element(page, 'input').press('Control+Enter');
    assert.equal(await page.evaluate(() => window.consoleFixture.calls().length), before);
    await element(page, 'input').dispatchEvent('compositionend');
    await element(page, 'input').press('Control+Enter');
    await page.waitForFunction(before => window.consoleFixture.calls().length === before + 1, before);
    await openConsoleOperation(page, 'game_input');
    await element(page, 'input').focus();
    await page.keyboard.down('Control');
    await page.keyboard.down('Enter');
    await page.waitForFunction(() => window.consoleFixture.calls().at(-1)?.name === 'game_input' && !window.consoleFixture.snapshot().owner);
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await page.keyboard.up('Control');
    const heldCalls = await page.evaluate(before => window.consoleFixture.calls().slice(before), before + 1);
    assert.deepEqual(heldCalls.map(call => call.name), ['game_input']);
    await openConsoleOperation(page, 'engine.get_project_context');
    assert.equal((await page.evaluate(() => window.consoleFixture.counts())).compileCount, 0);
    await page.locator('#tabs [data-file-tab]').first().click();
    assert.equal(await page.locator('#source').textContent(), 'source sentinel');
    await openConsoleOperation(page, 'engine.get_project_context');
    assert.equal(await element(page, 'input').inputValue(), '{}');
    await page.setViewportSize({width: 390, height: 844});
    await page.evaluate(() => window.consoleFixture.runStarted());
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('preview-focus')), false);
    await page.setViewportSize({width: 1280, height: 900});
  });

  await step('api-tabs-retain-independent-inputs-results-and-errors', async () => {
    const a = 'engine.get_project_context', b = 'engine.is_running';
    const first = await invokeConsole(page, a, {});
    const second = await invokeConsole(page, b, {});
    assert.match(await element(page, 'result-status').textContent(), new RegExp(second.callId));
    const tab = id => page.locator(`[data-api-tab="${id}"]`);
    assert.equal(await tab(a).textContent(), `API: ${a}`);
    assert.equal(await tab(b).textContent(), `API: ${b}`);
    assert.equal(await page.locator('[data-file-tab] .tab-name').first().textContent(), 'Player.ts');
    const card = id => page.locator(`[data-api-card="${id}"]`);
    const [aInput, bInput] = await Promise.all([a, b].map(id => card(id).getByTestId('api-console-input').getAttribute('id')));
    assert.notEqual(aInput, bInput);
    assert.equal(await tab(a).getAttribute('aria-controls'), await card(a).getAttribute('id'));
    assert.equal(await card(a).isHidden(), true);
    assert.equal(await card(b).isVisible(), true);
    await page.locator(`[data-api-operation="${a}"]`).click();
    assert.equal(await tab(a).count(), 1);
    assert.match(await element(page, 'result-status').textContent(), new RegExp(first.callId));
    await element(page, 'input').fill('{bad draft');
    await element(page, 'execute').click();
    assert.match(await element(page, 'client-error').textContent(), /JSON/);
    await tab(a).press('ArrowRight');
    assert.equal(await tab(b).getAttribute('aria-selected'), 'true');
    assert.equal(await element(page, 'client-error').isHidden(), true);
    await element(page, 'input').fill('{"b":true}');
    await tab(b).locator('..').locator('.close-tab').click();
    assert.equal(await tab(b).count(), 0);
    await openConsoleOperation(page, a);
    assert.equal(await element(page, 'input').inputValue(), '{bad draft');
    assert.match(await element(page, 'client-error').textContent(), /JSON/);
    const callsBefore = await page.evaluate(() => window.consoleFixture.calls().length);
    await openConsoleOperation(page, b);
    assert.equal(await element(page, 'input').inputValue(), '{"b":true}');
    assert.match(await element(page, 'result-status').textContent(), new RegExp(second.callId));
    await element(page, 'history').locator(`[data-call-id="${first.callId}"] [data-action="load-history"]`).click();
    assert.equal(await tab(a).getAttribute('aria-selected'), 'true');
    assert.equal(await element(page, 'input').inputValue(), '{}');
    assert.equal(await page.evaluate(() => window.consoleFixture.calls().length), callsBefore);
  });

  const path = '/root/Main/Player';
  await step('editable-summer-position-flow', async () => {
    const played = summerResult((await invokeConsole(page, 'engine.play', {})).reply);
    assert.equal(played.state, 'pending');
    const waited = consoleResult((await invokeConsole(page, 'wait_for_event', {attemptId: played.attemptId, until: 'running'})).reply);
    assert.equal(waited.outcome, 'reached');
    const {callId: treeCall, reply: treeReply} = await invokeConsole(page, 'engine.get_runtime_tree', {depth: 3, limit: 500});
    const tree = summerResult(treeReply);
    assert.equal(tree.nodes[0].path, path);
    const sourceCount = await page.evaluate(() => window.consoleFixture.calls().length);
    await openConsoleOperation(page, 'describe_runtime_properties');
    await viewConsoleCall(page, treeCall);
    await element(page, 'source-node').selectOption(path);
    await element(page, 'use-result').click();
    assert.deepEqual(JSON.parse(await element(page, 'input').inputValue()), {
      runId: 'run-1', path, expectedInstanceId: '101', names: ['health', 'move_step'],
    });
    assert.equal(await page.evaluate(() => window.consoleFixture.calls().length), sourceCount);
    const before = summerResult((await invokeConsole(page, 'engine.inspect_runtime_node', {path})).reply);
    assert.equal(before.properties[0].value.x, 64);
    await invokeConsole(page, 'engine.runtime_set', {path, property: 'position', value: 'Vector2(192, 256)'});
    const after = summerResult((await invokeConsole(page, 'engine.inspect_runtime_node', {path})).reply);
    assert.equal(after.properties[0].value.x, 192);
    await element(page, 'lessons').locator('summary').click();
    const beforeLesson = await page.evaluate(() => window.consoleFixture.calls().length);
    await element(page, 'lessons').locator('[data-testid="api-console-lesson-step"][data-lesson-id="gameplay-properties"][data-step-id="set-health"]').click();
    assert.deepEqual(JSON.parse(await element(page, 'input').inputValue()), {path, property: 'health', value: 40});
    assert.equal(await page.evaluate(() => window.consoleFixture.calls().length), beforeLesson);
    await element(page, 'lessons').locator('summary').click();
    const screenshot = summerResult((await invokeConsole(page, 'engine.screenshot', {target: 'game'})).reply);
    assert.equal(screenshot.bytes.kind, 'ArrayBuffer');
    assert.deepEqual((await readConsolePng(page)).pixels.movedMarker, [255, 255, 255, 255]);
    assert.equal(await page.evaluate(() => window.consoleFixture.snapshot().history.some(call => Object.values(call).some(value => value instanceof ArrayBuffer))), false);
  });

  await step('local-properties-input-and-restart-flow', async () => {
    await invokeConsole(page, 'check', {projectId: 'project-1', expectedEditorRevision: 7});
    const target = {runId: 'run-1', path, expectedInstanceId: '101'};
    const described = consoleResult((await invokeConsole(page, 'describe_runtime_properties', {...target, names: ['health', 'move_step']})).reply);
    assert.equal(described.properties[0].descriptor.type, 'int');
    const readInput = {...target, properties: [{name: 'health', expectedType: 'int'}, {name: 'move_step', expectedType: 'float'}]};
    assert.equal(consoleResult((await invokeConsole(page, 'read_runtime_properties', readInput)).reply).properties[0].value.value, 100);
    await invokeConsole(page, 'engine.runtime_set', {path, property: 'health', value: 40});
    await invokeConsole(page, 'engine.runtime_set', {path, property: 'move_step', value: 128});
    const values = consoleResult((await invokeConsole(page, 'read_runtime_properties', readInput)).reply).properties.map(item => item.value.value);
    assert.deepEqual(values, [40, 128]);
    for (const code of ['ArrowDown', 'ArrowRight']) {
      const input = consoleResult((await invokeConsole(page, 'game_input', {runId: 'run-1', gesture: {kind: 'key_tap', code}})).reply);
      const receipt = consoleResult((await invokeConsole(page, 'wait_for_input', {runId: 'run-1', operationId: input.operationId})).reply);
      assert.equal(receipt.operation.status, 'dispatched');
    }
    await invokeConsole(page, 'engine.screenshot', {target: 'game'});
    const image = await readConsolePng(page);
    assert.deepEqual(image.pixels.movedMarker, [255, 255, 255, 255]);
    assert.deepEqual(image.pixels.health100, [0, 0, 0, 255]);
    await invokeConsole(page, 'engine.stop', {});
    await invokeConsole(page, 'wait_for_event', {runId: 'run-1', until: 'exited'});
    await page.evaluate(() => window.consoleFixture.newRun());
    const next = {...readInput, runId: 'run-2', expectedInstanceId: '102'};
    assert.deepEqual(consoleResult((await invokeConsole(page, 'read_runtime_properties', next)).reply).properties.map(item => item.value.value), [100, 64]);
  });

  await step('stale-target-history-cancel-stop-and-replay-gate', async () => {
    await openConsoleOperation(page, 'engine.runtime_set');
    await element(page, 'input').fill(JSON.stringify({path, property: 'health', value: 40}));
    const count = await page.evaluate(() => window.consoleFixture.calls().length);
    await element(page, 'execute').click();
    assert.equal(await page.evaluate(() => window.consoleFixture.calls().length), count);
    assert.match(await element(page, 'client-error').textContent(), /变化|目标|更新/);
    if (!await element(page, 'lessons').evaluate(node => node.open)) await element(page, 'lessons').locator('summary').click();
    await element(page, 'lessons').locator('[data-lesson-id="gameplay-properties"][data-step-id="set-health"]').click();
    await element(page, 'lessons').locator('summary').click();
    await element(page, 'execute').click();
    assert.equal(await page.evaluate(() => window.consoleFixture.calls().length), count);
    assert.match(await element(page, 'client-error').textContent(), /目标已变化/);
    await element(page, 'update-target').click();
    assert.equal(JSON.parse(await element(page, 'input').inputValue()).value, 40);
    await page.evaluate(() => window.consoleFixture.beginReplay());
    assert.equal(await element(page, 'execute').isDisabled(), true);
    await page.locator('#stop').click();
    assert.equal(await page.locator('body').getAttribute('data-replay-cancelled'), 'true');
    assert.equal((await page.evaluate(() => window.consoleFixture.snapshot())).owner, 'replay');
    await page.evaluate(() => window.consoleFixture.endReplay());
    await page.evaluate(() => window.consoleFixture.holdRead());
    await openConsoleOperation(page, 'read_runtime_properties');
    await element(page, 'input').fill(JSON.stringify({runId: 'run-2', path, expectedInstanceId: '102', properties: [{name: 'health', expectedType: 'int'}]}));
    await element(page, 'execute').click();
    await page.waitForFunction(() => window.consoleFixture.snapshot().owner === 'manual');
    assert.equal(await page.locator('#stop').isDisabled(), false);
    await openConsoleOperation(page, 'engine.get_project_context');
    assert.equal(await element(page, 'execute').isDisabled(), true);
    assert.equal(await element(page, 'cancel').isHidden(), true);
    assert.match(await element(page, 'status').textContent(), /另一个 API/);
    await element(page, 'clear-history').click();
    assert.equal(await element(page, 'history').locator('[data-call-id]').count(), 1);
    assert.equal(await element(page, 'history').locator('[data-phase="pending"]').count(), 1);
    await openConsoleOperation(page, 'read_runtime_properties');
    await element(page, 'cancel').click();
    await page.waitForFunction(() => window.consoleFixture.snapshot().owner === null);
    assert.match(await element(page, 'result').textContent(), /cancelled/);
    const beforeLoad = await page.evaluate(() => window.consoleFixture.calls().length);
    await element(page, 'history').locator('[data-action="load-history"]').first().click();
    assert.equal(await page.evaluate(() => window.consoleFixture.calls().length), beforeLoad);
    assert((await element(page, 'history').locator('[data-call-id]').count()) <= 20);
    assert.deepEqual(await page.evaluate(() => window.consoleFixture.lessons.map(lesson => lesson.id)),
      ['runtime-recovery', 'diagnostic-repair', 'lifecycle-events', 'input-script', 'game-probe', 'runtime-method', 'summer-position', 'gameplay-properties']);
  });

  await step('diagnostics-reads-the-current-revision-and-shows-observed-counts', async () => {
    const operation = 'engine.get_diagnostics';
    await openConsoleOperation(page, operation);
    const original = await page.evaluate(() => window.consoleFixture.snapshot().environment.anchor);
    assert.deepEqual(JSON.parse(await element(page, 'input').inputValue()), {});
    await page.evaluate(revision => window.consoleFixture.setContext({editorRevision: revision + 1}), original.editorRevision);
    const result = element(page, 'result-status');
    const {reply} = await submitConsole(page, operation);
    assert.equal(summerResult(reply).editorRevision, original.editorRevision + 1);
    assert.match(await result.textContent(), /错误数未观测/);
    assert.match(await result.textContent(), /构建：无记录/);
    await page.evaluate(() => window.consoleFixture.setReportedErrors(0));
    await submitConsole(page, operation);
    assert.match(await result.textContent(), /0 个错误/);
    await page.evaluate(() => window.consoleFixture.setReportedErrors(2));
    await submitConsole(page, operation);
    assert.match(await result.textContent(), /2 个错误/);
    await page.evaluate(anchor => window.consoleFixture.setContext(anchor), original);
  });

  await step('runtime-recovery-example-and-historical-run', async () => {
    const operation = 'engine.get_debugger_errors';
    await openConsoleOperation(page, operation);
    assert.equal(await element(page, 'open-example').isDisabled(), true);
    await page.evaluate(() => window.consoleFixture.setInputExampleAvailable(true));
    const before = await page.evaluate(() => ({calls: window.consoleFixture.calls().length, ...window.consoleFixture.counts()}));
    await element(page, 'open-example').click();
    assert.deepEqual(await page.evaluate(() => ({calls: window.consoleFixture.calls().length, ...window.consoleFixture.counts()})),
      {...before, openCount: before.openCount + 1});
    const lessons = element(page, 'lessons');
    if (!await lessons.evaluate(node => node.open)) await lessons.locator('summary').click();
    await lessons.locator('[data-lesson-id="runtime-recovery"][data-step-id="read-error"]').click();
    assert.deepEqual(JSON.parse(await element(page, 'input').inputValue()), {include_stack: true});
    assert.equal(await page.evaluate(() => window.consoleFixture.calls().length), before.calls);
    await submitConsole(page, operation);
    assert.match(await element(page, 'result-status').textContent(), /已取得运行时错误/);
    assert.match(await element(page, 'result').textContent(), /<b>runtime error<\/b>/);
    assert.equal(await element(page, 'result').locator('b').count(), 0);
    await page.evaluate(() => window.consoleFixture.setDebuggerStatus('no_reported_error'));
    await submitConsole(page, operation);
    assert.match(await element(page, 'result-status').textContent(), /干净退出/);
    const {reply} = await invokeConsole(page, 'get_run', {runId: 'original-failed-run'}, {refreshTarget: false});
    assert.equal(await element(page, 'open-example').isVisible(), false);
    assert.equal(consoleResult(reply).runId, 'original-failed-run');
    assert.match(await element(page, 'result-status').textContent(), /指定运行的退出回执/);
    await page.evaluate(() => window.consoleFixture.setInputExampleAvailable(false));
  });

  await step('bounded-png-lifecycle-and-explicit-stop', async () => {
    for (let index = 0; index < 6; index++) await invokeConsole(page, 'engine.screenshot', {target: 'game'});
    const resources = await page.evaluate(() => window.consoleFixture.resources());
    assert.equal(resources.attachments, 4);
    assert(resources.revoked > 0, 'Evicted attachments must release their object URLs');
    assert((await element(page, 'history').locator('[data-call-id]').count()) <= 20);
    await openConsoleOperation(page, 'engine.get_project_context');
    await element(page, 'clear-history').click();
    assert.equal((await page.evaluate(() => window.consoleFixture.resources())).attachments, 0);
    const hiddenCards = page.locator('[data-api-card][hidden]');
    assert.equal(await hiddenCards.locator('[data-call-id], [data-source-id], img').count(), 0);
    assert(await hiddenCards.getByTestId('api-console-result').evaluateAll(nodes => nodes.every(node => node.dataset.phase === 'empty')));
    assert(await hiddenCards.getByTestId('api-console-call-request').evaluateAll(nodes => nodes.every(node => node.textContent === '')));
    await openConsoleOperation(page, 'engine.screenshot');
    assert.equal(await element(page, 'result').getAttribute('data-phase'), 'empty');
    assert.equal(await element(page, 'history').locator('[data-call-id]').count(), 0);
    await page.evaluate(() => window.consoleFixture.holdRead());
    await openConsoleOperation(page, 'read_runtime_properties');
    await element(page, 'input').fill(JSON.stringify({runId: 'run-2', path, expectedInstanceId: '102', properties: [{name: 'health', expectedType: 'int'}]}));
    await element(page, 'execute').click();
    await page.waitForFunction(() => window.consoleFixture.snapshot().owner === 'manual');
    const stopBefore = (await page.evaluate(() => window.consoleFixture.counts())).stopCount;
    await page.locator('#stop').click();
    await page.waitForFunction(() => window.consoleFixture.snapshot().owner === null);
    assert.equal((await page.evaluate(() => window.consoleFixture.counts())).stopCount, stopBefore + 1);
    await openConsoleOperation(page, 'engine.get_project_context');
    await element(page, 'input').fill('{}');
  });

  await step('result-fill-keeps-selection-across-tabs-for-retained-sources', async () => {
    assert.match(await element(page, 'context').innerText(), /截图与输入\s+待确认/);
    const {callId: playCall, reply} = await invokeConsole(page, 'engine.play', {});
    const {attemptId} = summerResult(reply);
    await page.evaluate(() => {window.consoleFixture.newRun();window.consoleFixture.setContext({pendingAttemptId:null});});
    await openConsoleOperation(page, 'engine.stop');
    assert.equal(await element(page, 'sources').isHidden(), true);
    await openConsoleOperation(page, 'wait_for_event');
    await viewConsoleCall(page, playCall);
    await element(page, 'use-result').click();
    assert.equal(JSON.parse(await element(page, 'input').inputValue()).attemptId, attemptId);

    const {callId: treeCall, reply: treeReply} = await invokeConsole(page, 'engine.get_runtime_tree', {});
    const tree = summerResult(treeReply);
    const node = tree.nodes[0];
    await invokeConsole(page, 'engine.get_project_context', {});
    await openConsoleOperation(page, 'engine.get_runtime_tree');
    assert.match(await element(page, 'result-status').textContent(), new RegExp(treeCall));
    assert.equal(await element(page, 'use-result').getAttribute('data-source-id'), treeCall);
    const treeDraft = await element(page, 'input').inputValue();
    await element(page, 'source-node').selectOption(node.path);
    await openConsoleOperation(page, 'engine.get_project_context');
    await openConsoleOperation(page, 'engine.get_runtime_tree');
    assert.equal(await element(page, 'source-node').inputValue(), node.path);
    assert.equal(await element(page, 'use-result').isEnabled(), true);
    assert.equal(await element(page, 'input').inputValue(), treeDraft);

    const inspection = await invokeConsole(page, 'engine.inspect_runtime_node', {path: node.path});
    const latestTree = await invokeConsole(page, 'engine.get_runtime_tree', {});
    await openConsoleOperation(page, 'engine.inspect_runtime_node');
    assert.match(await element(page, 'result-status').textContent(), new RegExp(inspection.callId));
    assert.equal(await element(page, 'sources').isHidden(), true);
    await viewConsoleCall(page, latestTree.callId);
    assert.match(await element(page, 'result-status').textContent(), new RegExp(latestTree.callId));
    assert.equal(await element(page, 'use-result').getAttribute('data-source-id'), latestTree.callId);

    const description = await invokeConsole(page, 'describe_runtime_properties', {runId:tree.run.runId,path:node.path,expectedInstanceId:node.instanceId,limit:17});
    await openConsoleOperation(page, 'read_runtime_properties');
    await viewConsoleCall(page, description.callId);
    const beforeFill = await element(page, 'input').inputValue();
    const choices = await element(page, 'source-properties').locator('option').evaluateAll(nodes => nodes.map(node => node.value));
    assert.equal(choices.length, 17);
    await element(page, 'source-properties').selectOption(choices);
    await openConsoleOperation(page, 'engine.get_project_context');
    await openConsoleOperation(page, 'read_runtime_properties');
    const selectedProperties = () => element(page, 'source-properties').locator('option:checked').evaluateAll(nodes => nodes.map(node => node.value));
    assert.deepEqual(await selectedProperties(), choices);
    assert.equal(await element(page, 'use-result').isDisabled(), true);
    assert.match(await element(page, 'source-property-limit').innerText(), /最多 16 项/);
    assert.equal(await element(page, 'input').inputValue(), beforeFill);
    await element(page, 'source-properties').selectOption(choices.slice(0,16));
    const readTab = page.locator('[data-api-tab="read_runtime_properties"]');
    await readTab.locator('..').locator('.close-tab').click();
    assert.equal(await readTab.count(), 0);
    await openConsoleOperation(page, 'read_runtime_properties');
    assert.deepEqual(await selectedProperties(), choices.slice(0,16));
    assert.equal(await element(page, 'source-property-limit').isHidden(), true);
    await element(page, 'use-result').click();
    assert.equal(JSON.parse(await element(page, 'input').inputValue()).properties.length, 16);

    await invokeConsole(page, 'engine.get_project_context', {});
    const selection = await element(page, 'result').evaluate(result => {
      const selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(result);selection.removeAllRanges();selection.addRange(range);
      const before = selection.toString();
      window.consoleFixture.setContext({});
      return {before, after:selection.toString()};
    });
    assert(selection.before.length > 0);
    assert.equal(selection.after, selection.before);

    const stop = await invokeConsole(page, 'engine.stop', {});
    const runId = summerResult(stop.reply).runs[0].runId;
    await openConsoleOperation(page, 'wait_for_event');
    await viewConsoleCall(page, stop.callId);
    await element(page, 'source-run').selectOption(runId);
    await openConsoleOperation(page, 'engine.get_project_context');
    await openConsoleOperation(page, 'wait_for_event');
    assert.equal(await element(page, 'source-run').inputValue(), runId);
    assert.equal(await element(page, 'use-result').isEnabled(), true);

    await openConsoleOperation(page, 'engine.get_project_context');
    await element(page, 'clear-history').click();
    const nextStop = await invokeConsole(page, 'engine.stop', {});
    assert.equal(summerResult(nextStop.reply).runs[0].runId, runId);
    await openConsoleOperation(page, 'wait_for_event');
    await viewConsoleCall(page, nextStop.callId);
    assert.equal(await element(page, 'source-run').inputValue(), '');
    assert.equal(await element(page, 'use-result').isDisabled(), true);
  });

  assert.deepEqual(errors, []);
  const screenshot = process.env.PLAYGROUND_API_CONSOLE_REPORT ? process.env.PLAYGROUND_API_CONSOLE_REPORT + '.png' : undefined;
  if (screenshot) await page.screenshot({path: screenshot, fullPage: true});
  await page.evaluate(() => window.consoleFixture.dispose());
  return {status: 'passed', scope, engineExecuted: false, cases, ...(screenshot ? {screenshot} : {}), browser: {name: browser.browserType().name(), version: browser.version()}};
}});
