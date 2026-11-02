import * as React from "react";
import type { AssetRef, ColorValue, Vector2Value } from "./contracts";
import type { NativeInterfaceToken } from "./native-interfaces";
import { useRuntime, type NodeReadHandle } from "./runtime";
export interface CommonProps {name?:string;children?:React.ReactNode;initial?:Readonly<Record<string,unknown>>;engineOwned?:readonly string[];nativeScriptProfile?:string;nativeInterface?:NativeInterfaceToken}
interface CanvasProps extends CommonProps {visible?:boolean;modulate?:ColorValue;material?:AssetRef<"CanvasItemMaterial">|null}
interface ControlProps extends CanvasProps {customMinimumSize?:Vector2Value;sizeFlagsHorizontal?:number;sizeFlagsVertical?:number;mouseFilter?:number;onFocusEntered?:()=>void;onFocusExited?:()=>void}
export interface Node2DProps extends CanvasProps {position?:Vector2Value;rotation?:number;scale?:Vector2Value}
export interface LabelProps extends ControlProps {text?:string}
export interface ButtonProps extends ControlProps {text?:string;disabled?:boolean;toggleMode?:boolean;buttonPressed?:boolean;onPressed?:()=>void;onToggled?:(pressed:boolean)=>void}
export interface CanvasLayerProps extends CommonProps {visible?:boolean;layer?:number;offset?:Vector2Value;rotation?:number;scale?:Vector2Value}
type InitialValues<P> = {readonly [K in keyof P as K extends keyof CommonProps ? never : P[K] extends ((...args:any[])=>any)|undefined ? never : K]?:P[K]};
export type HostProps<P> = Omit<P,"initial"> & {initial?:keyof InitialValues<P> extends never?Readonly<Record<string,never>>:InitialValues<P>};
export type HostComponent<K extends string,P> = React.ForwardRefExoticComponent<React.PropsWithoutRef<HostProps<P>> & React.RefAttributes<NodeReadHandle<K>>>;
function component<K extends string,P extends CommonProps>(type:K):HostComponent<K,P>{
  const Host=React.forwardRef<NodeReadHandle<K>,P>((props,ref)=>{
    useRuntime().prepareHost(type,props as Record<string,unknown>);
    return React.createElement(type as React.ElementType,{...props,ref});
  });Host.displayName=type;return Host as unknown as HostComponent<K,P>;
}
export const Node=component<"Node",CommonProps>("Node");
export const Node2D=component<"Node2D",Node2DProps>("Node2D");
export const Control=component<"Control",ControlProps>("Control");
export const VBoxContainer=component<"VBoxContainer",ControlProps>("VBoxContainer");
export const HBoxContainer=component<"HBoxContainer",ControlProps>("HBoxContainer");
export const Label=component<"Label",LabelProps>("Label");
export const Button=component<"Button",ButtonProps>("Button");
export const CanvasLayer=component<"CanvasLayer",CanvasLayerProps>("CanvasLayer");
export interface CharacterBody2DProps extends Node2DProps {velocity?:Vector2Value;upDirection?:Vector2Value;collisionLayer?:number;collisionMask?:number;motionMode?:number;floorStopOnSlope?:boolean;floorConstantSpeed?:boolean;floorBlockOnWall?:boolean;floorMaxAngle?:number;floorSnapLength?:number;slideOnCeiling?:boolean;maxSlides?:number;wallMinSlideAngle?:number;safeMargin?:number}
export interface StaticBody2DProps extends Node2DProps {collisionLayer?:number;collisionMask?:number;constantLinearVelocity?:Vector2Value;constantAngularVelocity?:number}
export interface CollisionShape2DProps extends Node2DProps {shape?:AssetRef<"CircleShape2D"|"RectangleShape2D"|"CapsuleShape2D">|null;disabled?:boolean;oneWayCollision?:boolean;oneWayCollisionMargin?:number}
export const CharacterBody2D=component<"CharacterBody2D",CharacterBody2DProps>("CharacterBody2D");
export const StaticBody2D=component<"StaticBody2D",StaticBody2DProps>("StaticBody2D");
export const CollisionShape2D=component<"CollisionShape2D",CollisionShape2DProps>("CollisionShape2D");
export const G=Object.freeze({Node,Node2D,Control,VBoxContainer,HBoxContainer,Label,Button,CanvasLayer,CharacterBody2D,StaticBody2D,CollisionShape2D});
