import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {launchBrowser} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runReportedBrowserTest, listenBrowserTestServer as listen, closeBrowserTestServer as close} from './browser-contract-report.mjs';
import {consoleElement as element, invokeConsole, consoleResult, summerResult, readConsolePng} from './api-console-browser-helpers.mjs';

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
    const workbench=createWorkbench({selectFile(){workbench.filePicked();},focusEditor(){},toast(){}});
    workbench.syncFiles(['/src/Player.ts'],'/src/Player.ts');
    document.querySelector('#source').textContent='source sentinel';
    const view=createApiConsole(document.querySelector('#api-console-pane'),session);
    document.querySelector('#stop').removeAttribute('disabled');
    document.querySelector('#stop').onclick=()=>{stopCount++;if(replayToken){document.body.dataset.replayCancelled='true';return;}environment.activeRunState='exited';update();finishRead?.();};
    window.addEventListener('keydown',event=>{if(event.defaultPrevented||event.isComposing)return;if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();if(workbench.leftMode()==='code')compileCount++;}});
    window.consoleFixture={
      snapshot:()=>session.snapshot(),calls:()=>fixture.calls.map(({name,input})=>({name,input})),
      counts:()=>({compileCount,stopCount,openCount}),lessons:CONSOLE_LESSONS,
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
  await page.locator('#left-mode-api').click();
  await element(page, 'operation').waitFor();
  const cases = [];
  async function step(name, body) { await test.step(name, async () => { await body(); cases.push(name); }); }

  await step('directory-drafts-shortcuts-and-modes', async () => {
    assert.equal(await element(page, 'operation').locator('option').count(), 14);
    assert.equal(await element(page, 'operation').locator('optgroup').count(), 2);
    await element(page, 'input').fill('{invalid draft');
    await element(page, 'operation').selectOption('engine.is_running');
    await element(page, 'operation').selectOption('engine.get_project_context');
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
    await element(page, 'operation').selectOption('game_input');
    await element(page, 'input').focus();
    await page.keyboard.down('Control');
    await page.keyboard.down('Enter');
    await page.waitForFunction(() => window.consoleFixture.calls().at(-1)?.name === 'game_input' && !window.consoleFixture.snapshot().owner);
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await page.keyboard.up('Control');
    const heldCalls = await page.evaluate(before => window.consoleFixture.calls().slice(before), before + 1);
    assert.deepEqual(heldCalls.map(call => call.name), ['game_input']);
    await element(page, 'operation').selectOption('engine.get_project_context');
    assert.equal((await page.evaluate(() => window.consoleFixture.counts())).compileCount, 0);
    await page.locator('#left-mode-code').click();
    assert.equal(await page.locator('#source').textContent(), 'source sentinel');
    await page.locator('#left-mode-api').click();
    assert.equal(await element(page, 'input').inputValue(), '{}');
    await page.setViewportSize({width: 390, height: 844});
    await page.evaluate(() => window.consoleFixture.runStarted());
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('preview-focus')), false);
    await page.setViewportSize({width: 1280, height: 900});
  });

  const path = '/root/Main/Player';
  await step('editable-summer-position-flow', async () => {
    const played = summerResult((await invokeConsole(page, 'engine.play', {})).reply);
    assert.equal(played.state, 'pending');
    const waited = consoleResult((await invokeConsole(page, 'wait_for_event', {attemptId: played.attemptId, until: 'running'})).reply);
    assert.equal(waited.outcome, 'reached');
    const tree = summerResult((await invokeConsole(page, 'engine.get_runtime_tree', {depth: 3, limit: 500})).reply);
    assert.equal(tree.nodes[0].path, path);
    const sourceCount = await page.evaluate(() => window.consoleFixture.calls().length);
    await element(page, 'operation').selectOption('describe_runtime_properties');
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
    await page.locator('.api-console-lessons summary').click();
    const beforeLesson = await page.evaluate(() => window.consoleFixture.calls().length);
    await page.locator('[data-testid="api-console-lesson-step"][data-lesson-id="gameplay-properties"][data-step-id="set-health"]').click();
    assert.deepEqual(JSON.parse(await element(page, 'input').inputValue()), {path, property: 'health', value: 40});
    assert.equal(await page.evaluate(() => window.consoleFixture.calls().length), beforeLesson);
    await page.locator('.api-console-lessons summary').click();
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
    await element(page, 'operation').selectOption('engine.runtime_set');
    await element(page, 'input').fill(JSON.stringify({path, property: 'health', value: 40}));
    const count = await page.evaluate(() => window.consoleFixture.calls().length);
    await element(page, 'execute').click();
    assert.equal(await page.evaluate(() => window.consoleFixture.calls().length), count);
    assert.match(await element(page, 'client-error').textContent(), /变化|目标|更新/);
    await page.locator('.api-console-lessons summary').click();
    await page.locator('[data-lesson-id="gameplay-properties"][data-step-id="set-health"]').click();
    await page.locator('.api-console-lessons summary').click();
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
    await element(page, 'operation').selectOption('read_runtime_properties');
    await element(page, 'input').fill(JSON.stringify({runId: 'run-2', path, expectedInstanceId: '102', properties: [{name: 'health', expectedType: 'int'}]}));
    await element(page, 'execute').click();
    await page.waitForFunction(() => window.consoleFixture.snapshot().owner === 'manual');
    assert.equal(await page.locator('#stop').isDisabled(), false);
    await element(page, 'cancel').click();
    await page.waitForFunction(() => window.consoleFixture.snapshot().owner === null);
    assert.match(await element(page, 'result').textContent(), /cancelled/);
    const beforeLoad = await page.evaluate(() => window.consoleFixture.calls().length);
    await element(page, 'history').locator('[data-action="load-history"]').first().click();
    assert.equal(await page.evaluate(() => window.consoleFixture.calls().length), beforeLoad);
    assert((await element(page, 'history').locator('[data-call-id]').count()) <= 20);
    assert.equal(await page.evaluate(() => window.consoleFixture.lessons.length), 2);
  });

  await step('bounded-png-lifecycle-and-explicit-stop', async () => {
    for (let index = 0; index < 6; index++) await invokeConsole(page, 'engine.screenshot', {target: 'game'});
    const resources = await page.evaluate(() => window.consoleFixture.resources());
    assert.equal(resources.attachments, 4);
    assert(resources.revoked > 0, 'Evicted attachments must release their object URLs');
    assert((await element(page, 'history').locator('[data-call-id]').count()) <= 20);
    await element(page, 'clear-history').click();
    assert.equal((await page.evaluate(() => window.consoleFixture.resources())).attachments, 0);
    await page.evaluate(() => window.consoleFixture.holdRead());
    await element(page, 'operation').selectOption('read_runtime_properties');
    await element(page, 'input').fill(JSON.stringify({runId: 'run-2', path, expectedInstanceId: '102', properties: [{name: 'health', expectedType: 'int'}]}));
    await element(page, 'execute').click();
    await page.waitForFunction(() => window.consoleFixture.snapshot().owner === 'manual');
    const stopBefore = (await page.evaluate(() => window.consoleFixture.counts())).stopCount;
    await page.locator('#stop').click();
    await page.waitForFunction(() => window.consoleFixture.snapshot().owner === null);
    assert.equal((await page.evaluate(() => window.consoleFixture.counts())).stopCount, stopBefore + 1);
    await element(page, 'operation').selectOption('engine.get_project_context');
    await element(page, 'input').fill('{}');
  });

  await step('result-fill-matches-selected-operation-and-selection-survives-context-updates', async () => {
    assert.match(await element(page, 'context').innerText(), /截图与输入\s+待确认/);
    const {reply} = await invokeConsole(page, 'engine.play', {});
    const {attemptId} = summerResult(reply);
    await page.evaluate(() => {window.consoleFixture.newRun();window.consoleFixture.setContext({pendingAttemptId:null});});
    await element(page, 'operation').selectOption('engine.stop');
    assert.equal(await element(page, 'sources').isHidden(), true);
    await element(page, 'operation').selectOption('wait_for_event');
    await element(page, 'use-result').click();
    assert.equal(JSON.parse(await element(page, 'input').inputValue()).attemptId, attemptId);

    const tree = summerResult((await invokeConsole(page, 'engine.get_runtime_tree', {})).reply);
    const node = tree.nodes[0];
    await invokeConsole(page, 'describe_runtime_properties', {runId:tree.run.runId,path:node.path,expectedInstanceId:node.instanceId,limit:17});
    await element(page, 'operation').selectOption('read_runtime_properties');
    const beforeFill = await element(page, 'input').inputValue();
    const choices = await element(page, 'source-properties').locator('option').evaluateAll(nodes => nodes.map(node => node.value));
    assert.equal(choices.length, 17);
    await element(page, 'source-properties').selectOption(choices);
    assert.equal(await element(page, 'use-result').isDisabled(), true);
    assert.match(await element(page, 'source-property-limit').innerText(), /最多 16 项/);
    assert.equal(await element(page, 'input').inputValue(), beforeFill);
    await element(page, 'source-properties').selectOption(choices.slice(0,16));
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
  });

  assert.deepEqual(errors, []);
  const screenshot = process.env.PLAYGROUND_API_CONSOLE_REPORT ? process.env.PLAYGROUND_API_CONSOLE_REPORT + '.png' : undefined;
  if (screenshot) await page.screenshot({path: screenshot, fullPage: true});
  await page.evaluate(() => window.consoleFixture.dispose());
  return {status: 'passed', scope, engineExecuted: false, cases, ...(screenshot ? {screenshot} : {}), browser: {name: browser.browserType().name(), version: browser.version()}};
}});
