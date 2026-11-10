import {parseSceneText} from '@godot-js/react-browser/scene-text';
import {getHostSchema} from '@godot-js/react/schema';
import type {ProjectResourcePlan,SceneNodeSpec} from './project-resources';
function fail(message:string):never{throw Error('E_SCENE_IMPORT: '+message);}
function pathOf(value:unknown,from:string):string{
 if(typeof value!=='string'||/[\\\x00-\x1f%?#]/.test(value))fail('Invalid external resource path');
 const path=value.startsWith('res://')?'/'+value.slice(6):value.startsWith('/')?value:from.slice(0,from.lastIndexOf('/')+1)+value;
 if(path.includes(':'))fail('External paths must be project-local');const parts:string[]=[];
 for(const part of path.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)fail('External path escapes project');parts.pop();}else parts.push(part);}return '/'+parts.join('/');
}
function resourceDefinition(type:string,properties:Record<string,any>):any{
 if(['StyleBoxTexture','StyleBoxEmpty','CodeHighlighter'].includes(type)){properties={...properties};delete properties.resource_name;if(properties.resource_local_to_scene===true)delete properties.resource_local_to_scene;}
 const allow=(keys:string[])=>{if(Object.keys(properties).some(k=>!keys.includes(k)))fail('Unsupported '+type+' property');};
 if(type==='Curve'){allow(['_data','_limits','bake_resolution','resource_name']);const data=properties._data,limits=properties._limits??[0,1,0,1];if(!Array.isArray(data)||data.length<10||data.length>1280||data.length%5||!Array.isArray(limits)||limits.length!==4||limits.some(n=>typeof n!=='number'||!Number.isFinite(n))||limits[2]!==0||limits[3]!==1)fail('Expected bounded normalized Curve');const points=Array.from({length:data.length/5},(_,i)=>{const k=i*5;if(![0,1].includes(data[k+3])||![0,1].includes(data[k+4]))fail('Invalid Curve tangent mode');if(typeof data[k+1]!=='number'||typeof data[k+2]!=='number')fail('Expected tangent numbers');return {...data[k],leftTangent:data[k+1],rightTangent:data[k+2],leftMode:data[k+3],rightMode:data[k+4]};});return {type,points,minValue:limits[0],maxValue:limits[1],bakeResolution:properties.bake_resolution??256};}
 if(type==='Gradient'){allow(['offsets','colors','interpolation_mode','interpolation_color_space','resource_name']);const offsets=properties.offsets??[0,1],colors=properties.colors??[{r:0,g:0,b:0,a:1},{r:1,g:1,b:1,a:1}];if(!Array.isArray(offsets)||!Array.isArray(colors)||offsets.length!==colors.length||offsets.length<2||offsets.length>256)fail('Invalid Gradient points');return {type,points:offsets.map((offset,i)=>({offset,color:colors[i]})),interpolationMode:properties.interpolation_mode??0,interpolationColorSpace:properties.interpolation_color_space??0};}
 if(type==='GradientTexture2D'){allow(['gradient','width','height','fill','fill_from','fill_to','repeat','use_hdr','resource_name']);return {type,gradient:properties.gradient,width:properties.width??64,height:properties.height??64,fill:properties.fill??0,fillFrom:properties.fill_from??{x:0,y:0},fillTo:properties.fill_to??{x:1,y:0},repeat:properties.repeat??0,useHdr:properties.use_hdr??false};}
 if(type==='BitMap'){allow(['data','resource_name']);const data=properties.data;if(!data||typeof data!=='object'||Object.keys(data).some(k=>!['size','data'].includes(k)))fail('Invalid BitMap data');return {type,width:data.size?.x,height:data.size?.y,data:data.data};}
 if(type==='GradientTexture1D'){allow(['gradient','width','use_hdr','resource_name']);return {type,gradient:properties.gradient,width:properties.width??256,useHdr:properties.use_hdr??false};}
 if(type==='CurveTexture'){const keys=Object.keys(properties);if(keys.some(k=>!['curve','width','resource_name'].includes(k)))fail('Unsupported CurveTexture property');return {type,curve:properties.curve,width:properties.width??256};}
 if(type==='MultiMesh'){const p={...properties};delete p.resource_name;const allow=['transform_format','use_colors','use_custom_data','mesh','instance_count','visible_instance_count','custom_aabb'];if(Object.keys(p).some(k=>!allow.includes(k)))fail('Unsupported MultiMesh property');return {type,dimension:p.transform_format===0?2:p.transform_format===1?3:undefined,count:p.instance_count??0,mesh:p.mesh,colors:p.use_colors??false,customData:p.use_custom_data??false,visibleCount:p.visible_instance_count??-1,...(p.custom_aabb?{customAabb:p.custom_aabb}:{})};}
 if(type==='ButtonGroup'){if(Object.keys(properties).some(k=>!['allow_unpress','resource_name'].includes(k)))fail('Unsupported ButtonGroup property');return {type,allowUnpress:properties.allow_unpress??false};}
 if(type==='QuadMesh'){if(Object.keys(properties).some(k=>!['size','material','resource_name'].includes(k)))fail('Unsupported QuadMesh property');return {type,size:properties.size??{x:1,y:1},...(properties.material?{material:properties.material}:{})};}
 if(type==='ParticleProcessMaterial'){const values={...properties};delete values.resource_name;if(values.resource_local_to_scene!==undefined){if(values.resource_local_to_scene!==true)fail('Particle material scenes require local resources');delete values.resource_local_to_scene;}return {type,properties:values};}

 const allowed=(keys:string[])=>{if(Object.keys(properties).some(k=>!keys.includes(k)))fail('Unsupported '+type+' property');};
 const rect=(v:any)=>{if(!v?.position||!v?.size)fail('Expected Rect2');return [v.position.x,v.position.y,v.size.x,v.size.y];};
 if(type==='OccluderPolygon2D'){allowed(['polygon','closed','cull_mode','resource_name']);return {type,points:properties.polygon,closed:properties.closed??true,cullMode:properties.cull_mode??0};}
 if(type==='AtlasTexture'){allowed(['atlas','region','margin','filter_clip','resource_name']);return {type,atlas:properties.atlas,region:rect(properties.region),...(properties.margin?{margin:rect(properties.margin)}:{}),...(properties.filter_clip===undefined?{}:{filterClip:properties.filter_clip})};}
 if(/^ConvexPolygonShape[23]D$/.test(type)){allowed(['points','resource_name']);return {type,points:properties.points};}
 if(/^ConcavePolygonShape[23]D$/.test(type)){const two=type.endsWith('2D');allowed([two?'segments':'data','resource_name']);return {type,[two?'segments':'faces']:properties[two?'segments':'data']};}
 if(/^SeparationRayShape[23]D$/.test(type)){allowed(['length','slide_on_slope','resource_name']);return {type,length:properties.length??20,slideOnSlope:properties.slide_on_slope??false};}
 if(/^WorldBoundaryShape[23]D$/.test(type)){const two=type.endsWith('2D');allowed(two?['normal','distance','resource_name']:['plane','resource_name']);return {type,normal:two?properties.normal:properties.plane?.normal,distance:two?properties.distance:properties.plane?.distance};}
 return {type,properties};
}
/** Import a closed Godot text-scene subset as React-owned nodes, including nested scene instances. */
export function importGodotProjectText(files:Record<string,string|number[]>,plan:ProjectResourcePlan):void{
 const building=new Set<string>(),built=new Set<string>();let totalNodes=0;
 function load(path:string,depth=0):void{
  if(built.has(path))return;if(depth>24||building.has(path))fail('Cyclic/deep scene dependency '+path);const source=files[path];if(typeof source!=='string'||source.length>262144)fail('Missing or oversized text resource '+path);
  building.add(path);const sections=parseSceneText(source,{worldValues:true}),first=sections[0];if(!first||!['gd_scene','gd_resource'].includes(first.name)||first.attributes.format!==3)fail('Expected Godot format 3');
  for(const key of Object.keys(first.attributes))if(!['format','load_steps','uid',...(first.name==='gd_resource'?['type']:[])].includes(key))fail('Unsupported scene header '+key);if(Object.keys(first.properties).length)fail('Properties before a node/resource body');
  const refs=new Map<string,string>(),subrefs=new Map<string,string>();
  const define=(id:string,definition:any)=>{if(Object.hasOwn(plan.definitions,id))fail('Duplicate resource '+id);plan.definitions[id]=definition;};
  for(const section of sections){
   if(Object.hasOwn(section.properties,'script')||section.attributes.type==='Script')fail('Scene scripts require TSX behavior');
   if(section.name==='ext_resource'){
    if(Object.keys(section.properties).length||Object.keys(section.attributes).some(k=>!['type','path','id','uid'].includes(k)))fail('Unsupported external resource header');
    const id=String(section.attributes.id),target=pathOf(section.attributes.path,path);if(refs.has(id))fail('Duplicate external id');
    if(target.endsWith('.tres')||target.endsWith('.tscn'))load(target,depth+1);
    if(!Object.hasOwn(plan.models??{},target)&&!Object.hasOwn(plan.images,target)&&!Object.hasOwn(plan.sounds,target)&&!Object.hasOwn(plan.definitions,target)&&!Object.hasOwn(plan.scenes,target))fail('Unknown external resource '+target);
    const actual=(plan.models?.[target]||plan.scenes[target])?'PackedScene':plan.images[target]?'Texture2D':plan.sounds[target]?'AudioStream':plan.definitions[target]?.type;
    const declared=section.attributes.type;
    if(typeof declared!=='string'||typeof section.attributes.id!=='string'||!(declared===actual||declared==='Mesh'&&['BoxMesh','SphereMesh','CylinderMesh','PlaneMesh','QuadMesh'].includes(actual)||declared==='Texture2D'&&['CurveTexture','GradientTexture1D','GradientTexture2D','AtlasTexture'].includes(actual)))fail('External resource type mismatch '+target);
    refs.set(id,target);
   }else if(section.name==='sub_resource'){
    if(Object.keys(section.attributes).some(k=>!['type','id'].includes(k)))fail('Unsupported subresource header');
    if(typeof section.attributes.id!=='string'||typeof section.attributes.type!=='string')fail('Subresource requires type and id');const local=String(section.attributes.id);if(subrefs.has(local))fail('Duplicate subresource id');subrefs.set(local,path+'#'+local);
   }
  }
  const convert=(v:any):any=>{if(v&&typeof v==='object'&&['external-resource','sub-resource'].includes(v.kind)){const id=(v.kind==='external-resource'?refs:subrefs).get(v.id);if(!id)fail('Unresolved resource id '+v.id);return id;}if(Array.isArray(v))return v.map(convert);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([key,value])=>[key,convert(value)]));return v;};
  for(const section of sections.filter(s=>s.name==='sub_resource'))define(subrefs.get(String(section.attributes.id))!,resourceDefinition(String(section.attributes.type),Object.fromEntries(Object.entries(section.properties).map(([k,v])=>[k,convert(v)]))));
  if(first.name==='gd_resource'){
   const body=sections.filter(s=>s.name==='resource');if(body.length!==1||sections.some(s=>!['gd_resource','resource','ext_resource','sub_resource'].includes(s.name)))fail('Unsupported resource sections');
   define(path,resourceDefinition(String(first.attributes.type),Object.fromEntries(Object.entries(body[0]!.properties).filter(([key])=>key!=='resource_name').map(([k,v])=>[k,convert(v)]))));
  }else{
   if(sections.some(s=>!['gd_scene','ext_resource','sub_resource','node'].includes(s.name)))fail('Unsupported scene sections');const nodes=new Map<string,SceneNodeSpec>();let root:SceneNodeSpec|undefined;
   for(const section of sections.filter(s=>s.name==='node')){
    if(++totalNodes>2048)fail('Scene node budget exceeded');for(const field of Object.keys(section.attributes))if(!['name','type','parent','instance','owner','index'].includes(field))fail('Unsupported node attribute '+field);
    const name=String(section.attributes.name);let spec:SceneNodeSpec;
    if(section.attributes.instance){const target=convert(section.attributes.instance),instance=plan.scenes[target];if(!instance)fail('Instance must refer to a managed scene');spec=JSON.parse(JSON.stringify(instance));spec.props={...spec.props,name};}
    else spec={type:String(section.attributes.type),props:{name},children:[]};
    const schema=getHostSchema(spec.type,'showcase-v1');
    const sides=['left','top','right','bottom'],nativeLayout=Object.keys(section.properties).some(k=>/^(anchor_(left|top|right|bottom)|offset_(left|top|right|bottom))$/.test(k));
    const preset=section.properties.anchors_preset,mode=section.properties.layout_mode;
    if(schema.properties.layout&&(nativeLayout||typeof preset==='number'&&preset>=0)){
     const presets=[[0,0,0,0],[1,0,1,0],[0,1,0,1],[1,1,1,1],[0,.5,0,.5],[.5,0,.5,0],[1,.5,1,.5],[.5,1,.5,1],[.5,.5,.5,.5],[0,0,0,1],[0,0,1,0],[1,0,1,1],[0,1,1,1],[.5,0,.5,1],[0,.5,1,.5],[0,0,1,1]];
     const activePreset=typeof preset==='number'&&preset>=0&&(mode===undefined||mode===1||mode===3)?presets[preset]:undefined;
     const prior=(spec.props!.initial as any)?.layout??(spec.props as any).layout;
     const layout={anchors:sides.map((side,i)=>section.properties['anchor_'+side]??activePreset?.[i]??prior?.anchors?.[i]??0),offsets:sides.map((side,i)=>section.properties['offset_'+side]??prior?.offsets?.[i]??0)};
     delete spec.props!.layout;spec.props!.initial={...(spec.props!.initial as object??{}),layout};
     if(activePreset){spec.props!.growHorizontal=[1,0,1,0,1,2,0,2,2,1,2,0,2,2,2,2][preset as number];spec.props!.growVertical=[1,1,0,0,2,1,2,0,2,2,1,2,0,2,2,2][preset as number];}
    }

    if(spec.type==='MenuButton'&&Object.hasOwn(section.properties,'item_count')){const count=section.properties.item_count;if(typeof count!=='number'||!Number.isInteger(count)||count<0||count>256)fail('Invalid menu item count');spec.props!.items=Array.from({length:count},()=>({text:''}));}
    if(spec.type==='ItemList'&&Object.hasOwn(section.properties,'item_count')){const count=section.properties.item_count;if(typeof count!=='number'||!Number.isInteger(count)||count<0||count>1024)fail('Invalid list item count');spec.props!.items=Array.from({length:count},()=>({text:''}));}
    for(const [key,value] of Object.entries(section.properties)){
     if(schema.properties.layout){if(/^(anchor_(left|top|right|bottom)|offset_(left|top|right|bottom))$/.test(key))continue;if(key==='layout_mode'||key==='anchors_preset'){const max=key==='layout_mode'?3:15;if(typeof value!=='number'||!Number.isInteger(value)||value<(key==='anchors_preset'?-1:0)||value>max)fail('Invalid layout hint');continue;}}

     if(spec.type==='MenuButton'){if(key==='item_count')continue;const match=/^popup\/item_(\d+)\/(id|text|icon|disabled|checkable|checked|separator)$/.exec(key);if(match){const items=spec.props!.items as any[],index=Number(match[1]);if(!items||index>=items.length)fail('Menu item outside declared count');if(match[2]==='checkable'){if(value!==0&&value!==1)fail('Only checkbox menu items are supported');items[index].checkable=value===1;}else items[index][match[2]!]=match[2]==='icon'&&value!==null?{asset:convert(value)}:convert(value);continue;}}
     if(spec.type==='ItemList'){if(key==='item_count')continue;const match=/^item_(\d+)\/(text|icon|disabled|selectable)$/.exec(key);if(match){const items=spec.props!.items as any[],index=Number(match[1]);if(!items||index>=items.length)fail('List item outside declared count');items[index][match[2]!]=match[2]==='icon'&&value!==null?{asset:convert(value)}:convert(value);continue;}}

     const prop=Object.values(schema.properties).find(p=>p.nativeName===key||p.accessName===key);if(!prop)fail('Unsupported '+spec.type+'.'+key);
     const converted=convert(value);spec.props![prop.publicName]=value&&typeof value==='object'&&'kind' in value?{asset:converted}:converted;
    }
    if(section.attributes.parent===undefined){if(root)fail('Multiple scene roots');root=spec;nodes.set('.',spec);}
    else {const parent=String(section.attributes.parent),parentNode=nodes.get(parent);if(!parentNode)fail('Parent must precede its child');const key=parent==='.'?name:parent+'/'+name;if(nodes.has(key))fail('Duplicate node path');parentNode.children??=[];parentNode.children.push(spec);nodes.set(key,spec);}
   }
   if(!root)fail('Scene has no root');if(Object.hasOwn(plan.scenes,path))fail('Duplicate scene '+path);plan.scenes[path]=root;
  }
  building.delete(path);built.add(path);
 }
 for(const path of Object.keys(files))if(path.endsWith('.tscn')||path.endsWith('.tres'))load(path);
}
