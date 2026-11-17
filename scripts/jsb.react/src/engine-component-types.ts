/** Type adapters preserve the typed facade without leaking legacy NodeKey handles. */
import type {NodeReadHandle as LegacyNodeReadHandle} from './runtime';
import type {NodeReadHandle} from './engine-component-runtime';
import type * as Showcase from './showcase-components';
import type * as Parity from './parity-components';
import type * as Gameplay from './gameplay-components';
import type * as Precision from './precision-values';

export interface UnmanagedNodeFact {readonly kind:'unmanaged-node';readonly objectId:string}
export type EngineFacadeValue<T> = 0 extends (1&T) ? T :
 T extends LegacyNodeReadHandle<infer K> ? NodeReadHandle<K> :
 T extends {readonly kind:'UnmanagedNode'|'NodeId'} ? Readonly<UnmanagedNodeFact> :
 T extends (...args:infer A)=>infer R ? (...args:{[K in keyof A]:EngineFacadeValue<A[K]>})=>R :
 T extends readonly unknown[] ? {[K in keyof T]:EngineFacadeValue<T[K]>} :
 T extends object ? {[K in keyof T]:EngineFacadeValue<T[K]>} : T;

export type PhysicsNode=EngineFacadeValue<Showcase.PhysicsNode>;
export type BodySignals=EngineFacadeValue<Showcase.BodySignals>;
export type AreaOptions<V=Readonly<{x:number;y:number}>>=EngineFacadeValue<Showcase.AreaOptions<V>>;
export type QueryOptions=EngineFacadeValue<Parity.QueryOptions>;
export type ShapeQuery2D=EngineFacadeValue<Parity.ShapeQuery2D>;
export type ShapeQuery3D=EngineFacadeValue<Parity.ShapeQuery3D>;
export type CollisionResult<V>=EngineFacadeValue<Gameplay.CollisionResult<V>>;
export type ContactNode=EngineFacadeValue<Precision.ContactNode>;
export type ShapeContact=EngineFacadeValue<Precision.ShapeContact>;
