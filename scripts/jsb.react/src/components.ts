export type StyleAssetRef=AssetRef<'StyleBoxFlat'|'StyleBoxTexture'|'StyleBoxEmpty'>;
import * as React from "react";
import type { AudioOptions, BodySignals, RigidBodyOptions } from "./showcase-components";
import type { AssetRef, ColorValue, Vector2Value } from "./contracts";
import type { NativeInterfaceToken } from "./native-interfaces";
import type { NodeReadHandle } from "./runtime";
import { component } from "./host-component";
export interface CommonProps {processMode?:0|1|2|3|4;name?:string;children?:React.ReactNode;initial?:Readonly<Record<string,unknown>>;engineOwned?:readonly string[];nativeScriptProfile?:string;nativeInterface?:NativeInterfaceToken}
interface CanvasProps extends CommonProps {clipChildren?:0|1|2;useParentMaterial?:boolean;showBehindParent?:boolean;visibilityLayer?:number;lightMask?:number;selfModulate?:ColorValue;zIndex?:number;zAsRelative?:boolean;ySortEnabled?:boolean;textureFilter?:number;textureRepeat?:number;visible?:boolean;modulate?:ColorValue;material?:AssetRef<"CanvasItemMaterial"|"ShaderMaterial">|null}
export interface ControlProps extends CanvasProps {growHorizontal?:0|1|2;growVertical?:0|1|2;clipContents?:boolean;layoutDirection?:0|1|2|3|4;sizeFlagsStretchRatio?:number;onResized?:()=>void;onMinimumSizeChanged?:()=>void;position?:Vector2Value;size?:Vector2Value;rotation?:number;scale?:Vector2Value;pivotOffset?:Vector2Value;tooltipText?:string;mouseDefaultCursorShape?:number;focusNeighborLeft?:string;focusNeighborTop?:string;focusNeighborRight?:string;focusNeighborBottom?:string;focusNext?:string;focusPrevious?:string;focusMode?:0|1|2|3;onMouseEntered?:()=>void;onMouseExited?:()=>void;layout?:import("./parity-values").ControlLayout|null;font?:AssetRef<"FontFile">|null;fontSize?:number;fontColor?:ColorValue;panelStyle?:StyleAssetRef|null;customMinimumSize?:Vector2Value;sizeFlagsHorizontal?:number;sizeFlagsVertical?:number;mouseFilter?:number;onFocusEntered?:()=>void;onFocusExited?:()=>void}
export interface Node2DProps extends CanvasProps {topLevel?:boolean;position?:Vector2Value;rotation?:number;scale?:Vector2Value}
export interface LabelProps extends ControlProps {visibleCharacters?:number;visibleCharactersBehavior?:0|1|2|3|4;fontOutlineSize?:number;fontOutlineColor?:ColorValue;fontShadowColor?:ColorValue;shadowOffsetX?:number;shadowOffsetY?:number;shadowOutlineSize?:number;text?:string;horizontalAlignment?:number;verticalAlignment?:number;autowrapMode?:number;clipText?:boolean;maxLinesVisible?:number;textOverrunBehavior?:number}
export interface ButtonProps extends ControlProps {actionMode?:0|1;buttonMask?:number;keepPressedOutside?:boolean;onButtonDown?:()=>void;onButtonUp?:()=>void;buttonGroup?:AssetRef<"ButtonGroup">|null;icon?:StaticTextureAssetRef|null;expandIcon?:boolean;alignment?:0|1|2;normalStyle?:StyleAssetRef|null;hoverStyle?:StyleAssetRef|null;pressedStyle?:StyleAssetRef|null;disabledStyle?:StyleAssetRef|null;focusStyle?:StyleAssetRef|null;text?:string;disabled?:boolean;toggleMode?:boolean;buttonPressed?:boolean;onPressed?:()=>void;onToggled?:(pressed:boolean)=>void}
export interface CanvasLayerProps extends CommonProps {followViewportEnabled?:boolean;followViewportScale?:number;visible?:boolean;layer?:number;offset?:Vector2Value;rotation?:number;scale?:Vector2Value}
type InitialValues<P> = {readonly [K in keyof P as K extends Exclude<keyof CommonProps,"processMode"> ? never : P[K] extends ((...args:any[])=>any)|undefined ? never : K]?:P[K]};
export type HostProps<P> = Omit<P,"initial"> & {initial?:keyof InitialValues<P> extends never?Readonly<Record<string,never>>:InitialValues<P>};
export type HostComponent<K extends string,P> = React.ForwardRefExoticComponent<React.PropsWithoutRef<HostProps<P>> & React.RefAttributes<NodeReadHandle<K>>>;
export const Node=component<"Node",CommonProps>("Node");
export const Node2D=component<"Node2D",Node2DProps & {packedScene?:AssetRef<"PackedScene">|null}>("Node2D");
export const Control=component<"Control",ControlProps>("Control");
export const VBoxContainer=component<"VBoxContainer",ControlProps>("VBoxContainer");
export const HBoxContainer=component<"HBoxContainer",ControlProps>("HBoxContainer");
export const Label=component<"Label",LabelProps>("Label");
export const Button=component<"Button",ButtonProps>("Button");
export const CanvasLayer=component<"CanvasLayer",CanvasLayerProps>("CanvasLayer");
export interface CharacterBody2DProps extends Node2DProps {velocity?:Vector2Value;upDirection?:Vector2Value;collisionLayer?:number;collisionMask?:number;motionMode?:number;floorStopOnSlope?:boolean;floorConstantSpeed?:boolean;floorBlockOnWall?:boolean;floorMaxAngle?:number;floorSnapLength?:number;slideOnCeiling?:boolean;maxSlides?:number;wallMinSlideAngle?:number;safeMargin?:number;platformFloorLayers?:number;platformWallLayers?:number;platformOnLeave?:0|1|2}
export interface StaticBody2DProps extends Node2DProps {physicsMaterialOverride?:AssetRef<"PhysicsMaterial">|null;collisionLayer?:number;collisionMask?:number;constantLinearVelocity?:Vector2Value;constantAngularVelocity?:number}
export interface CollisionShape2DProps extends Node2DProps {shape?:AssetRef<"CircleShape2D"|"RectangleShape2D"|"CapsuleShape2D"|"ConvexPolygonShape2D"|"ConcavePolygonShape2D"|"SeparationRayShape2D"|"WorldBoundaryShape2D">|null;disabled?:boolean;oneWayCollision?:boolean;oneWayCollisionMargin?:number}
export const CharacterBody2D=component<"CharacterBody2D",CharacterBody2DProps>("CharacterBody2D");
export const StaticBody2D=component<"StaticBody2D",StaticBody2DProps>("StaticBody2D");
export const CollisionShape2D=component<"CollisionShape2D",CollisionShape2DProps>("CollisionShape2D");
export type StaticTextureAssetRef=AssetRef<'Texture2D'|'ImageTexture'|'CompressedTexture2D'|'AtlasTexture'|'GradientTexture1D'|'GradientTexture2D'|'CurveTexture'>;
export type TextureAssetRef=AssetRef<'Texture2D'|'ImageTexture'|'CompressedTexture2D'|'ViewportTexture'|'AtlasTexture'|'GradientTexture1D'|'GradientTexture2D'|'CurveTexture'>;
export interface MarginContainerProps extends ControlProps {marginLeft?:number;marginRight?:number;marginTop?:number;marginBottom?:number}
export interface ScrollContainerProps extends ControlProps {scrollDeadzone?:number;horizontalCustomStep?:number;verticalCustomStep?:number;onScrollStarted?:()=>void;onScrollEnded?:()=>void;horizontalScrollMode?:0|1|2|3|4;verticalScrollMode?:0|1|2|3|4;followFocus?:boolean}
export interface TextureRectProps extends ControlProps {viewportPath?:string;texture?:TextureAssetRef|null;expandMode?:0|1|2|3|4|5;stretchMode?:0|1|2|3|4|5|6;flipH?:boolean;flipV?:boolean}
/** The showcase supports configurable native ranges. */
export interface RangeOptions {page?:number;rounded?:boolean;expEdit?:boolean;allowGreater?:boolean;allowLesser?:boolean;onRangeChanged?:()=>void}
export interface ProgressBarProps extends ControlProps,RangeOptions {indeterminate?:boolean;value?:number;minValue?:number;maxValue?:number;step?:number;showPercentage?:boolean;fillMode?:0|1|2|3;onValueChanged?:(value:number)=>void}
export interface Sprite2DProps extends Omit<Node2DProps,"material"> {hframes?:number;vframes?:number;frame?:number;regionEnabled?:boolean;regionRect?:import("./gameplay-components").Rect2Value;regionFilterClipEnabled?:boolean;material?:AssetRef<"ShaderMaterial"|"CanvasItemMaterial">|null;viewportPath?:string;texture?:TextureAssetRef|null;centered?:boolean;offset?:Vector2Value;flipH?:boolean;flipV?:boolean}
export const PanelContainer=component<'PanelContainer',ControlProps>('PanelContainer');
export const MarginContainer=component<'MarginContainer',MarginContainerProps>('MarginContainer');
export const ScrollContainer=component<'ScrollContainer',ScrollContainerProps>('ScrollContainer');
export const TextureRect=component<'TextureRect',TextureRectProps>('TextureRect');
export const ProgressBar=component<'ProgressBar',ProgressBarProps>('ProgressBar');
export const Sprite2D=component<'Sprite2D',Sprite2DProps>('Sprite2D');
export const G=Object.freeze({Node,Node2D,Control,VBoxContainer,HBoxContainer,Label,Button,CanvasLayer,CharacterBody2D,StaticBody2D,CollisionShape2D,PanelContainer,MarginContainer,ScrollContainer,TextureRect,ProgressBar,Sprite2D});

