/** Tooling routes, not a whitelist of engine classes. `directApi` names a
 * native API; its presence in a release must still be checked against that
 * release's captured API. It does not assert that an editor importer runs. */
export interface ResourceFormatCapability {
 id:string;extensions:readonly string[];
 directApi:readonly string[];
 resourceLoader:'native'|'imported-cache';
 browserConverters:readonly string[];
 parameters:readonly string[];
 target:string;
 limitations:string;
}
export const RESOURCE_FORMATS:readonly ResourceFormatCapability[]=Object.freeze(([
 {id:'png',extensions:['png'],directApi:['Image.load_png_from_buffer','ImageTexture.create_from_image'],resourceLoader:'imported-cache',browserConverters:['godotjs/png-ctex','godotjs/image-rgba'],parameters:['mipmaps=false'],target:'Godot 4.6.1 CTEX v1 CompressedTexture2D; explicit legacy ImageTexture producer',limitations:'PNG CTEX accepts noninterlaced 8-bit still PNG, validates CRC and deflate, and preserves the compressed source. It changes the observable native texture type; image-rgba remains the explicit legacy route.'},
 {id:'jpeg',extensions:['jpg','jpeg'],directApi:['Image.load_jpg_from_buffer','ImageTexture.create_from_image'],resourceLoader:'imported-cache',browserConverters:['godotjs/jpeg-ctex','godotjs/image-rgba'],parameters:['mipmaps=false'],target:'Godot 4.6.1 CTEX v1; jpeg-js 0.4.4 + fflate 0.8.2 PNG',limitations:'Default browser and Node producers share pinned software decoding and fixed deflate settings for 8-bit grayscale/RGB JPEG. SOF budgets precede decode; codec allocations are limited to 128 MiB and 16 MP. Output is CompressedTexture2D. Explicit image-rgba keeps ImageTexture semantics; the old stored PNG writer remains an explicit versioned producer option.'},
 {id:'svg',extensions:['svg'],directApi:['Image.load_svg_from_buffer','ImageTexture.create_from_image'],resourceLoader:'imported-cache',browserConverters:[],parameters:['native SVG scale'],target:'Native Image API or separately imported texture cache',limitations:'No browser converter is registered. Availability of the native SVG module is release dependent.'},
 {id:'godot-text',extensions:['tscn','tres'],directApi:['ResourceLoader.load'],resourceLoader:'native',browserConverters:[],parameters:[],target:'Godot native text scene/resource',limitations:'Referenced dependencies must be included; editor tool scripts and editor-only classes are not executed as an import step.'},
 {id:'gltf',extensions:['gltf','glb'],directApi:['GLTFDocument.append_from_buffer','GLTFDocument.generate_scene'],resourceLoader:'imported-cache',browserConverters:[],parameters:['native GLTF import flags','base path','external buffers and textures'],target:'Native GLTFDocument API or separately imported PackedScene cache',limitations:'No browser ResourceLoader converter is registered. External URI dependencies and editor import extensions need explicit handling.'},
 {id:'ogg',extensions:['ogg'],directApi:['AudioStreamOggVorbis.load_from_buffer'],resourceLoader:'imported-cache',browserConverters:[],parameters:['native stream options'],target:'Native AudioStreamOggVorbis API or separately imported audio cache',limitations:'No browser ResourceLoader converter is registered. Native Vorbis module availability is release dependent.'},
 {id:'wav',extensions:['wav'],directApi:['AudioStreamWAV.load_from_buffer'],resourceLoader:'imported-cache',browserConverters:['godotjs/wav-pcm','godotjs/wav-pcm-base64'],parameters:['PCM 8/16 bit','mono/stereo','source sample rate'],target:'Godot 4.6.1 RSRC v6 AudioStreamWAV',limitations:'Binary target ABI is explicit. Uncompressed PCM only; no resampling, ADPCM, looping or editor presets. The Base64 text producer is available through an explicit legacy recipe.'},
 {id:'editor-source',extensions:['blend','fbx','dae','obj','psd'],directApi:[],resourceLoader:'imported-cache',browserConverters:[],parameters:['external producer/importer settings'],target:'A separately produced engine resource cache',limitations:'No browser producer is implemented. Blender/FBX/editor plugins are separate format-specific projects; their existing outputs may be preserved without claiming fresh provenance.'},
] satisfies ResourceFormatCapability[]).map(value=>Object.freeze({...value,extensions:Object.freeze(value.extensions),directApi:Object.freeze(value.directApi),browserConverters:Object.freeze(value.browserConverters),parameters:Object.freeze(value.parameters)})));

export function resourceFormat(path:string):ResourceFormatCapability|undefined {
 const extension=/\.([^.\/]+)$/.exec(path)?.[1].toLowerCase();
 return RESOURCE_FORMATS.find(format=>format.extensions.includes(extension??''));
}
/** A recorded symbol set can disprove availability; a match establishes only
 * API presence. Real byte decoding/ResourceLoader acceptance is a separate test. */
export function inspectResourceFormat(path:string,options:{apiSymbols?:ReadonlySet<string>;registeredConverters?:ReadonlySet<string>}={}) {
 const format=resourceFormat(path);if(!format)return undefined;
 return {format,directApi:options.apiSymbols?format.directApi.map(symbol=>({symbol,present:options.apiSymbols!.has(symbol)})):format.directApi.map(symbol=>({symbol,present:undefined})),
  converters:format.browserConverters.filter(id=>options.registeredConverters?.has(id))};
}
