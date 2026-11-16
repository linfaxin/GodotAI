const ready: Array<() => void> = [];
const timers = new Map<number, { at: number; callback: () => void;queued:boolean }>();
let serial = 0;
let clock: () => number = () => Date.now();
let request: (() => void) | undefined;
let revision = 0;
const wakeups = new Set<() => void>();
const changed = (): void => { revision++; request?.(); for (const wake of [...wakeups]) wake(); };
export const now = (): number => clock();
export function configure(options: { now?: () => number; requestPump?: () => void }): void {
  if(options.now) clock = options.now;
  request = options.requestPump;
}
export function scheduleHost(callback: () => void): void { ready.push(callback); changed(); }
export function scheduleTimeout(callback: () => void, delay = 0): number {
  const id = ++serial; timers.set(id,{at:now()+Math.max(0,delay),callback,queued:false}); changed(); return id;
}
export function cancelTimeout(id: number): void { if(timers.delete(id))revision++; }
export function subscribeWakeup(callback:()=>void):()=>void { wakeups.add(callback);return ()=>wakeups.delete(callback); }
export const workRevision = ():number => revision;
export const readyWork = ():boolean => ready.length>0||[...timers.values()].some(timer=>timer.at<=now());
export function drain(budget = 5, limit = 1000): number {
  const until = now()+Math.max(0,budget); let count = 0;
  while(count<limit) {
    const time=now();
    for(const [id,timer] of timers) if(timer.at<=time&&!timer.queued){timer.queued=true;ready.push(()=>{if(timers.get(id)===timer){timers.delete(id);timer.callback();}});}
    if(!ready.length || (count>0&&time>=until)) break;
    ready.shift()!(); count++;
  }
  return count;
}
export const pending = (): number => ready.length + timers.size;
