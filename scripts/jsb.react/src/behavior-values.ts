import {exact,invariant,ERROR_CODES} from './contracts';
import {validateValue} from './schema/codecs';
import {encodeNodeCapability} from './node-capability';
export function behaviorValue(codec:string,value:unknown,path:string):any{
 if(codec==='nodeHandle')return encodeNodeCapability(value);
 if(codec==='shaderValue'){
  if(typeof value==='boolean'||typeof value==='number')return validateValue(typeof value==='boolean'?'boolean':'number',value,path,{minimum:-1e8,maximum:1e8});
  invariant(!!value&&typeof value==='object',ERROR_CODES.VALUE,'Expected typed shader value',path);const v=value as any;
  if(v.kind==='asset'){const ref=validateValue('assetRef',value,path,{resourceTypes:['Texture2D','ImageTexture','CompressedTexture2D','AtlasTexture','GradientTexture1D','GradientTexture2D','CurveTexture']}) as any;invariant(ref.scope!=='instance',ERROR_CODES.VALUE,'Shader textures must be shared static assets',path);return ref;}
  return validateValue('r'in v?'color':'z'in v?'vector3':'vector2',value,path);
 }
 const appearance=codec==='appearanceTweenPlan',plan=exact(value,['steps'],['loops'],path);invariant(Array.isArray(plan.steps)&&plan.steps.length>0&&plan.steps.length<=128,ERROR_CODES.VALUE,'Expected 1..128 tween steps',path);let duration=0;
 const steps=plan.steps.map((item:unknown)=>{const step=exact(item,appearance?['property','to','duration']:['to','duration'],['delay','transition','ease','parallel'],path);if(appearance)invariant(['modulate','selfModulate','color','defaultColor'].includes(step.property as string),ERROR_CODES.VALUE,'Unsupported appearance tween property',path);const seconds=validateValue('number',step.duration,path,{minimum:0,maximum:86400}) as number,delay=validateValue('number',step.delay??0,path,{minimum:0,maximum:86400}) as number;duration+=seconds+delay;const to=validateValue(appearance?'color':'number',step.to,path) as any;if(appearance)invariant(to.r>=-16&&to.r<=16&&to.g>=-16&&to.g<=16&&to.b>=-16&&to.b<=16&&to.a>=0&&to.a<=1,ERROR_CODES.VALUE,'Appearance color out of range',path);return Object.freeze([appearance?step.property:'value',to,seconds,delay,validateValue('integer',step.transition??0,path,{minimum:0,maximum:11}),validateValue('integer',step.ease??0,path,{minimum:0,maximum:3}),validateValue('boolean',step.parallel??false)]);});
 invariant(duration>0,ERROR_CODES.VALUE,'Tween must consume time',path);return Object.freeze([Object.freeze([validateValue('integer',plan.loops??1,path,{minimum:0,maximum:1000000})]),...steps]);
}
