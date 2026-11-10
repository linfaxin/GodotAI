import type {PhysicsNode} from './showcase-components';
export type ContactNode=Exclude<PhysicsNode,Readonly<{kind:'UnmanagedNode'}>>;
/** Event-time indices plus live, Root-local node identities. No RID crosses this DTO. */
export interface ShapeContact {readonly collider:ContactNode|null;readonly colliderShapeIndex:number;readonly localShapeIndex:number;readonly colliderShape:ContactNode|null;readonly localShape:ContactNode|null}
