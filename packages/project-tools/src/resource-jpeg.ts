import {decode} from 'jpeg-js';
import {ProjectToolError} from './errors.js';
import {inspectJpeg} from './resource-binary.js';
import type {ImageDecoder} from './resource-converters.js';

/** The same pinned software codec runs in Node and browser Workers. Neither
 * canvas color conversion nor platform JPEG decoders enter this identity. */
export const deterministicJpegDecoder:ImageDecoder=Object.freeze({
 id:'jpeg-js-rgba',version:'0.4.4-strict-mp16-memory128-v1',deterministic:true,
 async decode(bytes:Uint8Array,mime:'image/png'|'image/jpeg'){
  if(mime!=='image/jpeg')throw new ProjectToolError('E_RESOURCE_JPEG_DECODE','The JPEG codec does not decode other image formats');
  const size=inspectJpeg(bytes);
  try {
   const image=decode(bytes,{useTArray:true,formatAsRGBA:true,tolerantDecoding:false,maxResolutionInMP:16,maxMemoryUsageInMB:128});
   if(image.width!==size.width||image.height!==size.height||image.data.byteLength!==size.width*size.height*4)throw Error('JPEG codec returned inconsistent pixels');
   return {width:image.width,height:image.height,rgba:image.data};
  }catch(error){throw new ProjectToolError('E_RESOURCE_JPEG_DECODE','JPEG codec rejected its structural, pixel or memory limits',String(error));}
 },
});
