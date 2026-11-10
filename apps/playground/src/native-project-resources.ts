import {importNativeGlb} from './native-glb';
import {materializeResourcePlan,type ProjectResourcePlan} from './project-resources';
/** Trusted application adapter. User source receives resource ids, never native resources. */
export function installProjectResources(G:any,plan:ProjectResourcePlan,reserved:readonly string[]=[]){
 const output=materializeResourcePlan(plan,reserved),written:string[]=[];
 const invoke=(o:any,n:string,...args:any[]) => (o[n]??o[n.replace(/_([a-z])/g,(_:string,c:string)=>c.toUpperCase())]).apply(o,args);
 const physical=(path:string)=>String(invoke(G.ProjectSettings,'globalize_path',path));
 let disposed=false,created=false;
 const cleanup={files:0,removed:0,failures:0,directoryRemoved:false};
 const dispose=()=>{if(disposed)return cleanup;disposed=true;cleanup.files=written.length;for(const path of written.reverse()){if(invoke(G.DirAccess,'remove_absolute',path)===0)cleanup.removed++;else cleanup.failures++;}if(created){cleanup.directoryRemoved=invoke(G.DirAccess,'remove_absolute',physical(output.directory.slice(0,-1)))===0;if(!cleanup.directoryRemoved)cleanup.failures++;}return cleanup;};
 try{
  if(Object.keys(output.meshes).length||Object.keys(output.files).length||Object.keys(output.models).length||Object.keys(output.ogg).length){const error=invoke(G.DirAccess,'make_dir_recursive_absolute',physical(output.directory));if(error!==0)throw Error('E_RESOURCE_WRITE: cannot create resource directory ('+error+')');created=true;}
  for(const [name,text] of Object.entries(output.files)){
   const path=physical(output.directory+name),file=invoke(G.FileAccess,'open',path,2);
   if(!file)throw Error('E_RESOURCE_WRITE: cannot write '+name);written.push(path);
   try{invoke(file,'store_string',text);invoke(file,'flush');if(invoke(file,'get_error')!==0)throw Error('E_RESOURCE_WRITE: failed '+name);}finally{invoke(file,'close');}
  }
  for(const [id,definition]of Object.entries(output.meshes)){
   const mesh=new G.ArrayMesh();
   for(const surface of definition.surfaces){
    const arrays=new G.GArray();invoke(arrays,'resize',13);
    const vectors=(values:any[],dimensions:number)=>{const data=dimensions===2?new G.PackedVector2Array():new G.PackedVector3Array();for(const v of values)invoke(data,'push_back',dimensions===2?new G.Vector2(v.x,v.y):new G.Vector3(v.x,v.y,v.z));return data;};
    invoke(arrays,'set',0,vectors(surface.vertices,3));if(surface.normals)invoke(arrays,'set',1,vectors(surface.normals,3));if(surface.uvs)invoke(arrays,'set',4,vectors(surface.uvs,2));
    if(surface.indices){const indices=new G.PackedInt32Array();for(const value of surface.indices)invoke(indices,'push_back',value);invoke(arrays,'set',12,indices);}
    invoke(mesh,'add_surface_from_arrays',3,arrays);
    if(surface.material){const material=invoke(G.ResourceLoader,'load',output.assets[surface.material]!.uri);if(!material)throw Error('E_MESH_IMPORT: missing surface material');invoke(mesh,'surface_set_material',invoke(mesh,'get_surface_count')-1,material);}
   }
   if(invoke(mesh,'get_surface_count')!==definition.surfaces.length)throw Error('E_MESH_IMPORT: native mesh rejected arrays');const path=physical(output.assets[id]!.uri);written.push(path);if(invoke(G.ResourceSaver,'save',mesh,path,2)!==0)throw Error('E_MESH_IMPORT: save failed');
  }
  let generatedBytes=0;
  for(const [id,bytes]of Object.entries(output.models)){const path=physical(output.assets[id]!.uri);written.push(path);importNativeGlb(G,bytes,physical(output.directory),path);}
  for(const [id,bytes]of Object.entries(output.ogg)){const data=new G.PackedByteArray();invoke(data,'resize',bytes.length);bytes.forEach((value,i)=>invoke(data,'set',i,value));const audio=invoke(G.AudioStreamOggVorbis,'load_from_buffer',data);if(!audio)throw Error('E_OGG_IMPORT: decoder rejected audio');const path=physical(output.assets[id]!.uri);written.push(path);if(invoke(G.ResourceSaver,'save',audio,path,2)!==0)throw Error('E_OGG_IMPORT: save failed');}
  for(const path of written){const file=invoke(G.FileAccess,'open',path,1);if(!file)throw Error('E_RESOURCE_WRITE: missing generated resource');try{generatedBytes+=Number(invoke(file,'get_length'));}finally{invoke(file,'close');}}
  if(generatedBytes>32*1024*1024)throw Error('E_RESOURCE_WRITE: generated resources exceed 32 MB');
  return {assets:output.assets,scenes:output.scenes,dispose};
 }catch(error){dispose();throw error;}
}
