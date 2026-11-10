import type {GeometryRangeProps as importGeometryRangeProps} from './components';
import {component} from './host-component';
import type {ControlProps,SpatialProps,StaticTextureAssetRef,V3} from './components';
import type {AssetRef,ColorValue,Vector2Value} from './contracts';
export interface AabbValue {readonly position:V3;readonly size:V3}
export const CenterContainer=component<'CenterContainer',ControlProps & {useTopLeft?:boolean}>('CenterContainer');
export const AspectRatioContainer=component<'AspectRatioContainer',ControlProps & {ratio?:number;stretchMode?:0|1|2|3;alignmentHorizontal?:0|1|2;alignmentVertical?:0|1|2}>('AspectRatioContainer');
export interface Display3DProps extends SpatialProps, importGeometryRangeProps {layers?:number;castShadow?:0|1|2|3;billboard?:0|1|2;pixelSize?:number;modulate?:ColorValue;offset?:Vector2Value;shaded?:boolean;doubleSided?:boolean;noDepthTest?:boolean;fixedSize?:boolean}
export const Sprite3D=component<'Sprite3D',Display3DProps & {texture?:StaticTextureAssetRef|null;centered?:boolean;flipH?:boolean;flipV?:boolean;hframes?:number;vframes?:number;frame?:number;regionEnabled?:boolean;regionRect?:import('./gameplay-components').Rect2Value;onFrameChanged?:()=>void;onTextureChanged?:()=>void}>('Sprite3D');
export const Label3D=component<'Label3D',Display3DProps & {text?:string;font?:AssetRef<'FontFile'>|null;fontSize?:number;outlineSize?:number;outlineModulate?:ColorValue;width?:number;autowrapMode?:0|1|2|3;horizontalAlignment?:0|1|2|3;verticalAlignment?:0|1|2|3}>('Label3D');
export const VisibleOnScreenNotifier2D=component<'VisibleOnScreenNotifier2D',import('./components').Node2DProps & {rect?:import('./gameplay-components').Rect2Value;onScreenEntered?:()=>void;onScreenExited?:()=>void}>('VisibleOnScreenNotifier2D');
export const VisibleOnScreenNotifier3D=component<'VisibleOnScreenNotifier3D',SpatialProps & {layers?:number;aabb?:AabbValue;onScreenEntered?:()=>void;onScreenExited?:()=>void}>('VisibleOnScreenNotifier3D');
