/** Explicit legacy NativePort adapter. Pure contracts and dispatch do not load this module. */
import type {NativeKey} from './contracts';
import {nativeKeyId} from './native-port';
import type {NodeReadHandle, NodeRef} from './runtime';
import {nativeInterfaceSchema, encodeNativeRpcArguments, snapshotNativeDTO, nativeInterfaceFailure as fail, nativeInterfaceDataObject as object, nativeInterfaceCodec as codec, type NativeInterfaceToken, type NativeInterfaceHandlers, type NativeRpcContext, type NativeCallback} from './native-interface-contracts';
import {nativeEndpointExists, nativeEndpointOwner, registerNativeEndpoint, unregisterNativeEndpoint} from './native-interface-dispatch';
export interface NativeInterfaceRegistryOptions {
  isAlive(key: NativeKey): boolean;
  enqueue(callback: () => void): void;
  onError?(error: unknown): void;
  send?(key: NativeKey, method: string, wireArguments: readonly unknown[], peerId?: number): number;
}
interface Target { identity:string;key:NativeKey;token:NativeInterfaceToken;handle?:NodeReadHandle;active:boolean;ready:boolean;readyDelivered:boolean;registration?:{handlers:NativeInterfaceHandlers;lease:object;ref?:NodeRef;handle?:NodeReadHandle}; }
interface RefRegistration {ref:NodeRef;token:NativeInterfaceToken;handlers:NativeInterfaceHandlers;active:boolean;target?:Target;cleanup?:()=>void}

export class NativeInterfaceRegistry {
  private active = true;
  private readonly targets = new Map<string, Target>();
  private readonly refs = new Set<RefRegistration>();
  private refRefreshScheduled = false;
  constructor(private readonly options: NativeInterfaceRegistryOptions) {}
  bind(identity: string, key: NativeKey, token: NativeInterfaceToken, handle?: NodeReadHandle): () => void {
    nativeInterfaceSchema(token);
    if (!this.active || !/^[1-9][0-9]{0,19}$/.test(identity) || nativeEndpointExists(identity) || this.targets.has(nativeKeyId(key))) fail("Invalid or repeated native interface binding");
    const target: Target = { identity, key: Object.freeze({...key}), token, handle, active:true, ready:false, readyDelivered:false };
    this.targets.set(nativeKeyId(key),target); registerNativeEndpoint(identity,target,(profile,hash,method,args,context)=>this.dispatch(target,profile,hash,method,args,context));
    if(!this.refRefreshScheduled){this.refRefreshScheduled=true;this.options.enqueue(()=>{this.refRefreshScheduled=false;if(this.active)for(const registration of this.refs)this.refreshRef(registration);});}
    return () => { if (this.targets.get(nativeKeyId(key)) === target) this.unbind(key); };
  }
  unbind(key: NativeKey): void {
    const target = this.targets.get(nativeKeyId(key)); if (!target) return;
    target.active=false; target.registration=undefined; this.targets.delete(nativeKeyId(key));
    unregisterNativeEndpoint(target.identity,target);
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