// Explicit showcase hosts. They require profileId="showcase-v1" at the Root.
export type V3=Readonly<{x:number;y:number;z:number}>;
export interface GeometryRangeProps {customAabb?:import("./essentials-components").AabbValue;materialOverlay?:AssetRef<"StandardMaterial3D"|"ShaderMaterial">|null;visibilityRangeBegin?:number;visibilityRangeEnd?:number;visibilityRangeBeginMargin?:number;visibilityRangeEndMargin?:number;extraCullMargin?:number;}
export interface SpatialProps extends CommonProps {topLevel?:boolean;position?:V3;rotation?:V3;scale?:V3;visible?:boolean}
export const Node3D=component<"Node3D",SpatialProps & {packedScene?:AssetRef<"PackedScene">|null}>("Node3D");
export const MeshInstance3D=component<"MeshInstance3D",SpatialProps & GeometryRangeProps & {mesh?:AssetRef<"Mesh">|null;layers?:number;castShadow?:0|1|2|3;surfaceMaterials?:readonly (AssetRef<"StandardMaterial3D"|"ShaderMaterial">|null)[];skin?:AssetRef<"Skin">|null;skeleton?:string;materialOverride?:AssetRef<"StandardMaterial3D"|"ShaderMaterial">|null}>("MeshInstance3D");
export const Camera3D=component<"Camera3D",SpatialProps & {keepAspect?:0|1;frustumOffset?:Vector2Value;hOffset?:number;vOffset?:number;current?:boolean;fov?:number;projection?:number;size?:number;near?:number;far?:number;cullMask?:number}>("Camera3D");
export const DirectionalLight3D=component<"DirectionalLight3D",SpatialProps & {lightColor?:ColorValue;lightEnergy?:number;shadowEnabled?:boolean;layers?:number;lightCullMask?:number}>("DirectionalLight3D");
export const WorldEnvironment=component<"WorldEnvironment",CommonProps & {environment?:AssetRef<"Environment">|null}>("WorldEnvironment");
export const StaticBody3D=component<"StaticBody3D",SpatialProps & {axisLockLinearX?:boolean;axisLockLinearY?:boolean;axisLockLinearZ?:boolean;axisLockAngularX?:boolean;axisLockAngularY?:boolean;axisLockAngularZ?:boolean;physicsMaterialOverride?:AssetRef<"PhysicsMaterial">|null;collisionLayer?:number;collisionMask?:number;constantLinearVelocity?:V3;constantAngularVelocity?:V3}>("StaticBody3D");
export const CharacterBody3D=component<"CharacterBody3D",SpatialProps & {axisLockLinearX?:boolean;axisLockLinearY?:boolean;axisLockLinearZ?:boolean;axisLockAngularX?:boolean;axisLockAngularY?:boolean;axisLockAngularZ?:boolean;velocity?:V3;collisionLayer?:number;collisionMask?:number;upDirection?:V3;motionMode?:number;floorStopOnSlope?:boolean;floorConstantSpeed?:boolean;floorBlockOnWall?:boolean;floorMaxAngle?:number;floorSnapLength?:number;slideOnCeiling?:boolean;maxSlides?:number;wallMinSlideAngle?:number;safeMargin?:number;platformFloorLayers?:number;platformWallLayers?:number;platformOnLeave?:0|1|2}>("CharacterBody3D");
export const CollisionShape3D=component<"CollisionShape3D",SpatialProps & {shape?:AssetRef<"BoxShape3D"|"CapsuleShape3D"|"SphereShape3D"|"ConvexPolygonShape3D"|"ConcavePolygonShape3D"|"SeparationRayShape3D"|"WorldBoundaryShape3D">|null;disabled?:boolean}>("CollisionShape3D");
export const RigidBody3D=component<"RigidBody3D",SpatialProps & RigidBodyOptions & BodySignals & {continuousCd?:boolean;linearVelocity?:V3;angularVelocity?:V3}>("RigidBody3D");
export const RayCast3D=component<"RayCast3D",SpatialProps & {enabled?:boolean;targetPosition?:V3;excludeParent?:boolean;collisionMask?:number;collideWithAreas?:boolean;collideWithBodies?:boolean;hitFromInside?:boolean;hitBackFaces?:boolean}>("RayCast3D");
export const ColorRect=component<"ColorRect",Omit<ControlProps,"material"> & {material?:AssetRef<"ShaderMaterial"|"CanvasItemMaterial">|null;position?:Vector2Value;size?:Vector2Value;color?:ColorValue}>("ColorRect");
export const CanvasModulate=component<"CanvasModulate",Node2DProps & {color?:ColorValue}>("CanvasModulate");
export const PointLight2D=component<"PointLight2D",Node2DProps & {texture?:AssetRef<"Texture2D">|null;color?:ColorValue;energy?:number;textureScale?:number;shadowEnabled?:boolean;enabled?:boolean;itemCullMask?:number;shadowItemCullMask?:number;blendMode?:0|1|2;shadowColor?:ColorValue;height?:number}>("PointLight2D");
export const LightOccluder2D=component<"LightOccluder2D",Node2DProps & {occluder?:AssetRef<"OccluderPolygon2D">|null;occluderLightMask?:number}>("LightOccluder2D");
export const AudioStreamPlayer=component<"AudioStreamPlayer",CommonProps & AudioOptions>("AudioStreamPlayer");

export const DirectionalLight2D=component<"DirectionalLight2D",Node2DProps & {color?:ColorValue;energy?:number;shadowEnabled?:boolean;enabled?:boolean;itemCullMask?:number;shadowItemCullMask?:number;blendMode?:0|1|2;shadowColor?:ColorValue;height?:number;maxDistance?:number}>("DirectionalLight2D");
