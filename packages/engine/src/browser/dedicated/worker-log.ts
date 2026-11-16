import {DEFAULT_WORKER_RUN_CONFIGURATION} from './worker-protocol.js';

/** Per-run forwarded text limits. Bytes mean UTF-8 text payload, excluding the
 * message envelope and browser-internal copies. A dropped log spends no credit. */
export class WorkerLogBudget {
  private messages=0;
  private bytes=0;
  private readonly maxMessages:number;
  private readonly maxBytes:number;
  constructor(budgets:Readonly<Record<string,number>>) {
    this.maxMessages=budgets.maxLogMessages??DEFAULT_WORKER_RUN_CONFIGURATION.budgets.maxLogMessages!;
    this.maxBytes=budgets.maxLogBytes??DEFAULT_WORKER_RUN_CONFIGURATION.budgets.maxLogBytes!;
  }
  admit(text:string):boolean {
    if(this.messages>=this.maxMessages)return false;
    const size=new TextEncoder().encode(text).byteLength;
    if(size>this.maxBytes-this.bytes)return false;
    this.messages++;this.bytes+=size;return true;
  }
}
