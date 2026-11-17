import type {EngineRoot} from './engine';

declare const integrationBrand:unique symbol;
/** Opaque renderer integration. Its callbacks never enter public native props. */
export interface EngineNodeIntegration {readonly [integrationBrand]:true}
export interface EngineNodeIntegrationHooks {
 afterCreate?(root:EngineRoot,node:any):void|(()=>void);
 apply?(root:EngineRoot,node:any,initial:boolean):void;
 afterSubtree?(root:EngineRoot,node:any):void;
}
const integrations=new WeakMap<object,EngineNodeIntegrationHooks>();
export function createEngineNodeIntegration(hooks:EngineNodeIntegrationHooks):EngineNodeIntegration {
 const token=Object.freeze({}) as EngineNodeIntegration;integrations.set(token,hooks);return token;
}
export function engineNodeIntegration(value:EngineNodeIntegration):EngineNodeIntegrationHooks {
 const hooks=integrations.get(value);if(!hooks)throw Error('E_ENGINE_INTEGRATION: Unknown renderer integration');return hooks;
}
