import { drawingBufferSize, type CanvasGeometry } from './worker-presentation.js';
import { createDropTransfer, type DropPayload } from './worker-drop.js';
import { createWorkerHostServicesClient, type HostServiceState } from './worker-host-services.js';
import type { BenchmarkInputTiming } from './worker-benchmark.js';

export interface DomInputPacket {
  type: 'dom-input'; sequence: number; target: string; event: string;
  fields: Record<string, unknown>; geometry?: CanvasGeometry;
  timing?: BenchmarkInputTiming;
}
export interface DomHostCommand {
  type: 'dom-command'; operation: string; target?: string; name?: string;
  value?: unknown; requestId?: number;
}
export interface DomHostState {
  type: 'dom-state'; visible?: boolean; focused?: string | null;
  pointerLocked?: boolean; fullscreen?: boolean; gamepads?: unknown[];
  touchSupported?: boolean; fullscreenEnabled?: boolean; screen?: {width:number;height:number};
  services?:HostServiceState;
  clipboard?:{write:boolean;read:boolean};
  requestId?: number; result?: unknown; error?: string;
  speech?: { available: boolean; speaking: boolean; paused: boolean; voices: Array<{name:string;lang:string;voiceURI:string;localService:boolean;default:boolean}>;
    event?: { id:number; type:'start'|'end'|'error'|'boundary'; charIndex:number; error?:string } };
}
export interface WorkerDomOptions {
  canvas: OffscreenCanvas; geometry: CanvasGeometry;
  sendHostCommand(command: DomHostCommand): void;
  onError?(error:unknown):void;
  scope?: Record<string, any>; requestTimeoutMs?: number;
  /** HTTP document URL supplied by the owning Window, never the Blob URL. */
  baseUrl?: string;
}
const allowedEvents = new Set(['keydown','keyup','mousedown','mouseup','mousemove','wheel','touchstart','touchmove','touchend','touchcancel',
  'pointerdown','pointerup','pointermove','pointercancel','mouseover','mouseenter','mouseleave','focus','blur','compositionstart','compositionupdate','compositionend','input','contextmenu',
  'visibilitychange','pointerlockchange','fullscreenchange','gamepadconnected','gamepaddisconnected','dragover','drop','paste']);
const properties = new Set(['id','className','contentEditable','value','type','inputmode','readOnly','readonly','disabled','selectionStart','selectionEnd','rel','href','download','tabIndex','textContent','innerHTML']);
const styles = new Set(['background','opacity','position','textAlign','fontSize','left','top','width','height','pointerEvents','display','padding','margin','overflow','border','outline','cursor','touchAction','zIndex']);
export const DOM_ELEMENT_PROPERTIES = Object.freeze([...properties]);
export const DOM_STYLE_PROPERTIES = Object.freeze([...styles]);
export const DOM_INPUT_EVENTS = Object.freeze([...allowedEvents]);

/** Minimal explicit DOM ABI used by Godot's Web backend. Native canvas event
 * methods remain untouched, including context loss events delivered by WebGL. */
