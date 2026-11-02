import * as React from "react";
import type { NativeKey } from "./contracts";
import { nativeKeyId } from "./native-port";
import { HOST_SCHEMA } from "./schema";
import { useRuntime, type NodeReadHandle, type NodeRef } from "./runtime";

export type NativeCallback = "_ready" | "_process" | "_physics_process" | "_input" | "_unhandled_input";
export type NativeRpcCodec = "boolean" | "integer" | "number" | "string" | "networkId" | "dto";
export interface NativeRpcSchema {
  readonly arguments: readonly NativeRpcCodec[];
  readonly mode?: "authority" | "anyPeer";
  readonly sync?: "remote" | "local";
  readonly transferMode?: "reliable" | "unreliable" | "unreliableOrdered";
  readonly channel?: number;
}
export interface NativeInterfaceSchema {
  readonly version: 1;
  readonly nativeLeaf: string;
  readonly callbacks?: readonly NativeCallback[];
  readonly rpc?: Readonly<Record<string, NativeRpcSchema>>;
}
export interface NormalizedNativeInterfaceSchema {
  readonly version: 1;
  readonly nativeLeaf: string;
  readonly callbacks: readonly NativeCallback[];
  readonly rpc: Readonly<Record<string, Required<NativeRpcSchema>>>;
}
declare const tokenBrand: unique symbol;
/** Static construction token. It never contains a Node, constructor or handler. */
export interface NativeInterfaceToken {
  readonly profile: string;
  readonly nativeLeaf: string;
  readonly schemaHash: string;
  readonly [tokenBrand]: true;
}
export type NativeInterfaceHandlers = Readonly<Record<string, (...args: readonly any[]) => unknown>>;
export type SynchronousNativeHandlers<H extends NativeInterfaceHandlers> = {
  readonly [K in keyof H]: Extract<ReturnType<H[K]>, PromiseLike<unknown>> extends never ? H[K] : never;
};
export type NativeDTO = null | boolean | number | string | readonly NativeDTO[] | { readonly [key: string]: NativeDTO };
/** Captured while Godot is executing the RPC, before its sender context expires. */
export interface NativeRpcContext { readonly senderPeerId: number }
const callbacks = new Set<NativeCallback>(["_ready", "_process", "_physics_process", "_input", "_unhandled_input"]);
const codecs = new Set<NativeRpcCodec>(["boolean", "integer", "number", "string", "networkId", "dto"]);
const tokenSchemas = new WeakMap<object, NormalizedNativeInterfaceSchema>();
function fail(message: string): never { throw Object.assign(new TypeError(`E_NATIVE_INTERFACE: ${message}`), { code: "E_NATIVE_INTERFACE" }); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length) fail(`${label} must not have symbol properties`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) if (!('value' in descriptor) || !descriptor.enumerable) fail(`${label} must contain enumerable data properties`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown ${label} field ${key}`);
}
function dataArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== value.length + 1) fail(`${label} must be a dense data array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index=0;index<value.length;index++) if (!descriptors[String(index)] || !("value" in descriptors[String(index)])) fail(`${label} must not have accessors`);
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T, label: string): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(`Invalid ${label}`);
  return value as T;
}
/** Shared by the compiler and runtime. Dynamic schemas and native method overrides fail closed. */
export function validateNativeInterfaceSchema(input: unknown): NormalizedNativeInterfaceSchema {
  const schema = object(input, "schema");
  keys(schema, ["version", "nativeLeaf", "callbacks", "rpc"], "schema");
  if (schema.version !== 1) fail("Expected schema version 1");
  if (typeof schema.nativeLeaf !== "string" || !Object.hasOwn(HOST_SCHEMA, schema.nativeLeaf)) fail("nativeLeaf must be a certified host type");
  const incoming = dataArray(schema.callbacks ?? [], "callbacks");
  if (incoming.length > callbacks.size) fail("Invalid callbacks");
  const selected = new Set<NativeCallback>();
  for (const callback of incoming) {
    if (!callbacks.has(callback as NativeCallback) || selected.has(callback as NativeCallback)) fail("Invalid or repeated callback");
    selected.add(callback as NativeCallback);
  }
  const methods = object(schema.rpc ?? {}, "rpc"), rpc: Record<string, Required<NativeRpcSchema>> = Object.create(null);
  if (Object.keys(methods).length > 64) fail("At most 64 RPC methods are supported");
  for (const method of Object.keys(methods).sort()) {
    // Godot native methods use snake_case. A distinct namespace prevents overriding
    // inherited methods such as rpc_id, set_script, add_child and queue_free.
    if (!/^rpc[A-Z][A-Za-z0-9]{0,60}$/.test(method)) fail(`RPC method ${method} must use the rpcName namespace`);
    const spec = object(methods[method], method);
    keys(spec, ["arguments", "mode", "sync", "transferMode", "channel"], method);
    const arguments_ = dataArray(spec.arguments, `${method}.arguments`);
    if (arguments_.length > 16 || arguments_.some(value => !codecs.has(value as NativeRpcCodec))) fail(`Invalid argument codecs for ${method}`);
    const channel = spec.channel ?? 0;
    if (!Number.isInteger(channel) || (channel as number) < 0 || (channel as number) > 255) fail(`Invalid channel for ${method}`);
    rpc[method] = Object.freeze({ arguments: Object.freeze([...arguments_]) as readonly NativeRpcCodec[], mode: choice(spec.mode, ["authority", "anyPeer"], "authority", "mode"), sync: choice(spec.sync, ["remote", "local"], "remote", "sync"), transferMode: choice(spec.transferMode, ["reliable", "unreliable", "unreliableOrdered"], "reliable", "transferMode"), channel: channel as number });
  }
  return Object.freeze({ version: 1, nativeLeaf: schema.nativeLeaf as string, callbacks: Object.freeze([...selected].sort()), rpc: Object.freeze(rpc) });
}

