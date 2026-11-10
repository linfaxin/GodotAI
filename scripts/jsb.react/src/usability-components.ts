import {component} from './host-component';
import type {ControlProps,Node2DProps,RangeOptions} from './components';
import type {AssetRef} from './contracts';
export interface RichTextLabelProps extends ControlProps {boldFontSize?:number;italicsFontSize?:number;boldItalicsFontSize?:number;monoFontSize?:number;text?:string;bbcodeEnabled?:boolean;fitContent?:boolean;scrollActive?:boolean;scrollFollowing?:boolean;selectionEnabled?:boolean;autowrapMode?:0|1|2|3;visibleCharacters?:number;visibleCharactersBehavior?:0|1|2|3|4;horizontalAlignment?:0|1|2|3;verticalAlignment?:0|1|2|3;boldFont?:AssetRef<'FontFile'>|null;italicsFont?:AssetRef<'FontFile'>|null;boldItalicsFont?:AssetRef<'FontFile'>|null;monoFont?:AssetRef<'FontFile'>|null;onMetaClicked?:(metadata:string)=>void;onMetaHoverStarted?:(metadata:string)=>void;onMetaHoverEnded?:(metadata:string)=>void}
export interface SliderProps extends ControlProps,RangeOptions {minValue?:number;maxValue?:number;step?:number;value?:number;editable?:boolean;onValueChanged?:(value:number)=>void;onDragStarted?:()=>void;onDragEnded?:(changed:boolean)=>void}
export interface ScrollBarProps extends ControlProps,RangeOptions {minValue?:number;maxValue?:number;step?:number;value?:number;onValueChanged?:(value:number)=>void;onScrolling?:()=>void}
export const RichTextLabel=component<'RichTextLabel',RichTextLabelProps>('RichTextLabel');
export const VSlider=component<'VSlider',SliderProps>('VSlider');
export const HScrollBar=component<'HScrollBar',ScrollBarProps>('HScrollBar');
export const VScrollBar=component<'VScrollBar',ScrollBarProps>('VScrollBar');
export const CanvasGroup=component<'CanvasGroup',Node2DProps & {clearMargin?:number;fitMargin?:number;useMipmaps?:boolean}>('CanvasGroup');
