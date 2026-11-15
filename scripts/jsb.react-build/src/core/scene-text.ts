import {parseSceneText as parseCore} from '@godot-js/project-tools/scene-text';
import {rethrowProjectToolError} from './compatibility-errors.js';
export type {Section} from '@godot-js/project-tools/scene-text';
export function parseSceneText(...args:Parameters<typeof parseCore>):ReturnType<typeof parseCore>{
 try{return parseCore(...args);}catch(error){return rethrowProjectToolError(error);}
}
