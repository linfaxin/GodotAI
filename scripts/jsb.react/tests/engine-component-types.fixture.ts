import * as React from 'react';
import {Area2D,asset,type NodeReadHandle,type QueryOptions,type ShapeQuery2D,type ShapeQuery3D,type CollisionResult,type PhysicsNode,type BodySignals,type ShapeContact} from '../src/engine-components';
const handle={} as NodeReadHandle<'Node2D'>;
const options:QueryOptions={exclude:[handle]};
const query2:ShapeQuery2D={...options,shape:asset('shape2','CircleShape2D'),transform:{basis:{x:{x:1,y:0},y:{x:0,y:1}},origin:{x:0,y:0}}};
const query3:ShapeQuery3D={...options,shape:asset('shape3','SphereShape3D'),transform:{basis:{x:{x:1,y:0,z:0},y:{x:0,y:1,z:0},z:{x:0,y:0,z:1}},origin:{x:0,y:0,z:0}}};
const collision:CollisionResult<{x:number;y:number}>={position:{x:0,y:0},normal:{x:0,y:1},travel:{x:0,y:0},remainder:{x:0,y:0},colliderVelocity:{x:0,y:0},collider:handle,colliderShape:0,depth:0};
const contact:ShapeContact={collider:handle,colliderShape:handle,localShape:handle,colliderShapeIndex:0,localShapeIndex:0};
const body:PhysicsNode=handle;
const callbacks:BodySignals={onBodyEntered(value){if('isValid'in value)value.readPosition();},onBodyShapeEntered(value:ShapeContact){if(value.collider&&'isValid'in value.collider)value.collider.readPosition();}};
const props:React.ComponentProps<typeof Area2D>={...callbacks,onAreaEntered(value:PhysicsNode){if('isValid'in value)value.readPosition();},onAreaShapeEntered(value:ShapeContact){void value.collider;}};
void [query2,query3,collision,contact,body,props];
// @ts-expect-error The direct renderer never exposes legacy slot/revision keys.
handle.nativeKey.slot;
const legacy={} as import('../src/runtime').NodeReadHandle;
// @ts-expect-error A legacy bridge handle cannot be used for an engine query.
const foreign:QueryOptions={exclude:[legacy]};
void foreign;