export function createWorkerDom(options: WorkerDomOptions) {
  const scope = options.scope ?? globalThis as unknown as Record<string, any>;
  let geometry = { ...options.geometry }; drawingBufferSize(geometry);
  let closed = false, inputRevoked = false, sequence = -1, elementSerial = 0, requestSerial = 0;
  const elements = new Map<string, EventTarget & Record<string, any>>();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  const objectUrls = new Map<string, Blob>();
  let objectUrlBytes = 0;
  const OriginalURL = scope.URL ?? URL;
  const base = options.baseUrl === undefined ? undefined : new OriginalURL(options.baseUrl);
  if (base && (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)) throw Error('E_WORKER_DOM_BASE_URL');
  const logicalLocation = base ? Object.freeze({ href:base.href, origin:base.origin, protocol:base.protocol,
    host:base.host, hostname:base.hostname, port:base.port, pathname:base.pathname, search:base.search, hash:base.hash,
    toString:() => base.href }) : scope.location;
  class WorkerURL extends OriginalURL {
    static createObjectURL(blob: Blob): string {
      if (!(blob instanceof Blob) || objectUrlBytes + blob.size > 64 * 1024 * 1024 || objectUrls.size >= 64) throw Error('E_WORKER_BLOB_BUDGET');
      const url = OriginalURL.createObjectURL(blob); objectUrls.set(url,blob); objectUrlBytes += blob.size; return url;
    }
    static revokeObjectURL(url: string): void { objectUrlBytes -= objectUrls.get(url)?.size ?? 0; objectUrls.delete(url); OriginalURL.revokeObjectURL(url); }
  }
  const canvas = options.canvas as OffscreenCanvas & Record<string, any>;
  const document = new EventTarget() as EventTarget & Record<string, any>;
  const windowTarget = new EventTarget() as EventTarget & Record<string, any>;
  const unsupportedWindow = new Set(['parent','top','frames','opener','frameElement','history','localStorage','sessionStorage','getComputedStyle','getSelection','confirm','prompt','postMessage','close','scroll','scrollTo','scrollBy','focus','blur','print']);
  const brandedFunctions = new Set(['fetch','atob','btoa','queueMicrotask','createImageBitmap','importScripts','requestAnimationFrame','cancelAnimationFrame','setTimeout','clearTimeout','setInterval','clearInterval','postMessage','close']);
  const bound = new Map<PropertyKey,{original:Function;value:Function}>();
  const window = new Proxy(windowTarget,{
    get(target,key){
      if(typeof key==='string'&&unsupportedWindow.has(key))throw Error(`E_WORKER_UNSUPPORTED_DOM_INTERFACE: ${key}`);
      if(Reflect.has(target,key)){
        const value=Reflect.get(target,key,target);
        if(typeof value==='function'&&['addEventListener','removeEventListener','dispatchEvent'].includes(String(key))){
          const cached=bound.get(key);if(cached&&cached.original===value)return cached.value;const method=value.bind(target);bound.set(key,{original:value,value:method});return method;
        }return value;
      }
      const value=Reflect.get(scope,key,scope);
      if(typeof value==='function'&&brandedFunctions.has(String(key))){const cached=bound.get(key);if(cached&&cached.original===value)return cached.value;const method=value.bind(scope);bound.set(key,{original:value,value:method});return method;}
      // Constructors/JSON retain exact identity and static members.
      return value;
    },
    has:(target,key)=>Reflect.has(target,key)||(!unsupportedWindow.has(String(key))&&Reflect.has(scope,key)),
  });
  const original = new Map<string, PropertyDescriptor | undefined>();
  if (base && typeof scope.fetch === 'function') {
    const nativeFetch = scope.fetch;
    original.set('fetch', Object.getOwnPropertyDescriptor(scope, 'fetch'));
    Object.defineProperty(scope, 'fetch', { configurable:true, writable:true, value:async (input: RequestInfo | URL, init?: RequestInit) => {
      const resolved = typeof input === 'string' || input instanceof OriginalURL ? new OriginalURL(String(input), base.href).href : input;
      return Reflect.apply(nativeFetch, scope, [resolved, init]);
    } });
  }
  const canvasOriginal = new Map<string, PropertyDescriptor | undefined>();
  let activeDrop:number|undefined,dropTimer:ReturnType<typeof setTimeout>|undefined;
  let dispatchingInput:{target:string;event:string}|undefined;
  function send(operation: string, target?: string, name?: string, value?: unknown, requestId?: number): void {
    if (!closed&&!inputRevoked) options.sendHostCommand({ type: 'dom-command', operation, target, name, value, requestId });
  }
  function request(operation: string, value?: unknown): Promise<unknown> {
    if (closed||inputRevoked) return Promise.reject(Error('E_WORKER_DOM_CLOSED'));
    if (pending.size >= 32) return Promise.reject(Error('E_WORKER_DOM_REQUEST_BUDGET'));
    const id = ++requestSerial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('E_WORKER_DOM_REQUEST_TIMEOUT')); }, options.requestTimeoutMs ?? 5000);
      pending.set(id, { resolve, reject, timer });
      try { send(operation, undefined, undefined, value, id); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  function rect() {
    const left = geometry.left ?? 0, top = geometry.top ?? 0;
    return { x: left, y: top, left, top, width: geometry.width, height: geometry.height,
      right: left + geometry.width, bottom: top + geometry.height, toJSON() { return { left, top, width: geometry.width, height: geometry.height }; } };
  }
  function defineCanvas(key: string, value: unknown) {
    canvasOriginal.set(key, Object.getOwnPropertyDescriptor(canvas, key));
    Object.defineProperty(canvas, key, { configurable: true, writable: true, value });
  }
  function mirror(target: EventTarget & Record<string, any>, key: string) {
    const values: Record<string, unknown> = {};
    target.style = new Proxy(values, { set(object, name, value) {
      if (typeof name !== 'string' || !styles.has(name)) throw Error(`E_WORKER_DOM_STYLE: ${String(name)}`);
      object[name] = value; send('style', key, name, String(value)); return true;
    } });
    for (const property of properties) {
      Object.defineProperty(target, property, { configurable: true, get: () => values[`@${property}`] ?? (property === 'value' ? '' : undefined), set(value) {
        if (property === 'innerHTML' && value !== '') throw Error('E_WORKER_DOM_HTML');
        values[`@${property}`] = value;
        // The real host performs Godot's IME start/end clear synchronously in
        // its DOM event handler. Replaying this native-handler write later can
        // cancel a browser preedit which was inserted after compositionstart.
        if(property==='innerHTML'&&value===''&&values['@className']==='ime'&&dispatchingInput?.target===key&&
          (dispatchingInput.event==='compositionstart'||dispatchingInput.event==='compositionend'))return;
        send('property', key, property, value);
      } });
    }
    target.focus = () => send('focus', key); target.blur = () => send('blur', key);
    target.remove = () => { send('remove', key); elements.delete(key); };
    target.setSelectionRange = (start: number, end: number) => { target.selectionStart = start; target.selectionEnd = end; send('selection', key, undefined, [start, end]); };
    // Apply values received from the host without echoing setters back to it.
    target.__hostFields = (fields: Record<string, unknown>) => { for (const property of ['value','selectionStart','selectionEnd']) if (property in fields) values[`@${property}`] = fields[property]; };
  }
  function createElement(tag: string): any {
    tag = tag.toLowerCase();
    if (tag === 'canvas') return new scope.OffscreenCanvas(1, 1);
    if (!['div','input','textarea','link','a'].includes(tag) || elements.size >= 16) throw Error(`E_WORKER_DOM_ELEMENT: ${tag}`);
    const key = `element-${++elementSerial}`, element = new EventTarget() as EventTarget & Record<string, any>;
    elements.set(key, element); mirror(element, key); element.__domKey = key;
    if (tag === 'a') element.click = () => {
      const blob = objectUrls.get(element.href); if (!blob) throw Error('E_WORKER_DOWNLOAD_BLOB');
      // Blob is cloned with the message before native code revokes its URL.
      send('download', key, undefined, { blob, filename:String(element.download ?? 'download') });
    };
    send('create', key, tag); return element;
  }
  const parent = { appendChild(element: Record<string, any>) { send('append', element.__domKey); return element; }, removeChild(element: Record<string, any>) { element.remove(); return element; } };
  defineCanvas('id', 'canvas'); defineCanvas('tabIndex', 0); defineCanvas('parentElement', parent);
  defineCanvas('getBoundingClientRect', rect); defineCanvas('focus', () => send('focus','canvas')); defineCanvas('blur', () => send('blur','canvas'));
  defineCanvas('requestPointerLock', () => send('pointer-lock')); defineCanvas('requestFullscreen', () => request('fullscreen'));
  defineCanvas('insertAdjacentElement', (_position: string, element: Record<string, any>) => { send('append', element.__domKey); return element; });
  defineCanvas('style', new Proxy<Record<string, unknown>>({}, { set(object, name, value) { if (typeof name !== 'string' || !styles.has(name)) throw Error('E_WORKER_DOM_STYLE'); object[name] = value; send('style','canvas',name,String(value)); return true; } }));
  Object.assign(document, { createElement, activeElement: null, pointerLockElement: null, fullscreenElement: null, fullscreenEnabled: false,
    hidden: false, visibilityState: 'visible', body: parent, head: parent, documentElement: { clientWidth: geometry.width, clientHeight: geometry.height },
    getElementById: (id: string) => id === 'canvas' ? canvas : [...elements.values()].find(element => element.id === id) ?? null,
    querySelector: (selector: string) => selector === 'canvas' || selector === '#canvas' ? canvas : null,
    getElementsByTagName: (tag: string) => tag === 'canvas' ? [canvas] : [],
    exitPointerLock: () => send('pointer-unlock'), exitFullscreen: () => request('exit-fullscreen') });
  if (base) Object.defineProperty(document, 'baseURI', { value:base.href, enumerable:true });
  let title = '';
  Object.defineProperty(document, 'title', { get: () => title, set: value => { title = String(value); send('title',undefined,undefined,title); } });
  let gamepads: unknown[] = [];
  const nativeNavigator=scope.navigator??{},navigatorFunctions=new Map<Function,Function>();
  const navigator = new Proxy<Record<string,unknown>>({}, {
    get(target,key){if(Object.hasOwn(target,key))return Reflect.get(target,key,target);const value=Reflect.get(nativeNavigator,key,nativeNavigator);
      if(typeof value!=='function'||key==='constructor')return value;let method=navigatorFunctions.get(value);if(!method){method=value.bind(nativeNavigator);navigatorFunctions.set(value,method!);}return method;},
    has:(target,key)=>Reflect.has(target,key)||Reflect.has(nativeNavigator,key),
  });
  const clipboardMethods={writeText:(text:string)=>request('clipboard-write',String(text)),readText:()=>request('clipboard-read')};
  Object.defineProperties(navigator, { getGamepads: { value: () => gamepads }, clipboard: { configurable:true,writable:true,value:undefined } });
  const services=createWorkerHostServicesClient({navigator,sendCommand:command=>send('host-service',undefined,undefined,command),onError:error=>{
    if(options.onError)options.onError(error);else(scope.console??console).error(error);
  }});
  let speechSerial = 0, speechState: DomHostState['speech'];
  const utterances = new Map<number, WorkerUtterance>();
  class WorkerUtterance extends EventTarget {
    text: string; rate = 1; pitch = 1; volume = 1; voice: {name:string}|null = null;
    constructor(text = '') { super(); this.text = String(text); }
  }
  const speechSynthesis = {
    get speaking() { return speechState?.speaking ?? false; }, get paused() { return speechState?.paused ?? false; },
    getVoices: () => speechState?.voices.map(voice => ({...voice})) ?? [],
    speak(utterance: WorkerUtterance) {
      if (!(utterance instanceof WorkerUtterance) || utterances.size >= 32 || utterance.text.length > 65536) throw Error('E_WORKER_TTS_BUDGET');
      const id = ++speechSerial; utterances.set(id,utterance);
      send('tts-speak',undefined,undefined,{id,text:utterance.text,rate:utterance.rate,pitch:utterance.pitch,volume:utterance.volume,voiceName:utterance.voice?.name});
    },
    pause: () => send('tts-pause'), resume: () => send('tts-resume'), cancel: () => send('tts-cancel'),
  };
  Object.assign(window, { window, self: window, document, navigator, screen: { width: geometry.width, height: geometry.height },
    devicePixelRatio: geometry.dpr, innerWidth: geometry.width, innerHeight: geometry.height,
    location: logicalLocation, URL: WorkerURL, open: (url: string) => { send('open',undefined,undefined,String(url)); return null; },
    alert: () => { throw Error('E_WORKER_UNSUPPORTED_SYNCHRONOUS_ALERT'); },
    setTimeout: scope.setTimeout?.bind(scope) ?? setTimeout, clearTimeout: scope.clearTimeout?.bind(scope) ?? clearTimeout,
    setInterval: scope.setInterval?.bind(scope) ?? setInterval, clearInterval: scope.clearInterval?.bind(scope) ?? clearInterval });
  for (const [key, value] of Object.entries({ window, document, navigator, screen:window.screen, alert:window.alert, URL:WorkerURL, SpeechSynthesisUtterance:WorkerUtterance, HTMLCanvasElement: scope.OffscreenCanvas })) {
    original.set(key, Object.getOwnPropertyDescriptor(scope, key)); Object.defineProperty(scope, key, { configurable: true, writable: true, value });
  }
  function dispatch(target: EventTarget & Record<string, any>, type: string, fields: Record<string, unknown>) {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries(fields)) if (!['type','target','currentTarget','isTrusted','__proto__','constructor','prototype'].includes(key)) {
      Object.defineProperty(event, key, { value, enumerable: true });
    }
    target.dispatchEvent(event);
    const handler = target[`on${type}`]; if (typeof handler === 'function') handler.call(target, event);
  }
  function dispatchFullscreenChange(): void {
    // A real fullscreenchange originates at the fullscreen element, then
    // bubbles to document. OffscreenCanvas has no DOM parent, so bridge that
    // trusted path explicitly without accepting a target from input fields.
    const event = new Event('fullscreenchange', { bubbles: true });
    Object.defineProperty(event, 'target', { value: canvas });
    let stopped = false, immediate = false, phase = 0, currentTarget: EventTarget | null = null;
    const stop = event.stopPropagation.bind(event), stopImmediate = event.stopImmediatePropagation.bind(event);
    Object.defineProperties(event, {
      eventPhase: { get: () => phase },
      currentTarget: { get: () => currentTarget },
      stopPropagation: { value: () => { stopped = true; stop(); } },
      stopImmediatePropagation: { value: () => { stopped = true; immediate = true; stopImmediate(); } },
    });
    try {
      for (const target of [canvas, document]) {
        currentTarget = target; phase = target === canvas ? Event.AT_TARGET : Event.BUBBLING_PHASE;
        target.dispatchEvent(event);
        const handler = target.onfullscreenchange;
        if (!immediate && typeof handler === 'function') handler.call(target, event);
        if (stopped || event.cancelBubble) break;
      }
    } finally { currentTarget = null; phase = 0; }
  }
  function revokeInput():void {
    if(inputRevoked)return;inputRevoked=true;clearTimeout(dropTimer);activeDrop=undefined;services.dispose();utterances.clear();
    for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('E_WORKER_DOM_CLOSED'));}pending.clear();
  }
  return {
    window, document, revokeInput,
    resize(next: CanvasGeometry): void {
      drawingBufferSize(next); if (next.epoch <= geometry.epoch) return; geometry = { ...next };
      Object.assign(window, { innerWidth: next.width, innerHeight: next.height, devicePixelRatio: next.dpr });
      Object.assign(document.documentElement, { clientWidth: next.width, clientHeight: next.height });
    },
    dispatchInput(packet: DomInputPacket): boolean {
      if (closed || inputRevoked || packet.type !== 'dom-input' || !Number.isSafeInteger(packet.sequence) || packet.sequence <= sequence || !allowedEvents.has(packet.event)) return false;
      const target = packet.target === 'canvas' ? canvas : packet.target === 'window' ? window : packet.target === 'document' ? document : elements.get(packet.target);
      if (!target || !packet.fields || typeof packet.fields !== 'object') return false;
      sequence = packet.sequence;
      const fields = { ...packet.fields };
      if(packet.event==='paste'){
        const text=typeof fields.clipboardText==='string'?fields.clipboardText:'';
        fields.clipboardData={getData:(format:string)=>format==='text'||format==='text/plain'?text:''};
      }
      if(packet.event==='drop'){
        const payload=fields.drop as DropPayload;
        if(!payload||!Number.isSafeInteger(payload.dropId)||payload.dropId<=0||activeDrop!==undefined)throw Error('E_WORKER_DROP_CREDIT');
        const id=payload.dropId,isActive=()=>!closed&&!inputRevoked&&activeDrop===id,transfer=createDropTransfer(payload.entries,isActive);activeDrop=id;
        let completed=false;
        const complete=(error?:unknown)=>{if(completed)return;completed=true;clearTimeout(dropTimer);dropTimer=undefined;if(closed||activeDrop!==id)return;activeDrop=undefined;
          send('drop-release',undefined,undefined,{dropId:id,...(error?{error:error instanceof Error?error.message.slice(0,1024):String(error).slice(0,1024)}:{})});};
        fields.dataTransfer=transfer;fields.godotDropComplete=complete;fields.godotDropIsActive=isActive;
        dropTimer=setTimeout(()=>complete(Error('E_WORKER_DROP_PROCESS_TIMEOUT')),15000);
        delete fields.drop;
      }
      // Host sends normalized coordinates, so releases survive a resize epoch.
      function mapPoint(point: any) { const result = { ...point }; if (Number.isFinite(point.normalizedX) && Number.isFinite(point.normalizedY)) {
        result.clientX = (geometry.left ?? 0) + point.normalizedX * geometry.width; result.clientY = (geometry.top ?? 0) + point.normalizedY * geometry.height;
      } return result; }
      Object.assign(fields, mapPoint(fields));
      for (const key of ['touches','changedTouches','targetTouches']) if (Array.isArray(fields[key])) fields[key] = (fields[key] as unknown[]).slice(0, 32).map(mapPoint);
      target.__hostFields?.(fields);const previous=dispatchingInput;dispatchingInput={target:packet.target,event:packet.event};
      try{dispatch(target, packet.event, fields);}finally{dispatchingInput=previous;}return true;
    },
    applyHostState(state: DomHostState): void {
      if (closed || inputRevoked || state.type !== 'dom-state') return;
      if(state.services)services.applyState(state.services);
      if(state.clipboard)navigator.clipboard=state.clipboard.write||state.clipboard.read?{
        ...(state.clipboard.write?{writeText:clipboardMethods.writeText}:{}),...(state.clipboard.read?{readText:clipboardMethods.readText}:{})}:undefined;
      if (state.requestId !== undefined) { const entry = pending.get(state.requestId); if (entry) { clearTimeout(entry.timer); pending.delete(state.requestId); if (state.error) entry.reject(Error(state.error)); else entry.resolve(state.result); } }
      if (state.gamepads) gamepads = state.gamepads.slice(0, 16);
      if (state.touchSupported !== undefined) { if (state.touchSupported) window.ontouchstart = null; else delete window.ontouchstart; }
      if (state.fullscreenEnabled !== undefined) document.fullscreenEnabled = state.fullscreenEnabled;
      if (state.screen && Number.isFinite(state.screen.width) && Number.isFinite(state.screen.height)) Object.assign(window.screen,state.screen);
      if (state.speech) {
        speechState = state.speech;
        if (state.speech.available) window.speechSynthesis = speechSynthesis; else delete window.speechSynthesis;
        const update = state.speech.event;
        if (update) { const utterance = utterances.get(update.id); if (utterance) {
          dispatch(utterance,update.type,{charIndex:update.charIndex,error:update.error});
          if (update.type === 'end' || update.type === 'error') utterances.delete(update.id);
        } }
      }
      if (state.focused !== undefined) document.activeElement = state.focused === 'canvas' ? canvas : elements.get(state.focused ?? '') ?? null;
      if (state.visible !== undefined) { document.hidden = !state.visible; document.visibilityState = state.visible ? 'visible' : 'hidden'; dispatch(document,'visibilitychange',{}); }
      if (state.pointerLocked !== undefined) { document.pointerLockElement = state.pointerLocked ? canvas : null; dispatch(document,'pointerlockchange',{}); }
      if (state.fullscreen !== undefined) { document.fullscreenElement = state.fullscreen ? canvas : null; dispatchFullscreenChange(); }
    },
    dispose(): void {
      if (closed) return; revokeInput();closed = true;elements.clear();
      for (const url of objectUrls.keys()) OriginalURL.revokeObjectURL(url); objectUrls.clear();
      for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(scope,key,descriptor); else delete scope[key]; }
      for (const [key, descriptor] of canvasOriginal) { if (descriptor) Object.defineProperty(canvas,key,descriptor); else delete canvas[key]; }
    },
  };
}
