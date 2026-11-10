const fail=(m:string):never=>{throw Error('E_PARITY_RESOURCE: '+m);};
const fields=(v:any,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('Unexpected fields');};
const n=(v:any,min=-1e6,max=1e6)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail('Invalid number');return v as number;};
const bool=(v:any)=>{if(typeof v!=='boolean')fail('Expected boolean');return String(v);};
const name=(v:any)=>{if(typeof v!=='string'||!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(v)||v==='Master')fail('Invalid scoped bus name');return v as string;};
const q=JSON.stringify;
export function serializeParityResource(def:any):{body:string[];sub:string[]}{
 const body:string[]=[],sub:string[]=[];
 if(def.type==='PhysicsMaterial'){fields(def,['type','properties']);fields(def.properties??{},['friction','bounce','rough','absorbent']);for(const [key,value]of Object.entries(def.properties??{}))body.push(key+' = '+(['rough','absorbent'].includes(key)?bool(value):n(value,0,1)));}
 else if(def.type==='AudioBusLayout'){
  fields(def,['type','buses']);if(!Array.isArray(def.buses)||def.buses.length<1||def.buses.length>16)fail('Expected 1..16 audio buses');const names=new Set<string>();
  def.buses.forEach((bus:any,index:number)=>{fields(bus,['name','send','volumeDb','mute','solo','effects']);const logical=name(bus.name);if(names.has(logical))fail('Duplicate bus');const send=bus.send??'Master';if(send!=='Master'&&!names.has(send))fail('Bus sends must target Master or a preceding bus');names.add(logical);body.push(`bus/${index}/name = &${q(logical)}`,`bus/${index}/send = &${q(send)}`,`bus/${index}/volume_db = ${n(bus.volumeDb??0,-80,12)}`,`bus/${index}/mute = ${bool(bus.mute??false)}`,`bus/${index}/solo = ${bool(bus.solo??false)}`);
   const effects=bus.effects??[];if(!Array.isArray(effects)||effects.length>8)fail('Too many bus effects');effects.forEach((effect:any,i:number)=>{fields(effect,['type','properties','enabled']);const rules:Record<string,Record<string,[number,number]>>={AudioEffectReverb:{room_size:[0,1],damping:[0,1],spread:[0,1],dry:[0,1],wet:[0,1],predelay_msec:[0,500]},AudioEffectLowPassFilter:{cutoff_hz:[20,20000],resonance:[0,1],gain:[0,4],db:[0,3]},AudioEffectCompressor:{threshold:[-60,0],ratio:[1,48],gain:[-60,24],attack_us:[20,2000],release_ms:[20,2000],mix:[0,1]},AudioEffectLimiter:{ceiling_db:[-20,0],threshold_db:[-30,0],soft_clip_db:[0,6],soft_clip_ratio:[1,20]}};const rule=rules[effect.type];if(!rule)fail('Unsupported bus effect');fields(effect.properties??{},Object.keys(rule));const id='bus_effect_'+sub.length;sub.push(`[sub_resource type=${q(effect.type)} id=${q(id)}]\n`+Object.entries(effect.properties??{}).map(([key,value])=>key+' = '+(()=>{const checked=n(value,...rule[key]!);if(key==='db'&&!Number.isInteger(checked))fail('Filter db must be an integer enum');return checked;})()).join('\n'));body.push(`bus/${index}/effect/${i}/effect = SubResource(${q(id)})`,`bus/${index}/effect/${i}/enabled = ${bool(effect.enabled??true)}`);});
  });
 }else fail('Unsupported resource');return {body,sub};
}
