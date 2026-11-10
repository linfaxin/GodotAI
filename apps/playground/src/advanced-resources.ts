const fail=(message:string):never=>{throw Error('E_ADVANCED_RESOURCE: '+message);};
const record=(v:any):Record<string,any>=>{if(!v||typeof v!=='object'||Array.isArray(v))fail('Expected object');return v;};
const fields=(v:any,allowed:string[])=>{for(const key of Object.keys(record(v)))if(!allowed.includes(key))fail('Unsupported field '+key);};
const string=(v:any):string=>{if(typeof v!=='string'||!v.length||v.length>128||/[\x00-\x1f]/.test(v))fail('Invalid name');return v;};
const number=(v:any,min=-1e6,max=1e6):number=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail('Invalid number');return v;};
const list=(v:any,max=256):any[]=>{if(!Array.isArray(v)||v.length>max)fail('Expected bounded list');return v;};
const name=(v:any):string=>{const n=string(v);if(!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(n))fail('Names must be simple identifiers');return n;};
const q=(v:string)=>JSON.stringify(v);
function vector(v:any):number[]{fields(v,['x','y','z']);return ['x','y','z'].map(k=>number(v[k]));}
export function transformText(value:any):string{
 if(!value)return 'Transform3D(1,0,0,0,1,0,0,0,1,0,0,0)';fields(value,['basis','origin']);fields(value.basis,['x','y','z']);const x=vector(value.basis.x),y=vector(value.basis.y),z=vector(value.basis.z),origin=vector(value.origin);
 const determinant=x[0]!*(y[1]!*z[2]!-y[2]!*z[1]!)-y[0]!*(x[1]!*z[2]!-x[2]!*z[1]!)+z[0]!*(x[1]!*y[2]!-x[2]!*y[1]!);if(Math.abs(determinant)<1e-10)fail('Rest/bind transform must be invertible');return `Transform3D(${[...x,...y,...z,...origin].join(',')})`;
}
export const advancedResourceTypes=['SkeletonProfile','Skin','AnimationNodeBlendTree','AnimationNodeStateMachine','AnimationNodeBlendSpace1D','AnimationNodeBlendSpace2D'];
export function serializeAdvancedResource(def:any,reference:(id:unknown,types:string[])=>string):{sub:string[];body:string[]}{
 const sub:string[]=[],body:string[]=[];const type=def.type;
 if(type==='SkeletonProfile'){
  fields(def,['type','bones']);const bones=list(def.bones),names=new Set<string>();body.push('bone_size = '+bones.length);
  bones.forEach((bone,i)=>{fields(bone,['name','parent','rest']);const n=name(bone.name),parent=bone.parent===undefined?'':name(bone.parent);if(names.has(n)||(parent&&!names.has(parent)))fail('Bones must have unique names and preceding parents');names.add(n);body.push(`bones/${i}/bone_name = &${q(n)}`,`bones/${i}/bone_parent = &${q(parent)}`,`bones/${i}/reference_pose = ${transformText(bone.rest)}`);});
 }else if(type==='Skin'){
  fields(def,['type','binds']);const binds=list(def.binds);body.push('bind_count = '+binds.length);binds.forEach((bind,i)=>{fields(bind,['bone','pose']);const bone=number(bind.bone,0,255);if(!Number.isInteger(bone))fail('Bind bone must be an index');body.push(`bind/${i}/bone = ${bone}`,`bind/${i}/pose = ${transformText(bind.pose)}`);});
 }else{
  const node=(spec:any):string=>{
   if(spec.asset!==undefined){fields(spec,['asset']);return reference(spec.asset,['AnimationNodeBlendTree','AnimationNodeStateMachine','AnimationNodeBlendSpace1D','AnimationNodeBlendSpace2D']);}
   fields(spec,['type','animation']);const types:Record<string,string>={animation:'AnimationNodeAnimation',blend2:'AnimationNodeBlend2',add2:'AnimationNodeAdd2',timeScale:'AnimationNodeTimeScale',timeSeek:'AnimationNodeTimeSeek',oneShot:'AnimationNodeOneShot'};
   const native=types[spec.type];if(!native)fail('Unsupported animation node '+spec.type);const id='tree_node_'+sub.length;sub.push(`[sub_resource type=${q(native)} id=${q(id)}]`+(spec.type==='animation'?`\nanimation = &${q(string(spec.animation))}`:''));return `SubResource(${q(id)})`;
  };
  if(type==='AnimationNodeBlendTree'){
   fields(def,['type','nodes','connections']);const nodes=record(def.nodes),names=Object.keys(nodes);if(names.length>64||Object.hasOwn(nodes,'output'))fail('Invalid blend tree nodes');const edges=new Map<string,string[]>(),inputs=new Set<string>();for(const n of names)body.push(`nodes/${name(n)}/node = ${node(record(nodes[n]))}`);
   const connections=list(def.connections,128).flatMap(edge=>{const [target,index,source]=list(edge,3);if(edge.length!==3||target!=='output'&&!Object.hasOwn(nodes,target)||!Object.hasOwn(nodes,source)||target===source)fail('Invalid blend connection');const arity=target==='output'?1:(nodes[target].asset!==undefined?0:({animation:0,blend2:2,add2:2,timeScale:1,timeSeek:1,oneShot:2} as Record<string,number>)[nodes[target].type]);if(!Number.isInteger(index)||index<0||index>=arity!)fail('Invalid blend input');const key=target+':'+index;if(inputs.has(key))fail('Duplicate blend input');inputs.add(key);edges.set(target,[...(edges.get(target)??[]),source]);return [q(target),String(index),q(source)];});
   const visiting=new Set<string>(),done=new Set<string>();function visit(n:string){if(visiting.has(n))fail('Cyclic blend tree');if(done.has(n))return;visiting.add(n);for(const child of edges.get(n)??[])visit(child);visiting.delete(n);done.add(n);}for(const n of names)visit(n);if(!inputs.has('output:0'))fail('Blend tree output must be connected');const outputs=new Set<string>();for(const sources of edges.values())for(const source of sources){if(outputs.has(source))fail('Blend node output cannot be reused');outputs.add(source);}for(const n of outputs){const arity=nodes[n].asset!==undefined?0:({animation:0,blend2:2,add2:2,timeScale:1,timeSeek:1,oneShot:2} as Record<string,number>)[nodes[n].type]!;for(let i=0;i<arity;i++)if(!inputs.has(n+':'+i))fail('Blend node input must be connected');}body.push('node_connections = ['+connections.join(',')+']');
  }else if(type==='AnimationNodeStateMachine'){
   fields(def,['type','states','transitions','entry','stateMachineType']);if(def.stateMachineType!==undefined){const kind=number(def.stateMachineType,0,2);if(!Number.isInteger(kind))fail('Invalid state machine type');body.push('state_machine_type = '+kind);}const states=record(def.states),names=Object.keys(states);if(!names.length||names.length>64)fail('Invalid state count');for(const n of names){if(['Start','End'].includes(n))fail('Reserved state name');body.push(`states/${name(n)}/node = ${node(record(states[n]))}`);}
   const transitions=def.transitions??[];const listTransitions=[...list(transitions,256)];if(def.entry!==undefined){if(!Object.hasOwn(states,def.entry))fail('Unknown entry state');listTransitions.unshift({from:'Start',to:def.entry,auto:true});}
   const connections=listTransitions.flatMap(t=>{fields(t,['from','to','fade','auto','atEnd','condition']);const from=name(t.from),to=name(t.to);if(from!=='Start'&&!Object.hasOwn(states,from)||to!=='End'&&!Object.hasOwn(states,to)||from===to)fail('Invalid state transition');if(t.auto!==undefined&&typeof t.auto!=='boolean'||t.atEnd!==undefined&&typeof t.atEnd!=='boolean')fail('Invalid transition mode');if(t.condition!==undefined)name(t.condition);const id='transition_'+sub.length;sub.push(`[sub_resource type="AnimationNodeStateMachineTransition" id=${q(id)}]\nxfade_time = ${number(t.fade??0,0,60)}\nadvance_mode = ${t.auto?2:1}\nswitch_mode = ${t.atEnd?2:0}${t.condition===undefined?'':'\nadvance_condition = &'+q(t.condition)}`);return [q(from),q(to),`SubResource(${q(id)})`];});body.push('transitions = ['+connections.join(',')+']');
  }else if(type==='AnimationNodeBlendSpace1D'||type==='AnimationNodeBlendSpace2D'){
   fields(def,['type','points','min','max']);const points=list(def.points,64);if(points.length<1)fail('Blend space requires points');const two=type.endsWith('2D');points.forEach((point,i)=>{fields(point,['position','node']);body.push(`blend_point_${i}/node = ${node(record(point.node))}`);const position=two?(fields(point.position,['x','y']),`Vector2(${number(point.position.x)},${number(point.position.y)})`):String(number(point.position));body.push(`blend_point_${i}/pos = ${position}`);});
   const bound=(value:any,fallback:number):number[]=>{if(value===undefined)return two?[fallback,fallback]:[fallback];if(two){fields(value,['x','y']);return [number(value.x),number(value.y)];}return [number(value)];};
   const min=bound(def.min,-1),max=bound(def.max,1);if(min.some((value,i)=>value>=max[i]!))fail('Blend space min must precede max');const format=(values:number[])=>two?`Vector2(${values.join(',')})`:String(values[0]);
   // Godot clamps each bound against the other setter's current value. Expand
   // the upper bound first so disjoint or mixed-axis ranges survive text loading.
   body.push('max_space = '+format(max.map(value=>Math.max(1,value))),'min_space = '+format(min),'max_space = '+format(max));
  }else fail('Unsupported animation resource');
 }
 return {sub,body};
}
