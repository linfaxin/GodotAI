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
export type TextureAssetRef=AssetRef<'Texture2D'|'ImageTexture'|'CompressedTexture2D'>;
export interface MarginContainerProps extends ControlProps {marginLeft?:number;marginRight?:number;marginTop?:number;marginBottom?:number}
export interface ScrollContainerProps extends ControlProps {horizontalScrollMode?:0|1|2|3|4;verticalScrollMode?:0|1|2|3|4;followFocus?:boolean}
export interface TextureRectProps extends ControlProps {texture?:TextureAssetRef|null;expandMode?:0|1|2|3|4|5;stretchMode?:0|1|2|3|4|5|6;flipH?:boolean;flipV?:boolean}
/** ProgressBar uses a fixed 0..100 range with unquantized values. */
export interface ProgressBarProps extends ControlProps {value?:number;minValue?:0;maxValue?:100;step?:0;showPercentage?:boolean;fillMode?:0|1|2|3;onValueChanged?:(value:number)=>void}
export interface Sprite2DProps extends Node2DProps {texture?:TextureAssetRef|null;centered?:boolean;offset?:Vector2Value;flipH?:boolean;flipV?:boolean}
export const PanelContainer=component<'PanelContainer',ControlProps>('PanelContainer');
export const MarginContainer=component<'MarginContainer',MarginContainerProps>('MarginContainer');
export const ScrollContainer=component<'ScrollContainer',ScrollContainerProps>('ScrollContainer');
export const TextureRect=component<'TextureRect',TextureRectProps>('TextureRect');
export const ProgressBar=component<'ProgressBar',ProgressBarProps>('ProgressBar');
export const Sprite2D=component<'Sprite2D',Sprite2DProps>('Sprite2D');
export const G=Object.freeze({Node,Node2D,Control,VBoxContainer,HBoxContainer,Label,Button,CanvasLayer,CharacterBody2D,StaticBody2D,CollisionShape2D,PanelContainer,MarginContainer,ScrollContainer,TextureRect,ProgressBar,Sprite2D});
