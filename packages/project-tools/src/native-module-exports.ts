import {NATIVE_NAMESPACE_FACTORY_SOURCE} from './native-namespace-source.js';
/** JS module metadata must never become a native ClassDB lookup. */
export function nativeModuleSource():string {return `module.exports = (${NATIVE_NAMESPACE_FACTORY_SOURCE})(require);\n`;}
