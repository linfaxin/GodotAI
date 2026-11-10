const fail=(message:string):never=>{throw Error('E_REFINEMENT_RESOURCE: '+message);};
export const BATCH_BYTES=33554432,CURVE_BAKE_POINTS=65536;
export function batchBytes(def:any):number {return def.count*((def.dimension===2?8:12)+(def.colors?4:0)+(def.customData?4:0))*4;}
export function estimateCurveBake(def:any):number {
 const d=def.type==='Curve2D'?2:3,points=def.points,interval=def.bakeInterval??(d===2?5:.2);if(!Array.isArray(points)||points.length<2||points.length>4096||typeof interval!=='number'||!Number.isFinite(interval)||interval<.001||interval>1000)fail('Invalid curve points or bake interval');
 const vector=(p:any)=>{if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!(d===2?['x','y']:['x','y','z']).includes(k)))fail('Invalid curve vector');return (d===2?['x','y']:['x','y','z']).map(k=>{const n=p[k];if(typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1e6)fail('Invalid curve coordinate');return n;});};
 const zero=d===2?{x:0,y:0}:{x:0,y:0,z:0},rows=points.map((p:any)=>({p:vector(p.position),i:vector(p.in??zero),o:vector(p.out??zero)}));let length=0;
 for(let k=0;k<rows.length-1+(def.closed?1:0);k++){const a=rows[k%rows.length]!,b=rows[(k+1)%rows.length]!,add=(x:number[],y:number[])=>x.map((n,i)=>n+y[i]!),distance=(x:number[],y:number[])=>Math.hypot(...x.map((n,i)=>n-y[i]!));const c=add(a.p,a.o),e=add(b.p,b.i);length+=distance(a.p,c)+distance(c,e)+distance(e,b.p);}
 const estimate=Math.ceil(4*length/interval+4*(points.length+(d===2&&def.closed?1:0)));if(!Number.isFinite(estimate)||estimate>CURVE_BAKE_POINTS)fail('Curve bake budget exceeded');return estimate;
}
export function canvasAnimationProperties(properties:any):string[]{
 const p=properties??{},out:string[]=[];if(Object.keys(p).some(k=>!['blend_mode','light_mode','particles_animation','particles_anim_h_frames','particles_anim_v_frames','particles_anim_loop'].includes(k)))fail('Unsupported canvas material field');for(const key of ['particles_animation','particles_anim_h_frames','particles_anim_v_frames','particles_anim_loop'])if(Object.hasOwn(p,key)){const value=p[key];if(key.endsWith('_frames')){if(!Number.isInteger(value)||value<1||value>256)fail('Particle sheet dimensions must be 1..256');}else if(typeof value!=='boolean')fail('Invalid particle animation flag');out.push(key+' = '+String(value));}
 if((p.particles_anim_h_frames??1)*(p.particles_anim_v_frames??1)>4096)fail('Particle sheet exceeds 4096 frames');return out;
}
