import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {siteIdentity,sitePayloads,digest,canonical} from './site-evidence.mjs';
import {runConfigurationHash} from './worker-candidate.mjs';

const browserEvidence=new WeakMap();
const passiveRecorders=new WeakMap();
/** Firefox can report its browser warnings as a Playwright `log` event.
 * Preserve that exact raw wrapper; ordinary application log text is not a
 * warning merely because it mentions a warning or a feature policy. */
export function isBrowserConsoleWarning(type,text){
 return type==='warning'||typeof text==='string'&&/^\[JavaScript Warning: "[\s\S]*"(?: \{[\s\S]*\})?\]$/.test(text);
}
export const PASSIVE_RECORDER_MAX_BYTES=1024*1024;
/** A one-way console transport. Playwright binding replies and JSHandle
 * evaluation can synthesize user activation, so neither is used here. Install
 * before navigating the document that will produce records. */
export async function installPassiveRecorder(context,name,callback,{onError}={}){
 if(typeof name!=='string'||!/^[$A-Z_a-z][$\w]{0,127}$/.test(name)||['__proto__','constructor','prototype'].includes(name)||typeof callback!=='function')throw Error('E_PASSIVE_RECORDER_ARGUMENT');
 let registered=passiveRecorders.get(context);if(!registered){registered=new Map();passiveRecorders.set(context,registered);}if(registered.has(name))throw Error('E_PASSIVE_RECORDER_DUPLICATE: '+name);
 const prefix='__godot_passive_recorder_'+randomUUID()+':',errors=[],pending=new Set();let disposed=false;
 const fail=error=>{
  const diagnostic=('E_PASSIVE_RECORDER: '+name+' '+String(error?.message??error)).slice(0,4096);
  if(errors.length<32){errors.push(diagnostic);if(onError){try{onError(Error(diagnostic));}catch(handlerError){process.stderr.write(String(handlerError)+'\n');process.exitCode=1;}}else{process.stderr.write(diagnostic+'\n');process.exitCode=1;}}
 };
 const listen=message=>{
  // text/page/location are event metadata. Do not use args().jsonValue(),
  // evaluate(), or any browser-side reply to acknowledge a record.
  const text=message.text();if(!text.startsWith(prefix))return;
  try{
   const raw=text.slice(prefix.length);if(Buffer.byteLength(raw,'utf8')>PASSIVE_RECORDER_MAX_BYTES)throw Error('metadata exceeds 1 MiB');
   const packet=JSON.parse(raw);if(packet.schemaVersion!==1)throw Error('invalid transport schema');
   if(packet.type==='error')throw Error(String(packet.message??'browser serialization failed'));
   if(packet.type!=='record'||!Array.isArray(packet.args))throw Error('invalid record envelope');
   const source={page:typeof message.page==='function'?message.page():null,location:message.location()};
   const result=callback(source,...packet.args);
   if(result&&typeof result.then==='function'){
    const task=Promise.resolve(result).catch(fail);pending.add(task);void task.then(()=>pending.delete(task));
   }
  }catch(error){fail(error);}
 };
 const control={get errors(){return [...errors];},assertHealthy(){if(errors.length)throw Error(errors.join('\n'));},async flush(){await Promise.all([...pending]);this.assertHealthy();},dispose(){if(disposed)return;disposed=true;context.off('console',listen);}};
 registered.set(name,control);context.on('console',listen);context.once('close',()=>control.dispose());
 const browser=context.browser?.(),evidence=browser&&browserEvidence.get(browser);evidence?.recorders.add(control);
 try{await context.addInitScript(({name,prefix,maxBytes})=>{
  const debug=console.debug.bind(console),encoder=new TextEncoder();
  const serialize=value=>{
   const chunks=[],ancestors=new Set();let bytes=0;
   const append=text=>{if(text.length>maxBytes||(bytes+=encoder.encode(text).byteLength)>maxBytes)throw Error('metadata exceeds 1 MiB');chunks.push(text);};
   const string=value=>{if(value.length>maxBytes)throw Error('metadata exceeds 1 MiB');append(JSON.stringify(value));};
   const write=(value,depth)=>{
    if(depth>64)throw Error('metadata nesting exceeds 64');
    if(value===null||value===undefined){append('null');return;}
    if(typeof value==='string'){string(value);return;}
    if(typeof value==='boolean'){append(value?'true':'false');return;}
    if(typeof value==='number'){if(!Number.isFinite(value))throw Error('metadata contains a nonfinite number');append(String(value));return;}
    if(typeof value!=='object')throw Error('metadata contains a non-JSON value');
    if(ancestors.has(value))throw Error('metadata contains a cycle');
    if(ArrayBuffer.isView(value)||value instanceof ArrayBuffer)throw Error('binary data is not recorder metadata');
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
    if(!array&&prototype!==Object.prototype&&prototype!==null)throw Error('metadata must contain plain records');
    ancestors.add(value);append(array?'[':'{');let count=0;
    if(array){if(value.length>maxBytes/2)throw Error('metadata exceeds 1 MiB');for(let index=0;index<value.length;index++){if(count++)append(',');write(value[index],depth+1);}}
    else for(const key of Object.keys(value)){
     const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value' in descriptor))throw Error('metadata contains an accessor');
     if(descriptor.value===undefined)continue;if(count++)append(',');string(key);append(':');write(descriptor.value,depth+1);
    }
    append(array?']':'}');ancestors.delete(value);
   };
   write(value,0);return chunks.join('');
  };
  Object.defineProperty(globalThis,name,{configurable:false,writable:false,value:(...args)=>{
   try{debug(prefix+serialize({schemaVersion:1,type:'record',args}));}
   catch(error){debug(prefix+JSON.stringify({schemaVersion:1,type:'error',message:String(error?.message??error).slice(0,1024)}));}
   return Promise.resolve(undefined);
  }});
 },{name,prefix,maxBytes:PASSIVE_RECORDER_MAX_BYTES});}catch(error){control.dispose();fail(error);throw error;}
 return control;
}
const browserEnvironmentKeys=Object.freeze(['LIBGL_ALWAYS_SOFTWARE','LIBGL_ALWAYS_INDIRECT','LIBGL_DRI3_DISABLE','MESA_LOADER_DRIVER_OVERRIDE','MESA_GL_VERSION_OVERRIDE','MESA_GLSL_VERSION_OVERRIDE','MESA_NO_ERROR','MESA_DEBUG','GALLIUM_DRIVER','WEBKIT_DISABLE_DMABUF_RENDERER','WEBKIT_FORCE_DMABUF_RENDERER','WEBKIT_DISABLE_COMPOSITING_MODE','WEBKIT_FORCE_COMPOSITING_MODE','WEBKIT_FORCE_ACCELERATED_COMPOSITING','WEBKIT_DISABLE_ACCELERATED_COMPOSITING','WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS','WEBKIT_FORCE_SANDBOX','MOZ_WEBRENDER','MOZ_ACCELERATED','MOZ_X11_EGL','MOZ_ENABLE_WAYLAND','MOZ_DISABLE_RDD_SANDBOX']);
/** Record only public rendering/settings flags and presence of native hooks.
 * Display/audio routing are environment metadata, not browser feature overrides. */
