import {validateGlb} from './glb';
/** Runs only in the trusted native host, preserving native skins, skeletons and animation libraries. */
export function importNativeGlb(G:any,bytes:number[],directory:string,path:string):void{
 validateGlb(bytes);const invoke=(o:any,n:string,...a:any[])=>(o[n]??o[n.replace(/_([a-z])/g,(_:string,c:string)=>c.toUpperCase())]).apply(o,a);
 const packedBytes=new G.PackedByteArray();invoke(packedBytes,'resize',bytes.length);for(let i=0;i<bytes.length;i++)invoke(packedBytes,'set',i,bytes[i]);
 const document=new G.GLTFDocument(),state=new G.GLTFState();
 const error=invoke(document,'append_from_buffer',packedBytes,directory,state,0);if(error!==0)throw Error('E_GLB_IMPORT: glTF parser rejected model ('+error+')');
 const scene=invoke(document,'generate_scene',state,30,false,false);if(!scene)throw Error('E_GLB_IMPORT: cannot generate model scene');
 try{const packed=new G.PackedScene();const error=invoke(packed,'pack',scene);if(error!==0)throw Error('E_GLB_IMPORT: cannot pack generated scene');const saved=invoke(G.ResourceSaver,'save',packed,path,2);if(saved!==0)throw Error('E_GLB_IMPORT: cannot save generated scene ('+saved+')');}finally{invoke(scene,'free');}
}
