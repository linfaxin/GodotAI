import {component} from './host-component';
import type {StaticBody2DProps,SpatialProps} from './components';
import type {AssetRef} from './contracts';
export const AnimatableBody2D=component<'AnimatableBody2D',StaticBody2DProps & {syncToPhysics?:boolean}>('AnimatableBody2D');
export const AnimatableBody3D=component<'AnimatableBody3D',SpatialProps & {axisLockLinearX?:boolean;axisLockLinearY?:boolean;axisLockLinearZ?:boolean;axisLockAngularX?:boolean;axisLockAngularY?:boolean;axisLockAngularZ?:boolean;syncToPhysics?:boolean;collisionLayer?:number;collisionMask?:number;constantLinearVelocity?:{x:number;y:number;z:number};constantAngularVelocity?:{x:number;y:number;z:number};physicsMaterialOverride?:AssetRef<'PhysicsMaterial'>|null}>('AnimatableBody3D');
export type ShaderValue=boolean|number|Readonly<{x:number;y:number}>|Readonly<{x:number;y:number;z:number}>|import('./contracts').ColorValue|AssetRef<'Texture2D'|'ImageTexture'|'CompressedTexture2D'|'AtlasTexture'|'GradientTexture1D'|'GradientTexture2D'|'CurveTexture'>;
export interface ScalarTweenStep {to:number;duration:number;delay?:number;transition?:number;ease?:number;parallel?:boolean}
export interface AppearanceTweenStep {property:'modulate'|'selfModulate'|'color'|'defaultColor';to:import('./contracts').ColorValue;duration:number;delay?:number;transition?:number;ease?:number;parallel?:boolean}
export interface ScalarTweenPlan {steps:readonly ScalarTweenStep[];loops?:number}
export interface AppearanceTweenPlan {steps:readonly AppearanceTweenStep[];loops?:number}
