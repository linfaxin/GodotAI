import {component} from './host-component';
import type {ControlProps,StaticTextureAssetRef} from './components';
export interface TextEditProps extends ControlProps {minimapDraw?:boolean;minimapWidth?:number;searchText?:string;searchFlags?:number;text?:string;editable?:boolean;placeholderText?:string;wrapMode?:0|1;autowrapMode?:0|1|2|3;selectingEnabled?:boolean;caretBlink?:boolean;scrollVertical?:number;scrollHorizontal?:number;scrollPastEndOfFile?:boolean;highlightCurrentLine?:boolean;tabInputMode?:boolean;onTextChanged?:()=>void;onCaretChanged?:()=>void;onLinesEdited?:(from:number,to:number)=>void}
export interface ListItem {readonly text:string;readonly icon?:StaticTextureAssetRef|null;readonly disabled?:boolean;readonly selectable?:boolean;readonly metadata?:string}
export interface ItemListProps extends ControlProps {items?:readonly (string|ListItem)[];selectMode?:0|1|2;selectedItems?:readonly number[];allowReselect?:boolean;allowSearch?:boolean;maxColumns?:number;fixedColumnWidth?:number;sameColumnWidth?:boolean;fixedIconSize?:{x:number;y:number};iconMode?:0|1;iconScale?:number;maxTextLines?:number;autoHeight?:boolean;onItemSelected?:(index:number)=>void;onMultiSelected?:(index:number,selected:boolean)=>void;onItemActivated?:(index:number)=>void;onItemClicked?:(index:number,position:{x:number;y:number},button:number)=>void}
export interface SplitContainerProps extends ControlProps {splitOffset?:number;collapsed?:boolean;draggerVisibility?:0|1|2;draggingEnabled?:boolean;touchDraggerEnabled?:boolean;onDragged?:(offset:number)=>void;onDragStarted?:()=>void;onDragEnded?:()=>void}
export interface FlowContainerProps extends ControlProps {alignment?:0|1|2;lastWrapAlignment?:0|1|2|3;reverseFill?:boolean}
export const TextEdit=component<'TextEdit',TextEditProps>('TextEdit');
export const ItemList=component<'ItemList',ItemListProps>('ItemList');
export const HSplitContainer=component<'HSplitContainer',SplitContainerProps>('HSplitContainer');
export const VSplitContainer=component<'VSplitContainer',SplitContainerProps>('VSplitContainer');
export const HFlowContainer=component<'HFlowContainer',FlowContainerProps>('HFlowContainer');
export const VFlowContainer=component<'VFlowContainer',FlowContainerProps>('VFlowContainer');