export function browserEnvironmentEvidence(environment=process.env){
 const present=name=>environment[name]!==undefined&&String(environment[name]).trim()!=='';
 const publicValue=name=>{const value=String(environment[name]??'').trim();return /^[A-Za-z0-9_.:/,+-]{1,128}$/.test(value)?value:'[set]';};
 const envOverrides=Object.fromEntries(browserEnvironmentKeys.filter(present).map(name=>[name,publicValue(name)]));
 for(const name of ['LD_PRELOAD','LD_LIBRARY_PATH'])if(present(name))envOverrides[name]=true;
 if(environment.PLAYGROUND_BROWSER_SETTINGS_TIER==='environment-override')envOverrides.explicitSettingsTier=true;
 const renderingEnvironment={display:present('DISPLAY')?publicValue('DISPLAY'):null,waylandDisplayConfigured:present('WAYLAND_DISPLAY'),virtualDisplay:environment.PLAYGROUND_VIRTUAL_DISPLAY==='1',audioDeviceKind:['pulse-null-sink','physical'].includes(environment.PLAYGROUND_AUDIO_DEVICE_KIND)?environment.PLAYGROUND_AUDIO_DEVICE_KIND:'unspecified',pulseServerConfigured:present('PULSE_SERVER'),pulseSink:present('PULSE_SINK')?publicValue('PULSE_SINK'):null};
 return {envOverrides,environment:renderingEnvironment,settingsTier:Object.keys(envOverrides).length?'environment-override':'default'};
}
const containerLaunchArguments=new Set(['--no-sandbox','--disable-dev-shm-usage']);
export function browserLaunchArgumentEvidence(args=[],{browser='chromium',defaultSettings=process.env.PLAYGROUND_BROWSER_DEFAULT_SETTINGS==='1'}={}){
 const requestedLaunchArgs=[...args];
 const removedForDefault=value=>defaultSettings&&/swiftshader|use-angle|use-gl|enable-webgl|autoplay-policy/.test(value);
 const launchArgs=browser==='chromium'?requestedLaunchArgs.filter(value=>!removedForDefault(value)):[];
 const containerArgs=launchArgs.filter(value=>containerLaunchArguments.has(value)),featureLaunchArgs=launchArgs.filter(value=>!containerLaunchArguments.has(value));
 const overridden=featureLaunchArgs.some(value=>/swiftshader|use-angle|use-gl|disable-web-security|autoplay-policy|enable-features|disable-features|use-fake|fake-device|fake-ui|webxr-test|force-webxr|webxr-force|enable-experimental/.test(value));
 return {requestedLaunchArgs,launchArgs,containerArgs,featureLaunchArgs,removedLaunchArgs:browser==='chromium'?requestedLaunchArgs.filter(removedForDefault):[],ignoredLaunchArgs:browser==='chromium'?[]:requestedLaunchArgs,settingsTier:overridden?'environment-override':'default'};
}
/** Native product and Worker tools consume the same ordinary build output. */
export function defaultTestDirectory({shellOnly=process.env.PLAYGROUND_TEST_SHELL==='1'}={}){
 return path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL(shellOnly?'../dist-shell':'../dist',import.meta.url)));
}
export const observedWorkerSessions=browser=>[...(browserEvidence.get(browser)?.sessions.values()??[])];
export const observedWorkerOutcomes=browser=>[...(browserEvidence.get(browser)?.outcomes.values()??[])];
export const browserLaunchEvidence=browser=>browserEvidence.get(browser)?.browser??{};
/** The Host publishes a new frozen snapshot for every change. Events and
 * polling can observe the same object; serialize each reference only once.
 * New heartbeat, audio, memory and terminal objects must all reach Node. */
