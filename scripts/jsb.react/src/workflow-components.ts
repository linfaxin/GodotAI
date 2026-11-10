import {component} from './host-component';
import type {ButtonProps,ControlProps,StaticTextureAssetRef,StyleAssetRef} from './components';
import type {TextEditProps} from './composition-components';
import type {AssetRef} from './contracts';
export interface MenuItem {readonly text:string;readonly id?:number;readonly icon?:StaticTextureAssetRef|null;readonly disabled?:boolean;readonly checkable?:boolean;readonly checked?:boolean;readonly separator?:boolean}
export type TilePattern=readonly (readonly [number,number,number,number,number,number])[];
export const MenuButton=component<'MenuButton',ButtonProps & {items?:readonly MenuItem[];switchOnHover?:boolean;onIdPressed?:(id:number)=>void}>('MenuButton');
export const CheckButton=component<'CheckButton',ButtonProps>('CheckButton');
export const HSeparator=component<'HSeparator',ControlProps & {separatorStyle?:StyleAssetRef|null}>('HSeparator');
export const VSeparator=component<'VSeparator',ControlProps & {separatorStyle?:StyleAssetRef|null}>('VSeparator');
export const CodeEdit=component<'CodeEdit',TextEditProps & {lineFolding?:boolean;drawFoldGutter?:boolean;drawBookmarks?:boolean;drawBreakpoints?:boolean;drawExecutingLines?:boolean;onBreakpointToggled?:(line:number)=>void;drawLineNumbers?:boolean;indentSize?:number;indentUseSpaces?:boolean;indentAutomatic?:boolean;braceCompletionEnabled?:boolean;syntaxHighlighter?:AssetRef<'CodeHighlighter'>|null}>('CodeEdit');