// Portable SHA-256: Godot's JS runtime does not supply node:crypto or WebCrypto.
// Canonical schemas contain ASCII only; the same digest is used by the compiler.
function sha256(value: string): string {
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const bytes = Array.from(value, character => character.charCodeAt(0));
  const bitLength = bytes.length * 8; bytes.push(128); while (bytes.length % 64 !== 56) bytes.push(0);
  for (let shift = 56; shift >= 0; shift -= 8) bytes.push(shift >= 32 ? 0 : (bitLength >>> shift) & 255);
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64);
    for (let i = 0; i < 16; i++) words[i] = (bytes[offset+i*4] << 24) | (bytes[offset+i*4+1] << 16) | (bytes[offset+i*4+2] << 8) | bytes[offset+i*4+3];
    for (let i = 16; i < 64; i++) { const a = words[i-15], b = words[i-2]; words[i] = (words[i-16] + (rotate(a,7)^rotate(a,18)^(a>>>3)) + words[i-7] + (rotate(b,17)^rotate(b,19)^(b>>>10))) | 0; }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i++) { const first = (h + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + constants[i] + words[i]) | 0, second = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) | 0; h=g;g=f;f=e;e=(d+first)|0;d=c;c=b;b=a;a=(first+second)|0; }
    [a,b,c,d,e,f,g,h].forEach((word,index) => { hash[index] = (hash[index] + word) | 0; });
  }
  return hash.map(word => (word >>> 0).toString(16).padStart(8,"0")).join("");
}
export function nativeInterfaceSchemaHash(input: unknown): string { return sha256(JSON.stringify(validateNativeInterfaceSchema(input))); }
export function defineNativeInterface(profile: string, schema: NativeInterfaceSchema): NativeInterfaceToken {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(profile)) fail("Invalid static profile id");
  const normalized = validateNativeInterfaceSchema(schema);
  const token = Object.freeze({ profile, nativeLeaf: normalized.nativeLeaf, schemaHash: sha256(JSON.stringify(normalized)) }) as NativeInterfaceToken;
  tokenSchemas.set(token, normalized); return token;
}
export function nativeInterfaceSchema(token: NativeInterfaceToken): NormalizedNativeInterfaceSchema {
  const schema = token && tokenSchemas.get(token); if (!schema) fail("Untrusted nativeInterface token"); return schema;
}
export function normalizeNativeInterfaceProp(value: unknown, type: string): {scriptProfile:string;interfaceId:string;schemaHash:string} {
  const token = value as NativeInterfaceToken; nativeInterfaceSchema(token);
  if (token.nativeLeaf !== type) fail(`Interface leaf ${token.nativeLeaf} does not match host ${type}`);
  return { scriptProfile: token.profile, interfaceId: token.profile, schemaHash: token.schemaHash };
}
export function getNativeInterfaceToken(props: Readonly<Record<string, unknown>>): NativeInterfaceToken | undefined {
  if (props.nativeInterface === undefined) return undefined;
  nativeInterfaceSchema(props.nativeInterface as NativeInterfaceToken); return props.nativeInterface as NativeInterfaceToken;
}
export function normalizeNativeInterfaceProps<T extends Readonly<Record<string, unknown>>>(props: T, type: string): Readonly<Record<string, unknown>> {
  if (props.nativeInterface === undefined) return props;
  const profile = normalizeNativeInterfaceProp(props.nativeInterface, type);
  if (props.nativeScriptProfile !== undefined && props.nativeScriptProfile !== profile.scriptProfile) fail("Conflicting native script profile");
  const result: Record<string, unknown> = { ...props, nativeScriptProfile: profile.scriptProfile }; delete result.nativeInterface; return result;
}

