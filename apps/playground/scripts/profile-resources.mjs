import {getEngineProfile} from '../../../scripts/release/engine-profiles.mjs';
import {sitePayloads} from './site-evidence.mjs';
import {isDerivedDeliveryMetadata} from './site-delivery-state.mjs';

export const DEMO_API_VERSION=1;
export const TWO_D_ASSET_IDS=Object.freeze([
 'tile-gem','tile-godot','tile-grass','tile-kenney','tile-spikes',
 'light','floor','godotea','occluder','shader-0','shader-1','shader-2',
 'sound-jump','sound-land','sound-coin',
]);
export function profileCatalog(catalog,runtimeProfile='full-engine-v1'){
 const profile=getEngineProfile(runtimeProfile),selected=new Set(profile.demoIds);
 const result=catalog.filter(demo=>selected.has(demo.id));
 if(result.length!==selected.size)throw Error('E_DEMO_PROFILE: catalog does not contain every registered demo');
 return result;
}
export function assertResourceManifest({assets,models},runtimeProfile){
 getEngineProfile(runtimeProfile);
 if(!assets||typeof assets!=='object'||Array.isArray(assets)||!models||typeof models!=='object'||Array.isArray(models))throw Error('E_DEMO_RESOURCES: invalid generated manifest');
 for(const [id,asset]of Object.entries(assets)){
  if(!asset||typeof asset.uri!=='string'||!asset.uri.startsWith('res://assets/')||asset.uri.includes('..')||typeof asset.type!=='string')throw Error('E_DEMO_RESOURCES: invalid resource '+id);
 }
 if(runtimeProfile==='engine-2d-v1'){
  if(Object.keys(models).length)throw Error('E_DEMO_RESOURCES: 2D resource pack contains models');
  if(JSON.stringify(Object.keys(assets).sort())!==JSON.stringify([...TWO_D_ASSET_IDS].sort()))throw Error('E_DEMO_RESOURCES: incomplete or unexpected 2D asset set');
  if(Object.values(assets).some(asset=>/3D|Mesh|Environment/.test(asset.type)))throw Error('E_DEMO_RESOURCES: 2D resource pack contains 3D resources');
 }
}

/** The entry manifest hashes all raw site payloads, including editor code and
 * resource receipts. Transport sidecars are sealed later by the site receipt. */
export async function collectManifestPayloads(directory){
 return Object.fromEntries(Object.entries(await sitePayloads(directory)).filter(([name])=>name!=='manifest.json'&&!isDerivedDeliveryMetadata(name)&&!/\.(?:gz|br)$/.test(name)));
}
