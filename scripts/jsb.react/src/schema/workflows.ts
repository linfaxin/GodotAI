import type {HostSchema,PropertySchema,CommandSchema,SignalSchema} from './core';
import type {CodecName} from './codecs';
const p=(name:string,native:string,codec:CodecName,value:any,extra:Partial<PropertySchema>={}):PropertySchema=>({publicName:name,nativeName:native,accessName:native,codec,defaultValue:value,aliases:[name],...extra});
const i=(name:string,native:string,value:number,min:number,max:number,extra:Partial<PropertySchema>={})=>p(name,native,'integer',value,{minimum:min,maximum:max,...extra});
const b=(name:string,native:string,value:boolean,extra:Partial<PropertySchema>={})=>p(name,native,'boolean',value,extra);
const c=(name:string,args:CodecName[]=[],effects:string[]=[],result?:CodecName):CommandSchema=>({publicName:name,nativeName:'__react_workflows_'+name,arguments:args,effects,phase:'process',...(result?{result}:{})});
const host=(type:string,s:HostSchema,props:Record<string,PropertySchema>={},commands:Record<string,CommandSchema>={},signals:Record<string,SignalSchema>={}):HostSchema=>({...s,type,nativeType:type,properties:{...s.properties,...props},commands:{...s.commands,...commands},signals:{...s.signals,...signals}});
export function extendWorkflows(base:Readonly<Record<string,HostSchema>>):Readonly<Record<string,HostSchema>> {
 const out:Record<string,HostSchema>={...base};
 out.CheckButton=host('CheckButton',out.CheckBox!);
 out.MenuButton=host('MenuButton',out.Button!,{flat:b('flat','flat',true),toggleMode:b('toggleMode','toggle_mode',true),actionMode:i('actionMode','action_mode',0,0,1),focusMode:i('focusMode','focus_mode',0,0,3),items:p('items','__react_workflows_menu','menuItems',[],{aliases:['menuState']}),switchOnHover:b('switchOnHover','switch_on_hover',false)}, {setMenuItemChecked:c('setMenuItemChecked',['integer','boolean'],['menuState']),isMenuItemChecked:c('isMenuItemChecked',['integer'],[],'boolean'),setMenuItemDisabled:c('setMenuItemDisabled',['integer','boolean'],['menuState']),getMenuRect:c('getMenuRect',[],[],'rect2'),isMenuOpen:c('isMenuOpen',[],[],'boolean')},{onIdPressed:{publicName:'onIdPressed',nativeName:'__react_workflows_menu_id',parameters:['integer'],echo:'deliver'}});
 for(const type of ['HSeparator','VSeparator'])out[type]=host(type,out.Control!,{separatorStyle:p('separatorStyle','theme_override_styles/separator','assetRef',null,{resourceTypes:['StyleBoxFlat','StyleBoxTexture','StyleBoxEmpty']})});
 out.CodeEdit=host('CodeEdit',out.TextEdit!,{drawLineNumbers:b('drawLineNumbers','gutters_draw_line_numbers',false),indentSize:i('indentSize','indent_size',4,1,16),indentUseSpaces:b('indentUseSpaces','indent_use_spaces',false),indentAutomatic:b('indentAutomatic','indent_automatic',false),braceCompletionEnabled:b('braceCompletionEnabled','auto_brace_completion_enabled',false),syntaxHighlighter:p('syntaxHighlighter','__react_workflows_highlighter','assetRef',null,{accessName:'syntax_highlighter',resourceTypes:['CodeHighlighter']})},{indentLines:c('indentLines',[],['text','selection']),unindentLines:c('unindentLines',[],['text','selection'])});
 for(const [type,schema]of Object.entries(out)){
  const props:Record<string,PropertySchema>={};
  for(const [key,v]of Object.entries(schema.properties))if(v.resourceTypes?.includes('StyleBoxFlat'))props[key]={...v,resourceTypes:[...new Set([...v.resourceTypes,'StyleBoxTexture','StyleBoxEmpty'])]};
  if(schema.properties.customMinimumSize){props.growHorizontal=i('growHorizontal','grow_horizontal',1,0,2,{writeOrder:-60});props.growVertical=i('growVertical','grow_vertical',1,0,2,{writeOrder:-60});}
  if(schema.properties.position&&!schema.properties.customMinimumSize){const group=schema.properties.position.codec==='vector3'?'transform3d':'transform2d';props.topLevel=b('topLevel','top_level',false,{aliases:[group],writeOrder:-70});}
  if(schema.properties.lightMask)props.showBehindParent=b('showBehindParent','show_behind_parent',false);
  if(Object.keys(props).length)out[type]=host(type,schema,props);
 }
 const commands:Record<string,CommandSchema>={};for(const [name,result]of [['stopState',undefined],['nextState',undefined],['isStatePlaying','boolean'],['getStatePosition','number'],['getStateLength','number'],['getFadingFromState','string'],['getFadingPosition','number'],['getFadingLength','number'],['getTravelPath','stringArray']] as const)commands[name]=c(name,['string'],result?[]:['playback'],result);
 out.AnimationTree=host('AnimationTree',out.AnimationTree!,{},commands);
 out.TileMapLayer=host('TileMapLayer',out.TileMapLayer!,{}, {getPattern:c('getPattern',['vector2iArray'],[],'tilePattern'),setPattern:c('setPattern',['vector2i','tilePattern'],['cells']),mapPattern:c('mapPattern',['vector2i','vector2i','tilePattern'],[],'vector2i'),setCellsTerrainPath:c('setCellsTerrainPath',['vector2iArray','integer','integer','boolean'],['cells'])});
 const freeze=(v:any):any=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};return freeze(out);
}
