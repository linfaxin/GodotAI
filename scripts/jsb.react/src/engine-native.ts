/** Direct GodotJS helpers. No legacy ownership bridge or capability profile. */
export function nativeCall(object: any, name: string, ...args: any[]): any {
  const method = object?.[name] ?? object?.[name.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())];
  if (typeof method !== 'function') throw new Error(`E_ENGINE_METHOD: ${name} is unavailable`);
  return method.apply(object, args);
}

export function nativeAlive(godot: any, object: unknown): boolean {
  try { return !!(godot.is_instance_valid ?? godot.isInstanceValid)(object); } catch { return false; }
}

export function nativeIdentity(object: unknown): string {
  return String(nativeCall(object, 'get_instance_id'));
}

export function sequence(value: any): any[] {
  if (Array.isArray(value)) return value;
  const size = Number(nativeCall(value, 'size'));
  const get = value.get_indexed ?? value.getIndexed ?? value.get;
  if (typeof get !== 'function') throw new Error('E_ENGINE_ARRAY: Missing native array accessor');
  return Array.from({length: size}, (_, index) => get.call(value, index));
}

export function field(object: any, name: string): any {
  return typeof object?.get === 'function' ? object.get(name) : object[name];
}

export function signalDescriptions(object:any, publicName:(name:string)=>string): Map<string,string> {
  const result=new Map<string,string>();
  for(const item of sequence(nativeCall(object,'get_signal_list'))){const name=String(field(item,'name'));result.set(name,name);result.set(publicName(name),name);}
  return result;
}

export interface PropertyDescription { nativeName: string; usage: number }
export function propertyDescriptions(object: any, publicName: (name: string) => string): Map<string, PropertyDescription> {
  const result = new Map<string, PropertyDescription>();
  for (const item of sequence(nativeCall(object, 'get_property_list'))) {
    const name = String(field(item, 'name'));
    const description = {nativeName: name, usage: Number(field(item, 'usage') ?? 0)};
    result.set(name, description);
    result.set(publicName(name), description);
  }
  return result;
}

const valueFields: Readonly<Record<string, readonly string[]>> = {
  Vector2: ['x','y'], Vector2i: ['x','y'], Vector3: ['x','y','z'], Vector3i: ['x','y','z'],
  Vector4: ['x','y','z','w'], Vector4i: ['x','y','z','w'], Quaternion: ['x','y','z','w'],
  Color: ['r','g','b','a'], Rect2: ['position','size'], Rect2i: ['position','size'],
  AABB: ['position','size'], Plane: ['normal','d'], Transform2D: ['x','y','origin'],
  Basis: ['x','y','z'], Transform3D: ['basis','origin'], Projection: ['x','y','z','w'],
};
const packedValues = ['PackedByteArray','PackedInt32Array','PackedInt64Array','PackedFloat32Array','PackedFloat64Array','PackedStringArray','PackedVector2Array','PackedVector3Array','PackedColorArray','PackedVector4Array'];
export interface CapturedValue { value: unknown; kind?: string; parts?: readonly CapturedValue[] }

/** Value variants (including copy-on-write packed arrays) are snapshotted.
 * Objects, Resources, Array and Dictionary retain their native reference semantics. */
export function captureValue(godot: any, value: any, className: (name:string)=>string = name=>name): CapturedValue {
  if (value === null || typeof value !== 'object') return {value};
  for (const [name, fields] of Object.entries(valueFields)) {
    const constructor = godot[className(name)];
    if (typeof constructor !== 'function' || !(value instanceof constructor)) continue;
    const parts = fields.map(key => captureValue(godot, value[key],className));
    let copied = value;
    try { copied = new constructor(value); } catch { /* Comparison still uses captured components. */ }
    return {value: copied, kind:name, parts};
  }
  for (const name of packedValues) {
    const constructor=godot[className(name)];
    if(typeof constructor!=='function'||!(value instanceof constructor))continue;
    return {kind:name,value:nativeCall(value,'duplicate'),parts:sequence(value).map(item=>captureValue(godot,item,className))};
  }
  return {value};
}

export function sameValue(previous: CapturedValue, next: CapturedValue): boolean {
  if(previous.kind!==next.kind)return false;
  if (previous.parts || next.parts) {
    if (!previous.parts || !next.parts || previous.parts.length !== next.parts.length) return false;
    return previous.parts.every((part, index) => sameValue(part as CapturedValue, next.parts![index] as CapturedValue));
  }
  return Object.is(previous.value, next.value);
}
