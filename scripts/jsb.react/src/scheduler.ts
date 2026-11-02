/** Scheduler 0.28 algorithm with private host ingress. */
import * as Host from './internal/scheduler-host';
import * as Official from './internal/scheduler-official';
const core=Official as unknown as Record<string, any>;
export const unstable_ImmediatePriority=1,unstable_UserBlockingPriority=2,unstable_NormalPriority=3,unstable_LowPriority=4,unstable_IdlePriority=5,unstable_Profiling=null;
export const unstable_now:()=>number=core.unstable_now;
export const unstable_scheduleCallback:(priority:number,callback:(timeout:boolean)=>unknown,options?:{delay?:number})=>unknown=core.unstable_scheduleCallback;
export const unstable_cancelCallback:(task:unknown)=>void=core.unstable_cancelCallback;
export const unstable_shouldYield:()=>boolean=core.unstable_shouldYield;
export const unstable_getCurrentPriorityLevel:()=>number=core.unstable_getCurrentPriorityLevel;
export const unstable_runWithPriority:<T>(priority:number,fn:()=>T)=>T=core.unstable_runWithPriority;
export const unstable_next:<T>(fn:()=>T)=>T=core.unstable_next;
export const unstable_wrapCallback:<T extends (...args:any[])=>any>(fn:T)=>T=core.unstable_wrapCallback;
export const unstable_requestPaint:()=>void=core.unstable_requestPaint;
export const unstable_forceFrameRate:(fps:number)=>void=core.unstable_forceFrameRate;
export function configureScheduler(options:{now?:()=>number;requestPump?:()=>void}):void{Host.configure(options);}
export function drainScheduler(budget=5,limit=1000):number{return Host.drain(budget,limit);}
export function schedulerTaskCount():number{return Host.pending();}
export function scheduleHostTimeout(fn:()=>void,delay:number):number{return Host.scheduleTimeout(fn,delay);}
export function cancelHostTimeout(id:number):void{Host.cancelTimeout(id);}
