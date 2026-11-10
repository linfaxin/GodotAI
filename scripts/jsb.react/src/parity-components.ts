import {component} from './host-component';
import type {CommonProps,ControlProps,Node2DProps,SpatialProps,V3} from './components';
export type {Transform2DValue,ControlLayout} from './parity-values';
export interface QueryOptions {collisionMask?:number;collideWithAreas?:boolean;collideWithBodies?:boolean;exclude?:readonly import('./runtime').NodeReadHandle[]}
export interface ShapeQuery2D extends QueryOptions {shape:import('./contracts').AssetRef;transform:import('./parity-values').Transform2DValue;motion?:{x:number;y:number};margin?:number;maxResults?:number}
export interface ShapeQuery3D extends QueryOptions {shape:import('./contracts').AssetRef;transform:import('./schema/codecs').Transform3DValue;motion?:V3;margin?:number;maxResults?:number}
export const AudioBus=component<'Node',CommonProps & {busName:string}>('Node');
export const SubViewport=component<'SubViewport',CommonProps & {canvasCullMask?:number;renderTargetClearMode?:0|1|2;size2dOverride?:{x:number;y:number};size2dOverrideStretch?:boolean;size?:{x:number;y:number};transparentBg?:boolean;disable3d?:boolean;ownWorld3d?:boolean;renderTargetUpdateMode?:0|1|2|3|4;guiDisableInput?:boolean}>('SubViewport');
export const SubViewportContainer=component<'SubViewportContainer',ControlProps & {stretch?:boolean;stretchShrink?:number}>('SubViewportContainer');
type LinkOptions<V>={enabled?:boolean;bidirectional?:boolean;navigationLayers?:number;startPosition?:V;endPosition?:V;enterCost?:number;travelCost?:number};
export const NavigationLink2D=component<'NavigationLink2D',Node2DProps & LinkOptions<{x:number;y:number}>>('NavigationLink2D');
export const NavigationLink3D=component<'NavigationLink3D',SpatialProps & LinkOptions<V3>>('NavigationLink3D');
type ObstacleOptions<V>={radius?:number;avoidanceEnabled?:boolean;avoidanceLayers?:number;vertices?:readonly V[];velocity?:V};
export const NavigationObstacle2D=component<'NavigationObstacle2D',Node2DProps & ObstacleOptions<{x:number;y:number}>>('NavigationObstacle2D');
export const NavigationObstacle3D=component<'NavigationObstacle3D',SpatialProps & ObstacleOptions<V3> & {height?:number;use3dAvoidance?:boolean}>('NavigationObstacle3D');
