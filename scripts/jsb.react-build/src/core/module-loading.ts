import {bundleClosedModulesWith as bundleCore} from '@godot-js/project-tools/module-loading';
import {rethrowProjectToolError} from './compatibility-errors.js';
export type {BundlerPort} from '@godot-js/project-tools/module-loading';
export async function bundleClosedModulesWith(...args:Parameters<typeof bundleCore>):ReturnType<typeof bundleCore>{
 try{return await bundleCore(...args);}catch(error){return rethrowProjectToolError(error);}
}
