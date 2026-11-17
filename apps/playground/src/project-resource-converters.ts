import {createBrowserResourceConverters,type ImageDecoder} from '@godot-js/project-tools/resource-converters';
import {createBrowserResourceExecutionCache} from './resource-cache';
let registry:ReturnType<typeof createBrowserResourceConverters>|undefined;

/** Runs in the compiler Worker. No native editor or host DOM is involved. */
export function projectResourceConverters(){
 if(registry)return registry;
 // The canvas decoder serves the explicit legacy ImageTexture recipe only.
 // Default JPEG CTEX uses the same pinned software codec as the Node adapter.
 let decoder:ImageDecoder|undefined;
 if(typeof createImageBitmap==='function'&&typeof OffscreenCanvas==='function')decoder={
  id:'browser-createImageBitmap-rgba',version:'2/'+navigator.userAgent,deterministic:true,
  async decode(bytes,mime){
   const copy=new Uint8Array(bytes);
   const image=await createImageBitmap(new Blob([copy.buffer],{type:mime}),{premultiplyAlpha:'none',colorSpaceConversion:'none'});
   try{
    if(image.width*image.height>16*1024*1024)throw Error('E_RESOURCE_IMAGE_BUDGET');
    const canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d',{willReadFrequently:true});
    if(!context)throw Error('E_RESOURCE_IMAGE_CONTEXT');
    context.drawImage(image,0,0);const pixels=context.getImageData(0,0,image.width,image.height);
    return {width:image.width,height:image.height,rgba:new Uint8Array(pixels.data)};
   }finally{image.close();}
  },
 };
 return registry=createBrowserResourceConverters(decoder,{cache:createBrowserResourceExecutionCache()});
}
