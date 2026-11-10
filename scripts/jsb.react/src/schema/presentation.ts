import type {HostSchema,PropertySchema,CommandSchema} from './core';
import type {CodecName} from './codecs';
const p=(name:string,native:string,codec:CodecName,value:any,extra:Partial<PropertySchema>={}):PropertySchema=>({publicName:name,nativeName:native,accessName:native,codec,defaultValue:value,aliases:[name],...extra});
const num=(name:string,native:string,value:number,min:number,max:number)=>p(name,native,'number',value,{minimum:min,maximum:max});
const bool=(name:string,native:string,value:boolean)=>p(name,native,'boolean',value);
const integer=(name:string,native:string,value:number,min:number,max:number)=>p(name,native,'integer',value,{minimum:min,maximum:max});
const vector=(name:string,native:string,x=0,y=0)=>p(name,native,'vector2',{x,y});
const command=(name:string,args:CodecName[]=[],effects:string[]=[],result?:CodecName):CommandSchema=>({publicName:name,nativeName:'__react_presentation_edit_'+name,arguments:args,effects,phase:'process',...(result?{result}:{})});
export function extendPresentation(base:Readonly<Record<string,HostSchema>>):Readonly<Record<string,HostSchema>>{
 const out:Record<string,HostSchema>={...base},sprite=out.Sprite3D!,animated=out.AnimatedSprite3D!;
 const names=['modulate','billboard','shaded','doubleSided','noDepthTest','fixedSize'];
 out.AnimatedSprite3D={...animated,properties:{...animated.properties,...Object.fromEntries(names.map(name=>[name,sprite.properties[name]!]))},commands:{...animated.commands,...Object.fromEntries(Object.entries(sprite.commands).filter(([name])=>name.includes('AppearanceTween')))}};
 const edit=out.LineEdit!,commands:Record<string,CommandSchema>={};
 for(const name of ['selectAll','deselect'])commands[name]=command(name,[],['text.selection']);
 commands.select=command('select',['integer','integer'],['text.selection']);commands.setCaretColumn=command('setCaretColumn',['integer'],['text.selection']);
 for(const name of ['getCaretColumn','getSelectionFromColumn','getSelectionToColumn'])commands[name]=command(name,[],[],'integer');
 commands.hasSelection=command('hasSelection',[],[],'boolean');commands.getSelectedText=command('getSelectedText',[],[],'string');
 commands.insertTextAtCaret=command('insertTextAtCaret',['string'],['text','text.selection']);commands.deleteText=command('deleteText',['integer','integer'],['text','text.selection']);commands.deleteCharAtCaret=command('deleteCharAtCaret',[],['text','text.selection']);
 out.LineEdit={...edit,commands:{...edit.commands,...commands},properties:{...edit.properties,selectAllOnFocus:bool('selectAllOnFocus','select_all_on_focus',false),caretBlink:bool('caretBlink','caret_blink',false),caretBlinkInterval:num('caretBlinkInterval','caret_blink_interval',.65,.01,10)},signals:{...edit.signals,onTextChangeRejected:{publicName:'onTextChangeRejected',nativeName:'text_change_rejected',parameters:['string'],echo:'deliver'}}};
 const progress=out.TextureProgressBar!;const margins=Object.fromEntries(['Left','Top','Right','Bottom'].map(side=>['stretchMargin'+side,integer('stretchMargin'+side,'stretch_margin_'+side.toLowerCase(),0,0,16384)]));
 out.TextureProgressBar={...progress,properties:{...progress.properties,...margins,radialCenterOffset:vector('radialCenterOffset','radial_center_offset'),textureProgressOffset:vector('textureProgressOffset','texture_progress_offset')}};
 for(const d of [2,3]){const type='GPUParticles'+d+'D',s=out[type]!;out[type]={...s,properties:{...s.properties,amountRatio:num('amountRatio','amount_ratio',1,0,1),interpToEnd:num('interpToEnd','interp_to_end',0,0,1),interpolate:bool('interpolate','interpolate',true),fractDelta:bool('fractDelta','fract_delta',true),drawOrder:integer('drawOrder','draw_order',0,0,d===2?2:3)}};}
 const layer=out.CanvasLayer!;out.CanvasLayer={...layer,properties:{...layer.properties,followViewportEnabled:bool('followViewportEnabled','follow_viewport_enabled',false),followViewportScale:num('followViewportScale','follow_viewport_scale',1,.001,1000)}};
 const spatial=out.Node2D!;const properties={...spatial.properties};delete properties.packedScene;
 properties.position={...properties.position!,aliases:['parallax.position']};
 out.Parallax2D={...spatial,type:'Parallax2D',nativeType:'Parallax2D',properties:{...properties,scrollScale:vector('scrollScale','scroll_scale',1,1),scrollOffset:{...vector('scrollOffset','scroll_offset'),aliases:['parallax.scroll']},repeatSize:vector('repeatSize','repeat_size'),repeatTimes:integer('repeatTimes','repeat_times',1,1,16),autoscroll:vector('autoscroll','autoscroll'),limitBegin:vector('limitBegin','limit_begin',-10000000,-10000000),limitEnd:vector('limitEnd','limit_end',10000000,10000000),followViewport:bool('followViewport','follow_viewport',true),ignoreCameraScroll:bool('ignoreCameraScroll','ignore_camera_scroll',false)},commands:Object.fromEntries(Object.entries(spatial.commands).filter(([name])=>['setRotation','setScale','getGlobalPosition','getGlobalTransform','getTransform','toGlobal','toLocal','getCanvasTransform','localToViewport','worldToViewport','viewportToLocal','viewportToWorld'].includes(name)||name.includes('AppearanceTween')||name.includes('ShaderParameter'))),intrinsicEngineOwned:['parallax.position'],signals:{}};
 const freeze=(value:any):any=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};return freeze(out);
}