export function installWorkerSessionRecorder({presentationBackend}={}){
 if(presentationBackend){const url=new URL(location.href);url.searchParams.set('presentationBackend',presentationBackend);try{history.replaceState(null,'',url);}catch{}}
 const seen=new WeakSet();
 const record=value=>{
  if(!value||typeof value!=='object'||typeof value.workerId!=='string'||!value.workerId||seen.has(value))return;
  const failed=error=>{seen.delete(value);console.error('E_WORKER_SESSION_RECORDER: '+String(error?.message??error));};
  try{
   if(typeof globalThis.__recordWorkerAcceptanceSession!=='function')throw Error('Passive transport unavailable');
   const pending=globalThis.__recordWorkerAcceptanceSession(value);seen.add(value);
   // This observes a local transport Promise only; no browser IPC reply,
   // Playwright binding/evaluation or user activation is involved.
   if(pending&&typeof pending.then==='function')void Promise.resolve(pending).catch(failed);
  }catch(error){failed(error);}
 };
 addEventListener('playground-runtime-session',event=>record(event.detail));
 setInterval(()=>{const snapshot=globalThis.__playgroundRuntimeSession;record(typeof snapshot==='function'?snapshot():snapshot);},50);
}
async function captureWorkerSessions(context,evidence){
 await installPassiveRecorder(context,'__recordWorkerAcceptanceSession',(_source,snapshot)=>{
  if(!snapshot||typeof snapshot.workerId!=='string')return;
  evidence.outcomes.set(snapshot.workerId,structuredClone(snapshot));
  if(snapshot.workerState!=='running'&&!evidence.sessions.has(snapshot.workerId))return;
  evidence.sessions.set(snapshot.workerId,structuredClone(snapshot));
 });
 await context.addInitScript(installWorkerSessionRecorder,{presentationBackend:process.env.PLAYGROUND_PRESENTATION_BACKEND});
}

