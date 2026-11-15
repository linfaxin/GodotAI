import {ProjectToolError} from './errors.js';
export function canonicalPath(path: string): string {
 if(typeof path !== 'string' || path.includes('\\') || /[\x00-\x1f\x7f?#:%]/.test(path)) throw new ProjectToolError('E_PROJECT_PATH', `Invalid path ${JSON.stringify(path)}`);
 const normalized='/'+path.replace(/^\/+/, '');
 if(normalized==='/' || normalized.split('/').slice(1).some(part=>!part||part==='.'||part==='..') || path.trim()!==path) throw new ProjectToolError('E_PROJECT_PATH',`Invalid path ${JSON.stringify(path)}`);
 return normalized;
}
export function resourcePath(path:string):string {return 'res:/'+canonicalPath(path.startsWith('res://')?path.slice(6):path);}
