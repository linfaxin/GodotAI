import type {ProjectLaunch} from './build-plan.js';
import {ProjectToolError} from './errors.js';

export function parseProjectLaunch(input:unknown):ProjectLaunch {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new ProjectToolError('E_PROJECT_LAUNCH','Expected a single scene or script launch');
 const value=input as Record<string,unknown>;
 const allowed=value.kind==='scene'?['kind','source',...(value.source==='override'?['path']:[])]:value.kind==='script'?['kind','module','export']:[];
 if(!allowed.length||Object.keys(value).some(key=>!allowed.includes(key)))throw new ProjectToolError('E_PROJECT_LAUNCH','Scene and script launch fields are mutually exclusive');
 if(value.kind==='script'){
  if(typeof value.module!=='string'||!value.module||(value.export!==undefined&&(typeof value.export!=='string'||!value.export)))throw new ProjectToolError('E_PROJECT_LAUNCH','Script launch requires a module and optional export');
  return {kind:'script',module:value.module,...(value.export?{export:value.export as string}:{})};
 }
 if(value.source==='project')return {kind:'scene',source:'project'};
 if(value.source==='override'&&typeof value.path==='string'&&value.path)return {kind:'scene',source:'override',path:value.path};
 throw new ProjectToolError('E_PROJECT_LAUNCH','Scene launch requires project settings or an explicit override');
}