export async function launchBrowser(options={}){
 const name=options.browser??process.env.BROWSER??'chromium';
 if(!['chromium','firefox','webkit'].includes(name))throw Error('E_BROWSER: '+name);
 const playwright=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
 const {args,executablePath,browser:ignored,...shared}=options;
 const configured=process.env['PLAYWRIGHT_'+name.toUpperCase()+'_EXECUTABLE'];
 const executable=configured||(name==='chromium'?(executablePath??(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined)):undefined);
 if(process.env.PLAYGROUND_PRESENTATION_BACKEND&&!['direct','bitmap'].includes(process.env.PLAYGROUND_PRESENTATION_BACKEND))throw Error('E_TEST_PRESENTATION_BACKEND');
 const argumentEvidence=browserLaunchArgumentEvidence(args??[],{browser:name}),{launchArgs}=argumentEvidence;
 const browser=await playwright[name].launch({...shared,headless:process.env.BROWSER_HEADLESS==='0'?false:(shared.headless??true),...(executable?{executablePath:executable}:{}),...(name==='chromium'?{args:launchArgs}:{})});
 const environmentEvidence=browserEnvironmentEvidence(shared.env??process.env),settingsOverrides={userPreferencesOverridden:Boolean(shared.firefoxUserPrefs&&Object.keys(shared.firefoxUserPrefs).length),defaultArgumentsOverridden:Boolean(shared.ignoreDefaultArgs)};
 const settingsTier=environmentEvidence.settingsTier==='environment-override'||Object.values(settingsOverrides).some(Boolean)||argumentEvidence.settingsTier==='environment-override'?'environment-override':'default';
 const evidence={sessions:new Map(),outcomes:new Map(),recorders:new Set(),browser:{platform:process.platform,...argumentEvidence,executablePath:executable??null,...environmentEvidence,settingsOverrides,settingsTier}};
 browserEvidence.set(browser,evidence);
 const newContext=browser.newContext.bind(browser);
 browser.newContext=async options=>{const context=await newContext(options);await captureWorkerSessions(context,evidence);return context;};
 return browser;
}
export const launchTestBrowser=launchBrowser;

/** Reports bind the actual bytes under test, never just a recent timestamp. */
export async function withAcceptanceContext(report,{directory,browser,testMode='real-engine',contextFile=process.env.PLAYGROUND_ACCEPTANCE_CONTEXT}={}){
 for(const recorder of browserEvidence.get(browser)?.recorders??[])await recorder.flush();
 if(testMode==='shell'){
  if(contextFile)throw Error('E_TEST_SHELL_PRODUCT_CONTEXT');
  const shell=JSON.parse(await readFile(path.join(directory,'shell-profile.json'),'utf8'));
  if(shell.shellOnly!==true)throw Error('E_TEST_SHELL_FIXTURE');
  const siteHash=digest(canonical(await sitePayloads(directory)));
  return {...report,profile:shell.runtimeProfile,releaseId:null,descriptorHash:null,candidateId:siteHash,siteHash,runId:randomUUID(),testMode:'shell',browser:{name:browser.browserType().name(),version:browser.version()}};
 }
 if(testMode!=='real-engine')throw Error('E_TEST_MODE');
 const actual=await siteIdentity(directory);
 let site;try{site=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 const worker=site?.schemaVersion===3&&site.runtime?.executionBackend==='worker';
 let expected;
 if(contextFile){
  expected=JSON.parse(await readFile(contextFile,'utf8'));
  for(const key of ['profile','releaseId','descriptorHash','candidateId','siteHash'])if(expected[key]!==actual[key])throw Error('E_TEST_CANDIDATE_DRIFT: '+key);
  const key=worker?'acceptanceBatchId':'runId';
  if(expected.schemaVersion===(worker?2:3)||typeof expected[key]!=='string'||!expected[key])throw Error('E_TEST_RUN_ID');
 }
 for(const key of ['profile','releaseId','descriptorHash','candidateId','siteHash'])if(report[key]!==undefined&&report[key]!==actual[key])throw Error('E_TEST_RELEASE_ID: '+key);
 const {payloads,...identity}=actual;
 const recorded=browserEvidence.get(browser),browserInfo={name:browser.browserType().name(),version:browser.version(),...(recorded?.browser??{})};
 if(worker){
  if(Object.hasOwn(report,'runId')||report.schemaVersion===2)throw Error('E_TEST_WORKER_LEGACY_EVIDENCE');
  const sessions=report.sessions??[...(recorded?.sessions.values()??[])];
  const configured=process.env.PLAYGROUND_RUN_CONFIGURATION?JSON.parse(await readFile(process.env.PLAYGROUND_RUN_CONFIGURATION,'utf8')):undefined;
  const configuration=report.runConfiguration??sessions.at(-1)?.runConfiguration??configured;
  // Delivery-only suites have no engine session; their caller must still
  // supply the requested immutable protocol configuration.
  if(!configuration)throw Error('E_TEST_WORKER_CONFIGURATION_UNOBSERVED');
  const configurationHash=runConfigurationHash(configuration);
  if(report.runConfigurationHash!==undefined&&report.runConfigurationHash!==configurationHash)throw Error('E_TEST_WORKER_CONFIGURATION_DRIFT');
  return {...report,...identity,schemaVersion:3,acceptanceBatchId:expected?.acceptanceBatchId??randomUUID(),runConfiguration:configuration,runConfigurationHash:configurationHash,sessions,testMode,browser:browserInfo};
 }
 return {...report,...identity,runId:expected?.runId??randomUUID(),testMode,browser:browserInfo};
}
