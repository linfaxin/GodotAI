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

// Explicit showcase hosts. They require profileId="showcase-v1" at the Root.
type V3=Readonly<{x:number;y:number;z:number}>;
interface SpatialProps extends CommonProps {position?:V3;rotation?:V3;scale?:V3;visible?:boolean}
export const Node3D=component<"Node3D",SpatialProps>("Node3D");
export const MeshInstance3D=component<"MeshInstance3D",SpatialProps & {mesh?:AssetRef<"Mesh">|null;materialOverride?:AssetRef<"StandardMaterial3D">|null}>("MeshInstance3D");
export const Camera3D=component<"Camera3D",SpatialProps & {current?:boolean;fov?:number;projection?:number;size?:number}>("Camera3D");
export const DirectionalLight3D=component<"DirectionalLight3D",SpatialProps & {lightColor?:ColorValue;lightEnergy?:number;shadowEnabled?:boolean}>("DirectionalLight3D");
export const WorldEnvironment=component<"WorldEnvironment",CommonProps & {environment?:AssetRef<"Environment">|null}>("WorldEnvironment");
export const StaticBody3D=component<"StaticBody3D",SpatialProps>("StaticBody3D");
export const CharacterBody3D=component<"CharacterBody3D",SpatialProps & {velocity?:V3}>("CharacterBody3D");
export const CollisionShape3D=component<"CollisionShape3D",SpatialProps & {shape?:AssetRef<"BoxShape3D"|"CapsuleShape3D"|"SphereShape3D"|"ConvexPolygonShape3D">|null;disabled?:boolean}>("CollisionShape3D");
export const RigidBody3D=component<"RigidBody3D",SpatialProps & {mass?:number;linearVelocity?:V3;angularVelocity?:V3;gravityScale?:number;linearDamp?:number;angularDamp?:number;freeze?:boolean;sleeping?:boolean;collisionLayer?:number;collisionMask?:number}>("RigidBody3D");
export const RayCast3D=component<"RayCast3D",SpatialProps & {enabled?:boolean;targetPosition?:V3;excludeParent?:boolean;collisionMask?:number}>("RayCast3D");
export const ColorRect=component<"ColorRect",Omit<ControlProps,"material"> & {material?:AssetRef<"ShaderMaterial"|"CanvasItemMaterial">|null;position?:Vector2Value;size?:Vector2Value;color?:ColorValue}>("ColorRect");
export const Sprite2D=component<"Sprite2D",Omit<Node2DProps,"material"> & {material?:AssetRef<"ShaderMaterial"|"CanvasItemMaterial">|null;texture?:AssetRef<"Texture2D">|null;centered?:boolean}>("Sprite2D");
export const CanvasModulate=component<"CanvasModulate",Node2DProps & {color?:ColorValue}>("CanvasModulate");
export const PointLight2D=component<"PointLight2D",Node2DProps & {texture?:AssetRef<"Texture2D">|null;color?:ColorValue;energy?:number;textureScale?:number;shadowEnabled?:boolean}>("PointLight2D");
export const LightOccluder2D=component<"LightOccluder2D",Node2DProps & {occluder?:AssetRef<"OccluderPolygon2D">|null}>("LightOccluder2D");
export const AudioStreamPlayer=component<"AudioStreamPlayer",CommonProps & {stream?:AssetRef<"AudioStream">|null;volumeDb?:number}>("AudioStreamPlayer");
