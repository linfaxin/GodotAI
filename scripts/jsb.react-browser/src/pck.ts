import {packProject as packCore,type PackOptions,type PackResult} from '@godot-js/project-tools/pck';
import {ProjectToolError} from '@godot-js/project-tools/errors';
import {BrowserBuildError} from './contracts.js';
export type {PackOptions,PackResult};

/** Compatibility error surface; the PCK v3 writer has one neutral implementation. */
export function packProject(input:ReadonlyMap<string,Uint8Array>,options:PackOptions={}):PackResult {
 try{return packCore(input,options);}catch(error){
  if(error instanceof ProjectToolError)throw new BrowserBuildError(error.code,error.message.slice(error.code.length+2),error.details);
  throw error;
 }
}
