import {installWorkerRuntimeHost} from './runtime-host-bootstrap.js';
import {createRuntimeBinding} from '../../runtime-host.js';
import {installNativeLifecycleGate} from '../lifecycle-gate.js';
const scope=globalThis as unknown as {__godotjsRuntimeBootstrapConfig?:{url:string;sessionId:string;workerId:number}};
const config=scope.__godotjsRuntimeBootstrapConfig;
delete scope.__godotjsRuntimeBootstrapConfig;
if(!config||typeof config.url!=='string'||typeof config.sessionId!=='string'||!Number.isSafeInteger(config.workerId)||config.workerId<1)throw Error('E_RUNTIME_BOOTSTRAP_CONFIG');
installWorkerRuntimeHost(config.sessionId,config.workerId,createRuntimeBinding,installNativeLifecycleGate);
(globalThis as unknown as {importScripts(...urls:string[]):void}).importScripts(config.url);
