import {ProjectToolError} from '@godot-js/project-tools/errors';
import {BuildError} from '../types.js';

/** Keep the legacy constructor, name, code and details at legacy entry points.
 * The neutral algorithm never imports the framework-specific build package. */
export function rethrowProjectToolError(error:unknown):never {
 if(error instanceof ProjectToolError){
  const prefix=error.code+': ';
  throw new BuildError(error.code,error.message.startsWith(prefix)?error.message.slice(prefix.length):error.message,error.details);
 }
 throw error;
}
