import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createRuntimeMethodDemo} from '../src/runtime-properties-demo.ts';
import {exportProject} from '../src/project-model.ts';
import {defaultTestDirectory, launchBrowser, withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runReportedBrowserTest, listenBrowserTestServer as listen, closeBrowserTestServer as close} from './browser-contract-report.mjs';
import {consoleElement as element, openConsoleOperation, viewConsoleCall, invokeConsole, submitConsole, consoleResult, summerResult, readConsolePng} from './api-console-browser-helpers.mjs';

const reportFile = path.resolve(process.env.PLAYGROUND_RUNTIME_CALL_REPORT ?? 'work/runtime-call/report.json');
const timeout = 120_000;
const title = 'playground-runtime-call';
await runReportedBrowserTest({scope: title, reportFile, run: async test => {
  const directory = path.resolve(defaultTestDirectory());
  const {site, release, candidateId, descriptorHash} = await test.preflight(directory, {worker: true});
  assert.equal(site.engineTarget, 'template_debug');
  assert.equal(release.runtimeAbi?.runtimeProperties, 1);
  const available = release.runtimeAbi?.runtimeCall === 1;
  const expected = process.env.PLAYGROUND_RUNTIME_CALL_CASE;
  if (expected) assert.equal(available, expected === 'supported');
  const prefix = site.publicAssets ? '/releases/' + candidateId + '/' : '/';
  const serverOptions = {urlPrefix: prefix, publicImmutable: site.publicAssets === true};
  const editor = createStaticServer(directory, serverOptions), preview = createStaticServer(directory, serverOptions);
  test.defer(() => close(editor)); test.defer(() => close(preview));
  await Promise.all([listen(editor), listen(preview)]);
  const browser = await launchBrowser({browser:'chromium', headless:true,
    args:['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage']});
  test.defer(() => browser.close());
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    const send = MessagePort.prototype.postMessage;
    window.runtimeMethodDispatches = [];
    MessagePort.prototype.postMessage = function(value, ...args) {
      if (value?.type === 'runtime-method-request') window.runtimeMethodDispatches.push({runId:value.runId, requestId:value.requestId, command:value.command});
      return send.call(this, value, ...args);
    };
  });
  const runs = [], images = [], calls = [];
  test.checkpoint({engineExecuted:false, available, candidateId, descriptorHash, releaseId:release.id, runs, images, calls});
  const call = async (op, input) => {
    const {reply, callId} = await invokeConsole(page, op, input, {timeout});
    calls.push({op, input, reply, callId});
    return reply;
  };
  const api = (method, input) => page.evaluate(({method,input}) => window.godotPlayground[method](input), {method,input});
  const projectContext = () => page.evaluate(() => window.godotPlayground.get_project_context().result);
  const ready = () => page.waitForFunction(() => window.godotPlayground?.get_project_context().result.capabilities.play === 'available', undefined, {timeout});
  const invokeRaw = (path, method, args) => api('summer_call', {op:'engine.runtime_call', input:{path,method,args}});
  const damage = (path, amount=25) => invokeRaw(path, 'take_damage', [amount]);
  async function openExample(op) {
    await openConsoleOperation(page, op);
    const oldProject = (await projectContext()).projectId;
    await element(page,'open-example').click();
    await page.waitForFunction(id => window.godotPlayground.get_project_context().result.projectId !== id, oldProject);
    await ready();
  }
  async function importProject(name, document) {
    const previous = (await projectContext()).projectId;
    await page.locator('#import').setInputFiles({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(document))});
    await page.waitForFunction(id=>window.godotPlayground.get_project_context().result.projectId!==id, previous);
    await ready();
  }
  async function play() {
    const {attemptId} = summerResult(await call('engine.play', {}));
    const observation = consoleResult(await call('wait_for_event', {attemptId,until:'running',timeoutMs:60000}));
    assert.equal(observation.outcome,'reached');
    const run = observation.run;
    assert.equal(run.release.releaseId,release.id);
    const build = consoleResult(await api('get_build',{attemptId}));
    assert.match(build.sourceHash,/^[a-f0-9]{64}$/);
    runs.push({run, sourceHash:build.sourceHash});
    test.checkpoint({engineExecuted:true,runs,images,calls});
    return run;
  }
  async function findPlayer(run) {
    const tree = summerResult(await call('engine.get_runtime_tree',{depth:3,limit:50}));
    assert.equal(tree.run.runId,run.runId);
    const [node] = tree.nodes.filter(item => item.path === '/root/Main/Player');
    assert(node);
    return {target:{runId:run.runId,path:node.path,expectedInstanceId:node.instanceId}, treeCallId:calls.at(-1).callId};
  }
  async function health(target) {
    const reply = await api('read_runtime_properties',{...target,properties:[{name:'health',expectedType:'int'}]});
    assert.equal(reply.receipt.run.runId,target.runId);
    const value = consoleResult(reply).properties[0];
    assert.equal(value.status,'value');
    return value.value.value;
  }
  async function screenshot(target, name, shortened) {
    const frame = summerResult(await call('engine.screenshot',{target:'game'}));
    assert.equal(frame.run.runId, target.runId);
    assert.equal(frame.releaseId, release.id);
    const png = await readConsolePng(page);
    assert.deepEqual(png.pixels.damageInner,[0,255,0,255]);
    assert.deepEqual(png.pixels.damageOuter,shortened ? [0,0,0,255] : [0,255,0,255]);
    const bytes = Buffer.from(png.bytes), filename = path.join(path.dirname(reportFile), name + '.png');
    await mkdir(path.dirname(filename),{recursive:true});
    await writeFile(filename,bytes);
    images.push({name,filename,sha256:createHash('sha256').update(bytes).digest('hex'),frame,pixels:png.pixels});
    return frame;
  }
  async function stop(run) {
    const reply = summerResult(await call('engine.stop',{}));
    assert(reply.runs.some(item=>item.runId===run.runId));
    const observed = consoleResult(await call('wait_for_event',{runId:run.runId,until:'exited', timeoutMs:10000}));
    assert.equal(observed.outcome,'reached');
    const exit = observed.run.exit;
    assert.equal(exit.evidence,'host-report');
    assert.equal(exit.report.sessionFacts.nativeExit.code,0);
    assert.equal(exit.report.sessionFacts.hostCleanup,'complete');
    runs.find(item=>item.run.runId===run.runId).exit=exit;
  }
  async function fill(callId, op, picker, selection) {
    await openConsoleOperation(page,op);
    await viewConsoleCall(page,callId);
    assert(await element(page,'use-result').isDisabled());
    await element(page,picker).selectOption(selection);
    await element(page,'use-result').click();
    assert.equal(await element(page,'client-error').textContent(),'');
  }

  await page.goto(`http://127.0.0.1:${editor.address().port}${prefix}?project=native&presentationBackend=direct&previewOrigin=${encodeURIComponent(`http://127.0.0.1:${preview.address().port}${prefix}`)}`);
  await ready();
  test.stage = 'run';
  await test.step('actual-template-declarations', async () => {
    for (const name of ['types.json','types.camel.json']) {
      const types = JSON.parse(await readFile(path.join(directory,name),'utf8'));
      assert.equal(/\bruntimeMethod\(signature:/.test(types['/godot.annotations/index.d.ts']),available,name);
    }
    assert.equal(release.api.authoring.runtimeMethod,available);
  });
  if (!available) {
    await test.step('old-template-method-unavailable-and-zero-dispatch', async () => {
      await openConsoleOperation(page,'engine.runtime_call');
      assert(await element(page,'open-example').isDisabled());
      await openExample('engine.runtime_set');
      const run = await play(), {target} = await findPlayer(run);
      assert.equal(await health(target),100);
      const cap = consoleResult(await api('get_run',{runId:run.runId})).runtimeCall;
      assert.deepEqual(cap,{supported:false,ready:false});
      assert.equal((await call('describe_runtime_methods',target)).error.code,'unsupported');
      assert.equal((await call('engine.runtime_call',{path:target.path,method:'take_damage',args:[25]})).error.code,'unsupported');
      const token = {version:1,runId:target.runId,releaseId:release.id,returnType:'int',stamp:'1'.repeat(64)};
      assert.equal((await api('call_runtime_method',{...target,method:'take_damage',args:[{type:'int',value:25}],methodToken:token})).error.code,'unsupported');
      assert.deepEqual(await page.evaluate(()=>window.runtimeMethodDispatches),[]);
      await stop(run);
    });
  } else {
    await test.step('method-demo-fill-return-read-png-restart', async () => {
      await openExample('engine.runtime_call');
      const run = await play(), {target,treeCallId} = await findPlayer(run);
      assert.equal(consoleResult(await api('get_run',{runId:run.runId})).runtimeCall.ready,true);
      assert.equal(await health(target),100);
      const before = await screenshot(target,'method-before',false);
      await fill(treeCallId,'describe_runtime_methods','source-node',target.path);
      const describeDraft = JSON.parse(await element(page,'input').inputValue());
      assert.deepEqual(describeDraft,target);
      const description = await submitConsole(page,'describe_runtime_methods',{timeout});
      const method = consoleResult(description.reply).methods.find(item=>item.method==='take_damage');
      assert.deepEqual(method.parameterTypes,['int']);
      await openConsoleOperation(page,'engine.runtime_call');
      await element(page,'input').fill(JSON.stringify({args:[25]}));
      await fill(description.callId,'engine.runtime_call','source-method','take_damage');
      assert.deepEqual(JSON.parse(await element(page,'input').inputValue()),{path:target.path,method:'take_damage',args:[25]});
      assert.equal(await health(target),100,'Filling the draft must not execute');
      const receipt = summerResult((await submitConsole(page,'engine.runtime_call',{timeout})).reply).payload;
      assert.equal(receipt.receipt.run.runId,run.runId);
      assert.equal(receipt.receipt.expectedInstanceId,target.expectedInstanceId);
      assert.equal(receipt.result.outcome,'returned');
      assert.deepEqual(receipt.result.value,{type:'int',value:75});

      async function loadMethodLesson(step) {
        const lessons = element(page,'lessons');
        if (!await lessons.evaluate(node=>node.open)) await lessons.locator('summary').click();
        await lessons.locator(`[data-lesson-id="runtime-method"][data-step-id="${step}"]`).click();
      }
      await loadMethodLesson('describe-health');
      await fill(treeCallId,'describe_runtime_properties','source-node',target.path);
      assert.deepEqual(JSON.parse(await element(page,'input').inputValue()),{...target,names:['health']});
      const properties = await submitConsole(page,'describe_runtime_properties',{timeout});
      await loadMethodLesson('read');
      await fill(properties.callId,'read_runtime_properties','source-properties','health');
      const readback = (await submitConsole(page,'read_runtime_properties',{timeout})).reply;
      assert.equal(readback.receipt.run.runId,run.runId);
      assert.equal(readback.receipt.expectedInstanceId,target.expectedInstanceId);
      assert.deepEqual(consoleResult(readback).properties[0].value,{type:'int',value:75});
      const after = await screenshot(target,'method-after',true);
      assert(after.renderSerial > before.renderSerial);
      calls.push({op:'method-demo-validated',receipt,readback,health:75});
      await stop(run);
      const restarted = await play(), fresh = (await findPlayer(restarted)).target;
      assert.notEqual(restarted.runId,run.runId);
      assert.equal(runs[0].sourceHash,runs[1].sourceHash);
      assert.equal(await health(fresh),100);
      await screenshot(fresh,'method-restarted',false);
      const stale = {method:'take_damage',args:[{type:'int',value:25}],methodToken:method.methodToken};
      assert.equal((await api('call_runtime_method',{...target,...stale})).error.code,'run_ended');
      assert.equal((await api('call_runtime_method',{...fresh,...stale})).error.code,'binding_changed');
      assert.equal(await health(fresh),100);
      await stop(restarted);
    });

    await test.step('selected-method-draft-rejects-same-path-replacement', async () => {
      const document=exportProject(createRuntimeMethodDemo(release.runtimeProfile));
      document.files['/src/Player.ts']=document.files['/src/Player.ts'].replace('  private internalCounter', `  @bind.runtimeMethod({args:[],returns:'void'})
  replace_self(): void {
    const parent = this.get_parent();
    if (!parent) throw new Error('Expected a parent');
    parent.remove_child(this);
    const replacement = new Player();
    replacement.set_name('Player');
    parent.add_child(replacement);
    this.free();
  }
  private internalCounter`);
      await importProject('runtime-method-replacement.json',document);
      const run=await play(), {target:original,treeCallId}=await findPlayer(run);
      await fill(treeCallId,'describe_runtime_methods','source-node',original.path);
      const description=await submitConsole(page,'describe_runtime_methods',{timeout});
      await openConsoleOperation(page,'engine.runtime_call');
      await element(page,'input').fill(JSON.stringify({args:[25]}));
      await fill(description.callId,'engine.runtime_call','source-method','take_damage');
      const replaced=summerResult(await invokeRaw(original.path,'replace_self',[])).payload;
      assert.equal(replaced.receipt.expectedInstanceId,original.expectedInstanceId);
      const {target:fresh,treeCallId:freshTree}=await findPlayer(run);
      assert.notEqual(fresh.expectedInstanceId,original.expectedInstanceId);

      const methodPackets=()=>page.evaluate(()=>window.runtimeMethodDispatches.length);
      const before=await methodPackets();
      await openConsoleOperation(page,'engine.runtime_call');
      const stale=await submitConsole(page,'engine.runtime_call',{timeout});
      assert.equal(stale.reply.error.code,'node_changed');
      assert.equal(stale.reply.error.source,'native');
      const stalePackets=(await methodPackets())-before;
      assert.equal(stalePackets,1);
      const staleHealth=await health(fresh);
      assert.equal(staleHealth,100);

      await fill(freshTree,'describe_runtime_methods','source-node',fresh.path);
      const freshDescription=await submitConsole(page,'describe_runtime_methods',{timeout});
      await fill(freshDescription.callId,'engine.runtime_call','source-method','take_damage');
      const accepted=summerResult((await submitConsole(page,'engine.runtime_call',{timeout})).reply).payload;
      assert.equal(accepted.receipt.expectedInstanceId,fresh.expectedInstanceId);
      assert.equal(await health(fresh),75);
      await element(page,'history').locator(`[data-call-id="${stale.callId}"] [data-action="load-history"]`).click();
      assert.equal((await submitConsole(page,'engine.runtime_call',{timeout})).reply.error.code,'node_changed');
      assert.equal(await health(fresh),75);
      calls.push({op:'selected-method-replacement-validated',original,fresh,stale:stale.reply,stalePackets,staleHealth,accepted});
      await stop(run);
    });

    await test.step('native-call-boundaries-through-web', async () => {
      const document=exportProject(createRuntimeMethodDemo(release.runtimeProfile));
      document.files['/src/Player.ts']=document.files['/src/Player.ts'].replace('  private internalCounter', `  @bind.runtimeMethod({args:['int'],returns:'void'})
  fail(kind: number): void {
    this.health--;
    if (kind===0) throw undefined;
    if (kind===1) throw null;
    if (kind===3) throw Promise.reject(Error('runtime method threw a rejected Promise'));
    const self=this;
    throw {get message(){self.health=-500;return 'unexpected';},get stack(){self.health=-600;return 'unexpected';}};
  }
  @bind.runtimeMethod({args:[],returns:'int'})
  bad_result(): unknown { return Promise.resolve(this.health); }
  @bind.runtimeMethod({args:['bool'],returns:'int'})
  rejected_result(immediate: boolean): unknown {
    this.health--;
    const error = Error('runtime method returned a rejected Promise');
    const promise = immediate ? Promise.reject(error) : Promise.resolve().then(() => { throw error; });
    const unexpected = () => { this.health = -700; throw Error('runtime call inspected the returned Promise'); };
    Object.defineProperties(promise, {then:{get:unexpected}, constructor:{get:unexpected}});
    return promise;
  }
  @bind.runtimeMethod({args:[],returns:'string'})
  invalid_string(): string { return String.fromCharCode(0xd800); }
  @bind.runtimeMethod({args:['float'],returns:'float'})
  echo_float(value: number): number { return value; }
  @bind.runtimeMethod({args:[],returns:'float'})
  negative_zero(): number { return -0; }
  @bind.runtimeMethod({args:[],returns:'int'})
  ["\\uFEFFprefixed"](): number { return this.health; }
  @bind.runtimeMethod({args:[],returns:'void'})
  finish(): void {}
  @bind.runtimeMethod({args:[],returns:'int'})
  destroy(): number { this.free(); return 17; }
  @bind.runtimeMethod({args:['string','string','string','string','string'],returns:'void'})
  consume_strings(a:string,b:string,c:string,d:string,e:string): void { this.health--; }
  private internalCounter`) + `
Object.defineProperty(Player.prototype.take_damage, 'apply', {get(){throw Error('method.apply was invoked');}});
`;
      await importProject('runtime-method-boundaries.json',document);
      const run = await play(), {target} = await findPlayer(run);
      const exactName = '\uFEFFprefixed';
      const names = consoleResult(await api('describe_runtime_methods',target)).methods.map(item=>item.method);
      assert(names.includes(exactName));
      assert(!names.includes('prefixed'));
      assert.equal((await invokeRaw(target.path,'prefixed',[])).error.code,'method_not_found');
      assert.equal(summerResult(await invokeRaw(target.path,exactName,[])).payload.result.value.value,100);
      const {methods:[descriptor]}=consoleResult(await api('describe_runtime_methods',{...target,method:'consume_strings'}));
      const before=await page.evaluate(()=>window.runtimeMethodDispatches.length);
      const nullLimit=await api('describe_runtime_methods',{...target,limit:null});
      assert.equal(nullLimit.error.code,'invalid_input');
      const oversized=await page.evaluate(input=>{
        const controller=new AbortController();
        const pending=window.godotPlayground.call_runtime_method(input,controller.signal);
        controller.abort();
        return pending;
      },{...target,method:descriptor.method,methodToken:descriptor.methodToken,args:Array.from({length:5},()=>({type:'string',value:'a'.repeat(1000)}))});
      assert.deepEqual(oversized,{ok:false,error:{code:'bad_args',source:'sdk',message:'bad_args'}});
      const packets=(await page.evaluate(()=>window.runtimeMethodDispatches.length))-before;
      assert.equal(packets,0);
      assert.equal(await health(target),100);
      calls.push({op:'method-request-validation',nullLimit,oversized,packets,health:100});
      assert.equal((await damage(target.path,'25')).error.code,'bad_args');
      assert.equal(summerResult(await damage(target.path)).payload.result.value.value,75);
      assert.equal((await api('describe_runtime_methods',{...target,method:'_ready'})).error.code,'method_not_found');
      for(let index=0;index<4;index++) {
        const failed=await invokeRaw(target.path,'fail',[index]);
        assert.equal(failed.error.code,'call_error');
        const result=failed.error.details.godotai.receipt.result;
        assert.equal(result.outcome,'threw');
        assert.equal(result.callEntered,true);
        const liveHealth=await health(target);
        assert.equal(liveHealth,74-index);
        if(index===3) calls.push({op:'thrown-promise-rejection-contained',result,health:liveHealth});
      }
      const unavailable=await invokeRaw(target.path,'bad_result',[]);
      assert.equal(unavailable.error.code,'result_unavailable');
      const rejections = [];
      for (const [immediate, expectedHealth] of [[true, 70], [false, 69]]) {
        const rejected = await invokeRaw(target.path, 'rejected_result', [immediate]);
        assert.equal(rejected.error.code, 'result_unavailable');
        const result = rejected.error.details.godotai.receipt.result;
        assert.equal(result.callEntered, true);
        assert.equal(result.reason, 'type_mismatch');
        const liveHealth = await health(target);
        assert.equal(liveHealth, expectedHealth);
        rejections.push({immediate,result,health:liveHealth});
      }
      calls.push({op:'returned-promise-rejections-contained',rejections});
      const malformed=await invokeRaw(target.path,'invalid_string',[]);
      assert.equal(malformed.error.code,'result_unavailable');
      assert.equal(malformed.error.details.godotai.receipt.result.callEntered,true);
      assert.equal(malformed.error.details.godotai.receipt.result.reason,'encoding_failed');
      calls.push({op:'exact-method-names-and-encoding-failure',exactName,names,malformed});
      const floats = await page.evaluate(async path => {
        const call = (method, args) => window.godotPlayground.summer_call({op:'engine.runtime_call',input:{path,method,args}});
        const roundTrips = [];
        for (const input of [-0, Number.MIN_VALUE, -Number.MIN_VALUE, 2.225073858507201e-308, Number.MAX_VALUE]) {
          const reply = await call('echo_float', [input]);
          roundTrips.push({input: Object.is(input, -0) ? '-0' : String(input),
            exact: Object.is(reply.result?.data?.payload?.result?.value?.value, input), error: reply.error?.code});
        }
        const returned = await call('negative_zero', []);
        return {roundTrips, negativeZeroReturned: Object.is(returned.result?.data?.payload?.result?.value?.value, -0)};
      }, target.path);
      calls.push({op:'exact-finite-float-calls', ...floats});
      assert(floats.roundTrips.every(item => item.exact), JSON.stringify(floats.roundTrips));
      assert.equal(floats.negativeZeroReturned, true);

      // This tab still has the previous project's draft. Submit the current
      // run's IDs manually and use the successful reply to fill a method call.
      const description = await invokeConsole(page,'describe_runtime_methods',{...target,method:'echo_float'},{refreshTarget:false,timeout});
      await openConsoleOperation(page,'engine.runtime_call');
      await element(page,'input').fill('{"args":[-0]}');
      await fill(description.callId,'engine.runtime_call','source-method','echo_float');
      await element(page,'format').click();
      const draftText = await element(page,'input').inputValue();
      const keepsArgument = Object.is(JSON.parse(draftText).args[0], -0);
      assert.equal(keepsArgument, true);
      const request = JSON.parse(await element(page,'request').textContent());
      assert(Object.is(request.input.args[0], -0));
      const consoleReceipt = summerResult((await submitConsole(page,'engine.runtime_call',{timeout})).reply).payload;
      const historyRequest = JSON.parse(await element(page,'call-request').textContent());
      assert(Object.is(historyRequest.input.args[0], -0));
      const keepsResult = Object.is(consoleReceipt.result.value.value, -0);
      assert.equal(keepsResult, true);
      assert.equal(consoleReceipt.receipt.run.runId,run.runId);
      assert.equal(consoleReceipt.receipt.expectedInstanceId,target.expectedInstanceId);
      calls.push({op:'console-preserves-signed-zero',keepsArgument,keepsResult});
      calls.push({op:'explicit-method-discovery-current-project',discovery:description.reply.receipt,invocation:consoleReceipt.receipt});
      assert.deepEqual(summerResult(await invokeRaw(target.path,'finish',[])).payload.result.value,{type:'void'});
      assert.equal(summerResult(await invokeRaw(target.path,'destroy',[])).payload.result.value.value,17);
      assert.equal((await api('describe_runtime_methods',target)).error.code,'node_not_found');
      await stop(run);
    });

    await test.step('async-and-generator-methods-are-rejected-at-registration', async () => {
      const document=exportProject(createRuntimeMethodDemo(release.runtimeProfile));
      document.files['/src/Player.ts']=document.files['/src/Player.ts']
        .replace('const bind = createClassBinder();', `const bind = createClassBinder();
let rejected = 0;
function expectRejection(method: Function, context: ClassMethodDecoratorContext): void {
  try { bind.runtimeMethod({args:[],returns:'void'})(method, context); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Runtime methods must be synchronous')) throw error;
    rejected++;
  }
}`)
        .replace('  private internalCounter', `  @expectRejection
  async deferred_failure(): Promise<void> {
    await Promise.resolve();
    throw Error('async runtime method was entered');
  }
  @expectRejection
  *generator_damage() { this.health--; }
  @expectRejection
  async *async_generator_damage() { this.health--; }
  @bind.runtimeMethod({args:[],returns:'int'})
  rejected_declarations(): number { return rejected; }
  private internalCounter`);
      await importProject('runtime-method-async-registration.json',document);
      const run=await play(), {target}=await findPlayer(run);
      const methods=consoleResult(await api('describe_runtime_methods',target)).methods.map(item=>item.method);
      assert.deepEqual(methods, ['rejected_declarations', 'take_damage']);
      const count=summerResult(await invokeRaw(target.path,'rejected_declarations',[])).payload.result.value.value;
      assert.equal(count,3);
      const rejected=await invokeRaw(target.path,'deferred_failure',[]);
      assert.equal(rejected.error.code,'method_not_found');
      assert.equal(await health(target),100);
      calls.push({op:'async-and-generator-methods-rejected',methods,count,rejected});
      await stop(run);
    });

    await test.step('invalid-method-name-cannot-register-an-alias', async () => {
      const document=exportProject(createRuntimeMethodDemo(release.runtimeProfile));
      const invalidName='part\u0000hidden';
      document.files['/src/Player.ts']=document.files['/src/Player.ts'].replace('  private internalCounter', `  @bind.runtimeMethod({args:[],returns:'int'})
  [${JSON.stringify(invalidName)}](): number { this.health -= 25; return this.health; }
  private internalCounter`);
      await importProject('runtime-method-invalid-name.json',document);
      const run=await play(), {target}=await findPlayer(run);
      const description=await api('describe_runtime_methods',target);
      assert.equal(description.error.code,'not_ready');
      const alias=await invokeRaw(target.path,'part',[]);
      assert.equal(alias.error.code,'not_ready');
      assert.equal(await health(target),100);
      calls.push({op:'invalid-method-name-rejected',invalidName,description,alias,health:100});
      await stop(run);
    });
  }
  assert.deepEqual(errors,[]);
  test.checkpoint({available,engineExecuted:true,runs,images,calls});
  return withAcceptanceContext({status:'passed',scope:title,available,engineExecuted:true,runs,images,calls,releaseId:release.id,descriptorHash,candidateId},{directory,browser});
}});