/** Copies bounded, prototype-free application data. No native object or read handle crosses RPC. */
export function snapshotNativeDTO(value: unknown): NativeDTO {
  const ancestors = new Set<object>(); let count = 0, characters = 0;
  const copy = (item: unknown, depth: number): NativeDTO => {
    if (++count > 10000 || depth > 32) fail("DTO exceeds size or nesting limit");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") { if (!Number.isFinite(item)) fail("DTO numbers must be finite"); return item; }
    if (typeof item === "string") { characters+=item.length; if (item.length > 65536 || characters > 1048576) fail("DTO string budget exceeded"); return item; }
    if (typeof item !== "object") fail("DTO must contain JSON data only");
    if (ancestors.has(item as object)) fail("Cyclic DTO"); ancestors.add(item as object);
    try {
      if (Array.isArray(item)) {
        const array = dataArray(item,"DTO array");
        if (array.length > 10000) fail("DTO array too long");
        return Object.freeze(array.map(element => copy(element, depth+1)));
      }
      const data = object(item, "DTO"), result: Record<string, NativeDTO> = Object.create(null);
      for (const key of Object.keys(data)) { if (["__proto__", "constructor", "prototype"].includes(key) || key.length > 256) fail("Unsafe DTO key"); result[key] = copy(data[key], depth+1); }
      return Object.freeze(result);
    } finally { ancestors.delete(item as object); }
  };
  return copy(value, 0);
}
function codec(value: unknown, type: NativeRpcCodec, wire: boolean): unknown {
  switch (type) {
    case "boolean": if (typeof value !== "boolean") fail("Expected boolean"); return value;
    case "integer": if (!Number.isSafeInteger(value)) fail("Expected safe integer"); return value;
    case "number": if (typeof value !== "number" || !Number.isFinite(value)) fail("Expected finite number"); return value;
    case "string": if (typeof value !== "string" || value.length > 65536) fail("Expected bounded string"); return value;
    case "networkId": if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(value)) fail("Expected stable network ID"); return value;
    case "dto": if (!wire) return JSON.stringify(snapshotNativeDTO(value));
      if (typeof value !== "string" || value.length > 1048576) fail("Expected encoded DTO");
      try { return snapshotNativeDTO(JSON.parse(value)); } catch (error) { fail(`Invalid encoded DTO: ${String(error)}`); }
  }
}
export function encodeNativeRpcArguments(token: NativeInterfaceToken, method: string, args: readonly unknown[]): readonly unknown[] {
  const spec = nativeInterfaceSchema(token).rpc[method]; if (!spec || !Array.isArray(args) || args.length !== spec.arguments.length) fail("RPC method or argument count mismatch");
  const result = args.map((value,index) => codec(value,spec.arguments[index],false));
  if (JSON.stringify(result).length > 1048576) fail("RPC payload exceeds limit"); return Object.freeze(result);
}
export interface NativeInterfaceRegistryOptions {
  isAlive(key: NativeKey): boolean;
  enqueue(callback: () => void): void;
  onError?(error: unknown): void;
  send?(key: NativeKey, method: string, wireArguments: readonly unknown[], peerId?: number): number;
}
interface Target { identity:string;key:NativeKey;token:NativeInterfaceToken;handle?:NodeReadHandle;active:boolean;ready:boolean;readyDelivered:boolean;registration?:{handlers:NativeInterfaceHandlers;lease:object;ref?:NodeRef;handle?:NodeReadHandle}; }
interface RefRegistration {ref:NodeRef;token:NativeInterfaceToken;handlers:NativeInterfaceHandlers;active:boolean;target?:Target;cleanup?:()=>void}
const endpoints = new Map<string, {registry:NativeInterfaceRegistry;target:Target}>();
export class NativeInterfaceRegistry {
  private active = true;
  private readonly targets = new Map<string, Target>();
  private readonly refs = new Set<RefRegistration>();
  private refRefreshScheduled = false;
  constructor(private readonly options: NativeInterfaceRegistryOptions) {}
  bind(identity: string, key: NativeKey, token: NativeInterfaceToken, handle?: NodeReadHandle): () => void {
    nativeInterfaceSchema(token);
    if (!this.active || !/^[1-9][0-9]{0,19}$/.test(identity) || endpoints.has(identity) || this.targets.has(nativeKeyId(key))) fail("Invalid or repeated native interface binding");
    const target: Target = { identity, key: Object.freeze({...key}), token, handle, active:true, ready:false, readyDelivered:false };
    this.targets.set(nativeKeyId(key),target); endpoints.set(identity,{registry:this,target});
    if(!this.refRefreshScheduled){this.refRefreshScheduled=true;this.options.enqueue(()=>{this.refRefreshScheduled=false;if(this.active)for(const registration of this.refs)this.refreshRef(registration);});}
    return () => { if (this.targets.get(nativeKeyId(key)) === target) this.unbind(key); };
  }
  unbind(key: NativeKey): void {
    const target = this.targets.get(nativeKeyId(key)); if (!target) return;
    target.active=false; target.registration=undefined; this.targets.delete(nativeKeyId(key));
    if (endpoints.get(target.identity)?.target === target) endpoints.delete(target.identity);
  }
  commit(handle: NodeReadHandle | null, token: NativeInterfaceToken, handlers: NativeInterfaceHandlers): () => void {
    const committed=this.validateHandlers(token,handlers);
    if(!handle)return()=>{};
    const target = handle && this.targets.get(nativeKeyId(handle.nativeKey));
    if (!target || !this.active || !target.active || (target.handle && target.handle !== handle) || !this.options.isAlive(target.key)) fail("Handler target does not belong to the live root");
    if (target.token.profile !== token.profile || target.token.schemaHash !== token.schemaHash) fail("Handler schema does not match construction token");
    if (target.registration) fail("Only one native interface handler registration is allowed per host");
    const lease = {}; target.registration={handlers:committed,lease,handle};
    if (target.ready && !target.readyDelivered) this.enqueue(target,"_ready",[]);
    return () => { if (target.registration?.lease === lease) target.registration=undefined; };
  }
  /** A committed Hook can precede its host (conditional render or Suspense). */
  commitRef(ref:NodeRef, token:NativeInterfaceToken, handlers:NativeInterfaceHandlers):()=>void {
    if(!this.active)fail("Root lifetime has ended");
    if([...this.refs].some(registration=>registration.ref===ref))fail("Only one native interface registration is allowed per ref");
    const registration:RefRegistration={ref,token,handlers:this.validateHandlers(token,handlers),active:true};
    this.refs.add(registration);
    try{this.refreshRef(registration);}catch(error){this.refs.delete(registration);throw error;}
    return()=>{registration.active=false;registration.cleanup?.();this.refs.delete(registration);};
  }
  dispatch(target: Target, profile: string, schemaHash: string, method: string, args: readonly unknown[], context?: NativeRpcContext): boolean {
    if (!this.live(target) || target.token.profile !== profile || target.token.schemaHash !== schemaHash) return false;
    try {
      const schema = nativeInterfaceSchema(target.token); let copied: readonly unknown[];
      if (Object.hasOwn(schema.rpc,method)) {
        const spec=schema.rpc[method]; if (!Array.isArray(args) || args.length!==spec.arguments.length) fail("RPC argument count mismatch");
        const senderPeerId=context?.senderPeerId??0;
        if(!Number.isSafeInteger(senderPeerId)||senderPeerId<0||senderPeerId>2147483647)fail("Invalid RPC sender context");
        copied=Object.freeze([...args.map((value,index)=>codec(value,spec.arguments[index],true)),Object.freeze({senderPeerId})]);
      } else {
        if (!schema.callbacks.includes(method as NativeCallback)) fail("Undeclared native callback");
        if (method==="_ready") { if(args.length)fail("_ready takes no arguments"); if(target.ready)return true;target.ready=true;copied=[]; }
        else if (method==="_process"||method==="_physics_process") { if(args.length!==1||typeof args[0]!=="number"||!Number.isFinite(args[0])||args[0]<0)fail("Invalid frame delta");copied=Object.freeze([args[0]]); }
        else { if(args.length!==1)fail("Input callback takes one DTO");copied=Object.freeze([snapshotNativeDTO(args[0])]); }
      }
      if(target.registration)this.enqueue(target,method,copied); return true;
    } catch(error) { this.options.onError?.(error); return false; }
  }
  send(handle: NodeReadHandle | null, token: NativeInterfaceToken, method: string, args: readonly unknown[], peerId?: number): Readonly<{localError:number}> {
    const wire = encodeNativeRpcArguments(token,method,args), target = handle && this.targets.get(nativeKeyId(handle.nativeKey));
    if (!target || !this.live(target) || (target.handle && target.handle!==handle) || target.token.profile!==token.profile || target.token.schemaHash!==token.schemaHash) fail("RPC target is no longer live");
    if (peerId!==undefined && (!Number.isSafeInteger(peerId)||peerId<=0||peerId>2147483647)) fail("Invalid peer ID");
    if (!this.options.send) fail("RPC transport is unavailable");
    const localError=this.options.send(target.key,method,wire,peerId); if(!Number.isInteger(localError))fail("Invalid RPC local status");
    return Object.freeze({localError});
  }
  dispose(): void { if(!this.active)return;this.active=false;for(const registration of this.refs){registration.active=false;registration.cleanup?.();}this.refs.clear();for(const target of [...this.targets.values()])this.unbind(target.key); }
  private validateHandlers(token:NativeInterfaceToken,handlers:NativeInterfaceHandlers):NativeInterfaceHandlers {
    const schema=nativeInterfaceSchema(token),data=object(handlers,"handlers");
    for(const[name,callback]of Object.entries(data))if(typeof callback!=="function"||(!schema.callbacks.includes(name as NativeCallback)&&!Object.hasOwn(schema.rpc,name)))fail(`Undeclared handler ${name}`);
    return Object.freeze({...handlers});
  }
  private refreshRef(registration:RefRegistration):void {
    if(!registration.active||!this.active)return;
    const handle=registration.ref.current,target=handle?this.targets.get(nativeKeyId(handle.nativeKey)):undefined;
    if(target===registration.target&&(!handle||target))return;
    registration.cleanup?.();registration.cleanup=undefined;registration.target=undefined;
    if(!handle)return;
    if(!target)fail("Handler ref belongs to another root or an expired host");
    registration.cleanup=this.commit(handle,registration.token,registration.handlers);registration.target=target;
    target.registration!.ref=registration.ref;
  }
  private live(target:Target):boolean { return this.active&&target.active&&this.targets.get(nativeKeyId(target.key))===target&&this.options.isAlive(target.key); }
  private enqueue(target:Target, method:string, args:readonly unknown[]):void {
    this.options.enqueue(()=>{
      if(!this.live(target)||(method==="_ready"&&target.readyDelivered))return;
      const registration=target.registration;
      if(registration?.ref&&registration.ref.current!==registration.handle)return;
      const callback=registration?.handlers[method];if(!callback)return;
      if(method==="_ready")target.readyDelivered=true;
      try {
        const result=callback(...args);
        if(result&&typeof(result as any).then==="function") {
          // Revoke the endpoint lease before reporting. An async continuation
          // cannot retain a live RPC sender or deliver already queued callbacks.
          this.unbind(target.key);
          Promise.resolve(result).catch(error=>this.options.onError?.(error));
          fail("Native handlers must be synchronous; endpoint lease revoked");
        }
      } catch(error) { this.options.onError?.(error); }
    });
  }
}
/** Generated NativeScript-only entry point; no native object is retained or exposed. */
export function dispatchNativeInterface(identity: unknown, profile: string, schemaHash: string, method: string, args: readonly unknown[], context?: NativeRpcContext): boolean {
  if(typeof identity!=="string")return false;
  const endpoint=endpoints.get(identity);return endpoint?.registry.dispatch(endpoint.target,profile,schemaHash,method,args,context)??false;
}
/** The host must already carry nativeInterface={token}; this Hook never changes its script. */
export function useNativeInterface<K extends string,H extends NativeInterfaceHandlers>(ref:NodeRef<K>, token:NativeInterfaceToken, handlers:H & SynchronousNativeHandlers<H>):Readonly<{send(method:string,args:readonly unknown[],options?:{peerId?:number}):Readonly<{localError:number}>}> {
  const root=useRuntime() as ReturnType<typeof useRuntime> & {nativeInterfaces:NativeInterfaceRegistry};
  nativeInterfaceSchema(token);
  React.useLayoutEffect(()=>root.nativeInterfaces.commitRef(ref as NodeRef,token,handlers));
  return React.useMemo(()=>Object.freeze({send:(method:string,args:readonly unknown[],options?:{peerId?:number})=>root.nativeInterfaces.send(ref.current,token,method,args,options?.peerId)}),[root,ref,token]);
}
