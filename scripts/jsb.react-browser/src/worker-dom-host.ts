import { drawingBufferSize, type CanvasGeometry } from './worker-presentation.js';
import { DOM_ELEMENT_PROPERTIES, DOM_INPUT_EVENTS, DOM_STYLE_PROPERTIES, type DomHostCommand, type DomHostState, type DomInputPacket } from './worker-dom.js';
import { collectDrop } from './worker-drop.js';
import { createWorkerHostServicesHost, type HostServiceCommand } from './worker-host-services.js';
import { benchmarkNow, type BenchmarkInputTiming } from './worker-benchmark.js';

export interface InputHostOptions {
  canvas: HTMLCanvasElement; geometry: CanvasGeometry;
  sendInput(packet: DomInputPacket): void; sendState(state: DomHostState): void;
  onGesture?(event: Event): void; onError?(error: unknown): void;
  benchmarkTimings?:boolean; benchmarkClock?:()=>number;
}
/** Main realm owns real editable nodes and privileged gesture APIs. No host
 * command is evaluated as JavaScript or accepted as arbitrary HTML. */
export function createInputHost(options: InputHostOptions) {
  const canvas = options.canvas, document = canvas.ownerDocument, window = document.defaultView!;
  if (!window) throw Error('E_WORKER_DOM_WINDOW');
  let geometry = { ...options.geometry }; drawingBufferSize(geometry);
  let closed = false, sequence = 0;
  const privilegedOperations=new Set<Promise<void>>();let disposePromise:Promise<void>|undefined,fullscreenExit:Promise<void>|undefined,pointerExit:Promise<void>|undefined,pointerRequest:Promise<void>|undefined;
  const elements = new Map<string, HTMLElement>();
  const listeners: Array<() => void> = [];
  const nodeListeners = new Map<HTMLElement, Array<() => void>>();
  const downloads = new Map<string, ReturnType<typeof setTimeout>>();
  let downloadBytes = 0;
  const utterances = new Map<number, SpeechSynthesisUtterance>();
  const mouseButtons = new Map<number, Record<string, unknown>>();
  const pointerButtons = new Map<number, Record<string, unknown>>();
  const pressedKeys = new Map<string, {target:string;fields:Record<string,unknown>}>();
  const dropAborter=new AbortController();let dropSerial=0,dropBusy:number|undefined;
  const previousTouchAction = canvas.style.touchAction, previousTabIndex = canvas.tabIndex;
  canvas.tabIndex = 0; canvas.style.touchAction = 'none';
  const properties = new Set(DOM_ELEMENT_PROPERTIES), styles = new Set(DOM_STYLE_PROPERTIES);
  function sendState(state: Omit<DomHostState,'type'>) { if (!closed) options.sendState({ type:'dom-state', ...state }); }
  const services=createWorkerHostServicesHost({navigator:window.navigator,sendState:state=>sendState({services:state}),onError:options.onError});
  function on(target: EventTarget, event: string, callback: EventListener, local?: Array<() => void>) {
    target.addEventListener(event,callback,{ passive:false });
    (local ?? listeners).push(() => target.removeEventListener(event,callback));
  }
  function serialize(event: Event, target: string): Record<string, unknown> {
    const input = event as unknown as Record<string, any>, fields: Record<string, unknown> = {};
    for (const key of ['key','code','repeat','isComposing','shiftKey','ctrlKey','altKey','metaKey','button','buttons','movementX','movementY','deltaX','deltaY','deltaZ','deltaMode','pointerId','pointerType','pressure','data','inputType']) {
      if (typeof input[key] === 'string') fields[key] = input[key].slice(0,65536);
      else if (typeof input[key] === 'number' && Number.isFinite(input[key]) || typeof input[key] === 'boolean') fields[key] = input[key];
    }
    const rect = canvas.getBoundingClientRect();
    if (input.gamepad) fields.gamepad = { index:input.gamepad.index,id:String(input.gamepad.id).slice(0,256),mapping:input.gamepad.mapping };
    function point(value: any) { return { identifier: value.identifier, clientX:value.clientX, clientY:value.clientY,
      normalizedX:rect.width ? (value.clientX-rect.left)/rect.width : 0, normalizedY:rect.height ? (value.clientY-rect.top)/rect.height : 0,
      force:value.force ?? 0, radiusX:value.radiusX ?? 0, radiusY:value.radiusY ?? 0 }; }
    if (Number.isFinite(input.clientX) && Number.isFinite(input.clientY)) Object.assign(fields,point(input));
    for (const key of ['touches','changedTouches','targetTouches']) if (input[key]) fields[key] = Array.from(input[key] as ArrayLike<unknown>).slice(0,32).map(point);
    const element = elements.get(target) as HTMLInputElement | undefined;
    if (element && ['input','compositionstart','compositionupdate','compositionend','keydown','keyup'].includes(event.type)) {
      fields.value = element.value ?? element.textContent ?? ''; fields.selectionStart = element.selectionStart ?? 0; fields.selectionEnd = element.selectionEnd ?? 0;
    }
    return fields;
  }
  function forward(target: string, event: Event) {
    if (closed) return;
    const capturedAtMs=options.benchmarkTimings?(options.benchmarkClock??benchmarkNow)():undefined;
    const fields=serialize(event,target);
    forwardFields(target,event.type,fields,capturedAtMs===undefined?undefined:{capturedAtMs,forwardedAtMs:(options.benchmarkClock??benchmarkNow)(),trusted:event.isTrusted});
  }
  function forwardFields(target:string,event:string,fields:Record<string,unknown>,timing?:BenchmarkInputTiming) {
    if (!closed) options.sendInput({ type:'dom-input', sequence:++sequence, target, event, fields, geometry:{...geometry},...(timing?{timing}:{}) });
  }
  function captured():boolean {
    return document.activeElement === canvas || document.pointerLockElement === canvas || mouseButtons.size > 0 || pointerButtons.size > 0;
  }
  function rememberKey(target:string,event:Event) {
    const fields = serialize(event,target), code = String(fields.code ?? fields.key ?? '');
    if (event.type === 'keydown') pressedKeys.set(code,{target,fields}); else pressedKeys.delete(code);
  }
  function releaseHeld():void {
    for (const [button,fields] of mouseButtons) { mouseButtons.delete(button); forwardFields('window','mouseup',{...fields,button,buttons:0}); }
    for (const [pointerId,fields] of pointerButtons) {
      pointerButtons.delete(pointerId); forwardFields('window','pointerup',{...fields,pointerId,buttons:0});
      try { canvas.releasePointerCapture(pointerId); } catch { /* Capture may already be gone. */ }
    }
    for (const [code,entry] of pressedKeys) { pressedKeys.delete(code); forwardFields(entry.target,'keyup',{...entry.fields,repeat:false}); }
  }
  function gesture(event: Event) {
    if (!event.isTrusted) return;
    options.onGesture?.(event);
  }
  function reply(command: DomHostCommand, result?: unknown, error?: unknown) {
    if (command.requestId !== undefined) sendState({ requestId:command.requestId, result, ...(error ? { error:error instanceof Error ? error.message.slice(0,1024) : String(error).slice(0,1024) } : {}) });
    else if (error) options.onError?.(error);
  }
  function requestPointerLock():Promise<void>{
    // A document event has no request ID. Coalesce repeated requests for this
    // canvas, and use a native Promise's own result whenever it is available.
    if(pointerRequest)return pointerRequest;
    let complete!:()=>void,fail!:(error:unknown)=>void;
    const operation=new Promise<void>((resolve,reject)=>{complete=resolve;fail=reject;});pointerRequest=operation;
    const clear=()=>{if(pointerRequest===operation)pointerRequest=undefined;};void operation.then(clear,clear);
    let settled=false,mode:'calling'|'promise'|'event'='calling',earlyEvent:'grant'|'error'|undefined;
    const remove=()=>{document.removeEventListener('pointerlockchange',changed);document.removeEventListener('pointerlockerror',failed);};
    const finish=(error?:unknown)=>{if(settled)return;settled=true;remove();if(error)fail(error);else complete();};
    const changed=()=>{if(document.pointerLockElement!==canvas)return;if(mode==='calling')earlyEvent='grant';else if(mode==='event')finish();};
    const failed=()=>{if(mode==='calling')earlyEvent='error';else if(mode==='event')finish(Error('E_WORKER_POINTER_LOCK_FAILED'));};
    // Register before invocation for older void APIs which can dispatch during
    // the call. Existing lock state alone does not complete a new request.
    document.addEventListener('pointerlockchange',changed);document.addEventListener('pointerlockerror',failed);
    try{
      const result=canvas.requestPointerLock();
      if(result&&typeof result.then==='function'){mode='promise';remove();void result.then(()=>finish(),finish);}
      else{mode='event';if(earlyEvent==='grant')finish();else if(earlyEvent==='error')failed();}
    }catch(error){finish(error);}
    return operation;
  }
  function exitPointerLock():Promise<void>{
    if(document.pointerLockElement!==canvas)return Promise.resolve();if(pointerExit)return pointerExit;
    const operation=new Promise<void>((resolve,reject)=>{
      let settled=false;
      const finish=(error?:unknown)=>{if(settled)return;settled=true;document.removeEventListener('pointerlockchange',changed);document.removeEventListener('pointerlockerror',failed);if(error)reject(error);else resolve();};
      const changed=()=>{if(document.pointerLockElement!==canvas)finish();};const failed=()=>finish(Error('E_WORKER_POINTER_UNLOCK_FAILED'));
      document.addEventListener('pointerlockchange',changed);document.addEventListener('pointerlockerror',failed);
      try{document.exitPointerLock();changed();}catch(error){finish(error);}
    });pointerExit=operation.finally(()=>{pointerExit=undefined;});return pointerExit;
  }
  function exitFullscreen():Promise<void>{
    if(document.fullscreenElement!==canvas)return Promise.resolve();if(fullscreenExit)return fullscreenExit;
    try{fullscreenExit=Promise.resolve(document.exitFullscreen()).finally(()=>{fullscreenExit=undefined;});}catch(error){return Promise.reject(error);}return fullscreenExit;
  }
  async function privileged(command: DomHostCommand) {
    let compensating=false;
    try {
      if(closed)return;
      let result: unknown;
      switch (command.operation) {
        case 'pointer-lock': await requestPointerLock();if(closed&&document.pointerLockElement===canvas){compensating=true;await exitPointerLock();}break;
        case 'fullscreen': await canvas.requestFullscreen();if(closed&&document.fullscreenElement===canvas){compensating=true;await exitFullscreen();}break;
        case 'pointer-unlock':await exitPointerLock();break;
        case 'exit-fullscreen':await exitFullscreen();break;
        case 'clipboard-write': if (typeof command.value !== 'string' || command.value.length > 65536) throw Error('E_WORKER_CLIPBOARD_BUDGET'); await window.navigator.clipboard.writeText(command.value); break;
        case 'clipboard-read': result = (await window.navigator.clipboard.readText()).slice(0,65536); break;
        case 'open': {
          if (typeof command.value !== 'string' || command.value.length > 8192) throw Error('E_WORKER_OPEN_URL');
          const url = new URL(command.value,document.baseURI);
          // Host ABI 1 delegates navigation/external intents to the browser,
          // while forbidding executable/local payload realms in the host.
          if (['javascript:','data:','blob:','about:','file:','vbscript:','filesystem:','chrome:','chrome-extension:','resource:','moz-extension:'].includes(url.protocol)) throw Error('E_WORKER_OPEN_SCHEME');
          window.open(url.href,'_blank','noopener,noreferrer'); break;
        }
        default: throw Error('E_WORKER_DOM_PRIVILEGED');
      }
      reply(command,result);
    } catch (error) { if(compensating)throw error;if(!closed)reply(command,undefined,error); }
  }
  function enqueuePrivileged(command:DomHostCommand):boolean{
    if(privilegedOperations.size>=32){reply(command,undefined,Error('E_WORKER_DOM_REQUEST_BUDGET'));return false;}
    let complete!:()=>void,fail!:(error:unknown)=>void;
    const operation=new Promise<void>((resolve,reject)=>{complete=resolve;fail=reject;});privilegedOperations.add(operation);
    void operation.then(()=>privilegedOperations.delete(operation),error=>{privilegedOperations.delete(operation);if(!closed)options.onError?.(error);});
    // Register ownership before calling APIs which can cause synchronous DOM
    // events. Call them in this task, without delaying user activation.
    void privileged(command).then(complete,fail);return true;
  }
  for (const type of ['keydown','keyup','mousedown','wheel','touchstart','touchmove','touchend','touchcancel','contextmenu','mouseover','mouseenter','mouseleave','pointerdown','pointercancel']) {
    on(canvas,type,event => {
      if ((type === 'wheel' || type === 'contextmenu') && !captured()) return;
      if (['keydown','mousedown','touchstart','pointerdown'].includes(type)) { canvas.focus(); gesture(event); }
      if (type === 'keydown' || type === 'keyup') rememberKey('canvas',event);
      if (type === 'mousedown') mouseButtons.set((event as MouseEvent).button ?? 0,serialize(event,'canvas'));
      if (type === 'pointerdown') pointerButtons.set((event as PointerEvent).pointerId ?? 0,serialize(event,'canvas'));
      if (type === 'pointercancel') releaseHeld();
      if (type === 'pointerdown') { try { canvas.setPointerCapture((event as PointerEvent).pointerId); } catch { /* Touch/mouse fallback still releases through window. */ } }
      forward('canvas',event);
      // Godot consumes the compatible mousedown/up stream. Cancelling the
      // primary pointerdown suppresses those browser-generated mouse events.
      const key=event as KeyboardEvent,pasteChord=type==='keydown'&&(key.ctrlKey||key.metaKey)&&(key.code==='KeyV'||key.key?.toLowerCase()==='v');
      if (!['mouseover','mouseenter','mouseleave','pointerdown'].includes(type)&&!pasteChord) event.preventDefault();
    });
  }
  for (const type of ['mousemove','mouseup','pointermove','pointerup']) on(window,type,event => {
    // Only a press which began on this canvas owns its matching release.
    // Focus/lock or an owned held sequence allows moves outside the canvas.
    if (type === 'mouseup') { const button=(event as MouseEvent).button ?? 0; if (!mouseButtons.delete(button)) return; }
    else if (type === 'pointerup') { const id=(event as PointerEvent).pointerId ?? 0; if (!pointerButtons.delete(id)) return; }
    else if (!captured()) return;
    forward('window',event);
    if (type === 'pointerup') { try { canvas.releasePointerCapture((event as PointerEvent).pointerId); } catch { /* Already released. */ } }
  });
  on(canvas,'focus',event => { sendState({focused:'canvas'}); forward('canvas',event); });
  on(canvas,'blur',event => { releaseHeld(); sendState({focused:null}); forward('canvas',event); });
  on(window,'blur',event => { releaseHeld(); forward('window',event); });
  on(window,'focus',event => { releaseHeld(); forward('window',event); });
  on(document,'visibilitychange',() => sendState({visible:document.visibilityState !== 'hidden'}));
  on(document,'pointerlockchange',() => sendState({pointerLocked:document.pointerLockElement === canvas}));
  on(document,'fullscreenchange',() => sendState({fullscreen:document.fullscreenElement === canvas}));
  on(canvas,'dragover',event=>{event.preventDefault();forward('canvas',event);});
  on(canvas,'drop',event=>{
    event.preventDefault();if(closed)return;
    if(dropBusy!==undefined){options.onError?.(Error('E_WORKER_DROP_BUSY'));return;}
    const transfer=(event as DragEvent).dataTransfer;if(!transfer){options.onError?.(Error('E_WORKER_DROP_DATA'));return;}
    const id=++dropSerial;dropBusy=id;
    void collectDrop(transfer,dropAborter.signal).then(entries=>{
      if(closed||dropAborter.signal.aborted||dropBusy!==id)return;
      if(!entries.length){dropBusy=undefined;options.onError?.(Error('E_WORKER_DROP_NO_FILES'));return;}
      forwardFields('canvas','drop',{drop:{dropId:id,entries}});
    },error=>{if(closed||dropAborter.signal.aborted)return;if(dropBusy===id)dropBusy=undefined;options.onError?.(error);});
  });
  on(window,'paste',event=>{
    if(!captured()&&!Array.from(elements.values()).includes(document.activeElement as HTMLElement))return;
    const text=(event as ClipboardEvent).clipboardData?.getData('text')??'';
    if(text.length>65536){options.onError?.(Error('E_WORKER_CLIPBOARD_BUDGET'));return;}
    forwardFields('window','paste',{clipboardText:text});
  });
  let lastGamepads = '';
  function sampleGamepads() {
    if (closed) return;
    try { const gamepads = Array.from(window.navigator.getGamepads?.() ?? []).slice(0,16).map(pad => pad ? {
      id:pad.id.slice(0,256), index:pad.index, mapping:pad.mapping, connected:pad.connected, timestamp:pad.timestamp,
      axes:Array.from(pad.axes).slice(0,32), buttons:Array.from(pad.buttons).slice(0,64).map(button => ({pressed:button.pressed,touched:button.touched,value:button.value})),
    } : null);
      const serialized = JSON.stringify(gamepads);
      if (serialized !== lastGamepads) { lastGamepads = serialized; sendState({gamepads}); }
    } catch { /* Gamepad policy denial is an empty sample. */ }
  }
  on(window,'gamepadconnected',event => { sampleGamepads(); forward('window',event); });
  on(window,'gamepaddisconnected',event => { sampleGamepads(); forward('window',event); });
  function speechState(event?: NonNullable<DomHostState['speech']>['event']) {
    const speech = window.speechSynthesis;
    sendState({speech:{available:!!speech,speaking:speech?.speaking ?? false,paused:speech?.paused ?? false,
      voices:speech?.getVoices().slice(0,256).map(voice => ({name:voice.name.slice(0,256),lang:voice.lang.slice(0,64),voiceURI:voice.voiceURI.slice(0,1024),localService:voice.localService,default:voice.default})) ?? [],event}});
  }
  if (window.speechSynthesis) on(window.speechSynthesis,'voiceschanged',() => speechState());
  speechState();
  const gamepadTimer = setInterval(sampleGamepads,16); sampleGamepads();
  sendState({visible:document.visibilityState !== 'hidden', focused:document.activeElement === canvas ? 'canvas' : null,
    pointerLocked:document.pointerLockElement === canvas, fullscreen:document.fullscreenElement === canvas,
    touchSupported:'ontouchstart' in window || window.navigator.maxTouchPoints > 0, fullscreenEnabled:document.fullscreenEnabled,
    clipboard:{write:typeof window.navigator.clipboard?.writeText==='function',read:typeof window.navigator.clipboard?.readText==='function'},
    screen:{width:window.screen.width,height:window.screen.height}});
  return {
    resize(next: CanvasGeometry): void { drawingBufferSize(next); if (next.epoch > geometry.epoch) { geometry = {...next};sendState({screen:{width:window.screen.width,height:window.screen.height}}); } },
    command(command: DomHostCommand): boolean {
      if (closed || command?.type !== 'dom-command' || typeof command.operation !== 'string') return false;
      const element = command.target === 'canvas' ? canvas : elements.get(command.target ?? '');
      try {
        switch (command.operation) {
          case 'host-service':return services.handleCommand(command.value as HostServiceCommand);
          case 'drop-release':{
            const value=command.value as {dropId?:number;error?:string};
            if(!value||!Number.isSafeInteger(value.dropId)||value.dropId!==dropBusy)return false;
            // A failed native batch poisons the credit until a new run; it may
            // still have asynchronous FileReader work touching native state.
            dropBusy=value.error?-1:undefined;if(value.error)options.onError?.(Error(String(value.error).slice(0,1024)));return true;
          }
          case 'create': {
            if (!command.target || !/^element-[1-9][0-9]{0,8}$/.test(command.target) || elements.has(command.target) || elements.size >= 16 || !['div','input','textarea','link','a'].includes(command.name ?? '')) throw Error('E_WORKER_DOM_ELEMENT');
            const node = document.createElement(command.name!); elements.set(command.target,node); const local: Array<() => void> = []; nodeListeners.set(node,local);
            for (const type of DOM_INPUT_EVENTS) if (['input','keydown','keyup','compositionstart','compositionupdate','compositionend','focus','blur'].includes(type)) on(node,type,event => {
              if (type === 'keydown') gesture(event);
              if (type === 'keydown' || type === 'keyup') rememberKey(command.target!,event);
              if (type === 'focus') { releaseHeld(); sendState({focused:command.target}); }
              if (type === 'blur') { releaseHeld(); sendState({focused:null}); }
              // Preserve GodotIME's original inline DOM timing. Clearing a
              // preedit via a later Worker command would cancel composition.
              const ime=node.tagName==='DIV'&&node.className==='ime';
              if(ime&&type==='compositionstart')node.innerHTML='';
              forward(command.target!,event);
              if(ime&&type==='compositionend')node.innerHTML='';
              if (type === 'keydown' || type === 'keyup') event.stopPropagation();
            },local);
            break;
          }
          case 'append': if (!element || element === canvas) throw Error('E_WORKER_DOM_TARGET'); if (element.tagName === 'LINK') document.head.appendChild(element); else canvas.parentElement?.appendChild(element); break;
          case 'remove': if (!element || element === canvas) throw Error('E_WORKER_DOM_TARGET'); nodeListeners.get(element)?.forEach(remove => remove()); nodeListeners.delete(element); element.remove(); elements.delete(command.target!); break;
          case 'style': if (!element || !styles.has(command.name!) || typeof command.value !== 'string' || command.value.length > 8192) throw Error('E_WORKER_DOM_STYLE'); (element.style as unknown as Record<string,string>)[command.name!] = command.value; break;
          case 'property': {
            if (!element || !properties.has(command.name!) || !['string','number','boolean'].includes(typeof command.value) || String(command.value).length > 65536) throw Error('E_WORKER_DOM_PROPERTY');
            if (command.name === 'innerHTML' && command.value !== '') throw Error('E_WORKER_DOM_HTML');
            if (element.tagName === 'LINK' && (command.name === 'rel' && command.value !== 'icon' || command.name === 'href' && !/^(blob:|data:image\/)/.test(String(command.value)))) throw Error('E_WORKER_DOM_LINK');
            if (element.tagName === 'A' && command.name === 'href') break; // Download supplies the Blob itself, never a worker URL.
            (element as unknown as Record<string,unknown>)[command.name === 'readonly' ? 'readOnly' : command.name!] = command.value; break;
          }
          case 'selection': if (!element || !['INPUT','TEXTAREA'].includes(element.tagName) || !Array.isArray(command.value) || command.value.length !== 2 || !command.value.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 65536)) throw Error('E_WORKER_DOM_SELECTION'); (element as HTMLInputElement).setSelectionRange(command.value[0],command.value[1]); break;
          case 'focus': if (!element) throw Error('E_WORKER_DOM_TARGET'); element.focus({preventScroll:true}); break;
          case 'blur': if (!element) throw Error('E_WORKER_DOM_TARGET'); element.blur(); break;
          case 'title': if (typeof command.value !== 'string' || command.value.length > 1024) throw Error('E_WORKER_DOM_TITLE'); document.title = command.value; break;
          case 'download': {
            const value = command.value as {blob?:Blob;filename?:string};
            if (!value || !(value.blob instanceof Blob) || value.blob.size + downloadBytes > 64*1024*1024 || typeof value.filename !== 'string' || value.filename.length > 1024 || downloads.size >= 8) throw Error('E_WORKER_DOWNLOAD_BUDGET');
            const url = window.URL.createObjectURL(value.blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = value.filename; anchor.style.display = 'none'; document.body.appendChild(anchor);
            try { anchor.click(); } finally { anchor.remove(); downloadBytes += value.blob.size; const size = value.blob.size; downloads.set(url,setTimeout(() => { window.URL.revokeObjectURL(url); downloads.delete(url); downloadBytes -= size; },60000)); }
            break;
          }
          case 'tts-speak': {
            const value = command.value as {id:number;text:string;rate:number;pitch:number;volume:number;voiceName?:string};
            if (!window.speechSynthesis || !value || !Number.isSafeInteger(value.id) || value.id <= 0 || utterances.has(value.id) || utterances.size >= 32 || typeof value.text !== 'string' || value.text.length > 65536 ||
              !Number.isFinite(value.rate) || value.rate < .1 || value.rate > 10 || !Number.isFinite(value.pitch) || value.pitch < 0 || value.pitch > 2 || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1) throw Error('E_WORKER_TTS_ARGUMENTS');
            const utterance = new window.SpeechSynthesisUtterance(value.text); utterance.rate=value.rate; utterance.pitch=value.pitch; utterance.volume=value.volume;
            utterance.voice = window.speechSynthesis.getVoices().find(voice => voice.name === value.voiceName) ?? null; utterances.set(value.id,utterance);
            for (const type of ['start','end','error','boundary'] as const) utterance.addEventListener(type,event => {
              if (closed) return; if (type === 'end' || type === 'error') utterances.delete(value.id);
              speechState({id:value.id,type,charIndex:(event as SpeechSynthesisEvent).charIndex ?? 0,...(type === 'error' ? {error:(event as SpeechSynthesisErrorEvent).error} : {})});
            });
            window.speechSynthesis.speak(utterance); speechState(); break;
          }
          case 'tts-pause': case 'tts-resume': case 'tts-cancel':
            if (!window.speechSynthesis) throw Error('E_WORKER_TTS_UNAVAILABLE');
            if (command.operation === 'tts-pause') window.speechSynthesis.pause(); else if (command.operation === 'tts-resume') window.speechSynthesis.resume(); else {
              window.speechSynthesis.cancel(); for (const id of utterances.keys()) speechState({id,type:'error',charIndex:0,error:'canceled'}); utterances.clear();
            } speechState(); break;
          case 'pointer-unlock':return enqueuePrivileged(command);
          case 'exit-fullscreen':return enqueuePrivileged(command);
          case 'pointer-lock': case 'fullscreen': case 'clipboard-read': case 'clipboard-write': case 'open':
            // A postMessage cannot extend activation. Reject now instead of
            // assigning an old request to a later, unrelated user gesture.
            if (['pointer-lock','fullscreen','open'].includes(command.operation) && !window.navigator.userActivation?.isActive) throw Error('E_WORKER_USER_ACTIVATION_REQUIRED');
            return enqueuePrivileged(command);
          default: return false;
        }
        return true;
      } catch (error) { reply(command,undefined,error); return false; }
    },
    dispose(): Promise<void> {
      if(disposePromise)return disposePromise;
      let complete!:()=>void,fail!:(error:unknown)=>void;disposePromise=new Promise<void>((resolve,reject)=>{complete=resolve;fail=reject;});void disposePromise.catch(()=>{});
      releaseHeld();
      dropAborter.abort(Error('E_WORKER_DROP_CLOSED'));
      closed = true; clearInterval(gamepadTimer); listeners.splice(0).forEach(remove => remove());
      const cleanup:Array<Promise<unknown>>=[...privilegedOperations];
      const attempt=(action:()=>unknown)=>{try{cleanup.push(Promise.resolve(action()));}catch(error){cleanup.push(Promise.reject(error));}};
      attempt(()=>services.dispose());
      for (const [url,timer] of downloads) { clearTimeout(timer);attempt(()=>window.URL.revokeObjectURL(url)); } downloads.clear();
      if (utterances.size)attempt(()=>window.speechSynthesis?.cancel()); utterances.clear();
      for (const [node, removers] of nodeListeners) { removers.forEach(remove => attempt(remove));attempt(()=>node.remove()); } nodeListeners.clear(); elements.clear();
      if (document.pointerLockElement === canvas)attempt(exitPointerLock);
      if (document.fullscreenElement === canvas)attempt(exitFullscreen);
      canvas.style.touchAction = previousTouchAction; canvas.tabIndex = previousTabIndex;
      void Promise.allSettled(cleanup).then(results=>{const rejected=results.find((r):r is PromiseRejectedResult=>r.status==='rejected');if(rejected)fail(rejected.reason);else complete();});
      return disposePromise;
    },
  };
}
