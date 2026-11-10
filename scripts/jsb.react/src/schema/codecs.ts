import {workflowValue} from '../workflow-values';
import {listItemsValue} from '../composition-values';
import {layoutTweenValue} from '../interaction-values';
import {behaviorValue} from '../behavior-values';
import {parityValue} from '../parity-values';
import { ERROR_CODES, exact, fail, invariant, type AssetRef, type ColorValue, type Vector2Value } from "../contracts";

export type CodecName = "menuItems" | "tilePattern" | "listItems" | "boolean" | "number" | "integer" | "string" | "stringName" | "vector2" | "vector3" | "color" | "assetRef" | "stringArray" | "nodeRef" | "vector2i" | "vector3i" | "vector2iArray" | "quaternion" | "transform3d" | "numberArray" | "tweenPlan" | "controlLayout" | "vector2Array" | "vector3Array" | "transform2d" | "rayQuery2" | "rayQuery3" | "shapeQuery2" | "shapeQuery3" | "rect2" | "materialArray" | "nodeHandle" | "shaderValue" | "appearanceTweenPlan" | "scalarTweenPlan" | "aabb" | "layoutTweenPlan" | "navigationEvent" | "rect2i" | "vector3iArray" | "shapeContact" | "colorArray";
export type Vector3Value = Readonly<{x:number;y:number;z:number}>;
export interface QuaternionValue {readonly x:number;readonly y:number;readonly z:number;readonly w:number}
export interface Transform3DValue {readonly basis:Readonly<{x:Vector3Value;y:Vector3Value;z:Vector3Value}>;readonly origin:Vector3Value}
export type CodecValue = import("../gameplay-components").Rect2Value | import("../parity-values").Transform2DValue | readonly unknown[] | readonly number[] | readonly (readonly unknown[])[] | QuaternionValue | Transform3DValue | null | boolean | number | string | Vector2Value | Vector3Value | ColorValue | AssetRef | readonly string[] | readonly Vector2Value[];
export const MAX_NATIVE_REAL = 3.4028234663852886e38;
/** Conservative wire profile valid for both single- and double-precision Godot builds. */
export const CODEC_DEFINITIONS = Object.freeze({
  version: 1,
  number: Object.freeze({ finite: true, minimum: -MAX_NATIVE_REAL, maximum: MAX_NATIVE_REAL }),
  integer: Object.freeze({ safeInteger: true }),
  vector2: Object.freeze({ fields: Object.freeze(["x", "y"]), component: "number" }),
  color: Object.freeze({ fields: Object.freeze(["r", "g", "b", "a"]), component: "number" }),
  assetRef: Object.freeze({ fields: Object.freeze(["kind", "id", "type"]), optional: Object.freeze(["scope"]), identity: "id+type+scope" }),
});

export const vec2 = (x: number, y: number): Vector2Value => validateValue("vector2", { x, y }) as Vector2Value;
export const color = (r: number, g: number, b: number, a = 1): ColorValue => validateValue("color", { r, g, b, a }) as ColorValue;

export interface CodecOptions { resourceTypes?: readonly string[]; minimum?: number; maximum?: number; nullable?: boolean; }

/** Validates without implicit Godot coercion, then returns an immutable value snapshot. */
export function validateValue(codec: CodecName, value: unknown, path = "$", options: CodecOptions = {}): CodecValue {
  if (value === null && (options.nullable || codec === "assetRef")) return null;
  switch (codec) {
    case "menuItems":case "tilePattern":return workflowValue(codec,value,path);
    case "listItems":return listItemsValue(value,path);
    case "colorArray":invariant(Array.isArray(value)&&value.length<=256,ERROR_CODES.VALUE,"Expected up to 256 vertex colors",path);return Object.freeze(value.map((v,i)=>{const color=validateValue("color",v,`${path}[${i}]`) as ColorValue;invariant([color.r,color.g,color.b].every(c=>c>=0&&c<=16)&&color.a>=0&&color.a<=1,ERROR_CODES.VALUE,"Vertex color out of range",path);return color;}));
    case "rect2i":{const box=exact(value,['position','size'],[],path),position=validateValue('vector2i',box.position,path),size=validateValue('vector2i',box.size,path) as any;invariant(size.x>=0&&size.y>=0,ERROR_CODES.VALUE,'Negative integer rect size',path);return Object.freeze({position,size}) as any;}
    case "vector3iArray":invariant(Array.isArray(value)&&value.length<=65536,ERROR_CODES.VALUE,'Expected bounded integer cell array',path);return Object.freeze(value.map((v,i)=>validateValue('vector3i',v,`${path}[${i}]`)));
    case "layoutTweenPlan":return layoutTweenValue(value,path);
    case "shapeContact":case "navigationEvent":return fail(ERROR_CODES.VALUE,"Navigation events are native output only",path);
    case "aabb": { const box=exact(value,["position","size"],[],path);const position=validateValue("vector3",box.position,path),size=validateValue("vector3",box.size,path) as any;invariant(size.x>=0&&size.y>=0&&size.z>=0,ERROR_CODES.VALUE,"Negative AABB extent",path);return Object.freeze({position,size}) as any; }
    case "nodeHandle":case "shaderValue":case "appearanceTweenPlan":case "scalarTweenPlan":return behaviorValue(codec,value,path);
    case "rect2":case "materialArray":case "controlLayout":case "transform2d":case "vector2Array":case "vector3Array":case "rayQuery2":case "rayQuery3":case "shapeQuery2":case "shapeQuery3":return parityValue(codec,value,path);
    case "numberArray":
      invariant(Array.isArray(value)&&value.length<=1048576,ERROR_CODES.VALUE,"Expected bounded numeric array",path);
      return Object.freeze(value.map((n,i)=>validateValue('number',n,`${path}[${i}]`) as number));
    case "tweenPlan": {
      const plan=exact(value,['steps'],['loops'],path);invariant(Array.isArray(plan.steps)&&plan.steps.length>0&&plan.steps.length<=128,ERROR_CODES.VALUE,'Expected 1..128 tween steps',path);
      const loops=validateValue('integer',plan.loops??1,path+'.loops',{minimum:0,maximum:1000000});let duration=0;
      const steps=plan.steps.map((item:unknown,i:number)=>{const step=exact(item,['property','to','duration'],['delay','transition','ease','parallel'],`${path}.steps[${i}]`);invariant(['position','rotation','scale'].includes(step.property as string),ERROR_CODES.VALUE,'Unsupported tween property',path);const to=typeof step.to==='number'?validateValue('number',step.to):validateValue(step.to&&typeof step.to==='object'&&'z'in step.to?'vector3':'vector2',step.to);const seconds=validateValue('number',step.duration,path,{minimum:0,maximum:86400}) as number,delay=validateValue('number',step.delay??0,path,{minimum:0,maximum:86400}) as number;duration+=seconds+delay;return Object.freeze([step.property,to,seconds,delay,validateValue('integer',step.transition??0,path,{minimum:0,maximum:11}),validateValue('integer',step.ease??0,path,{minimum:0,maximum:3}),validateValue('boolean',step.parallel??false)]);});
      invariant(duration>0,ERROR_CODES.VALUE,'Tween must consume time',path);return Object.freeze([Object.freeze([loops]),...steps]);
    }
    case "boolean":
      invariant(typeof value === "boolean", ERROR_CODES.VALUE, "Expected boolean", path); return value;
    case "number":
    case "integer":
      invariant(typeof value === "number" && Number.isFinite(value) && (codec !== "integer" || Number.isSafeInteger(value)), ERROR_CODES.VALUE, `Expected finite ${codec}`, path);
      if (codec === "number") invariant(Math.abs(value) <= MAX_NATIVE_REAL, ERROR_CODES.VALUE, "Value overflows native real precision", path);
      invariant(options.minimum === undefined || value >= options.minimum, ERROR_CODES.VALUE, `Value must be >= ${options.minimum}`, path);
      invariant(options.maximum === undefined || value <= options.maximum, ERROR_CODES.VALUE, `Value must be <= ${options.maximum}`, path);
      return Object.is(value, -0) ? 0 : value;
    case "string":
    case "stringName":
      invariant(typeof value === "string" && !value.includes("\0"), ERROR_CODES.VALUE, "Expected string without NUL", path); return value;
    case "quaternion": {
      const q=exact(value,["x","y","z","w"],[],path),numbers=["x","y","z","w"].map(key=>validateValue("number",q[key],`${path}.${key}`) as number),length=Math.hypot(...numbers);
      invariant(length>0,ERROR_CODES.VALUE,"Expected nonzero quaternion",path);
      return Object.freeze({x:numbers[0]!/length,y:numbers[1]!/length,z:numbers[2]!/length,w:numbers[3]!/length});
    }
    case "transform3d": {
      const t=exact(value,["basis","origin"],[],path),b=exact(t.basis,["x","y","z"],[],`${path}.basis`);
      return Object.freeze({origin:validateValue("vector3",t.origin,`${path}.origin`) as Vector3Value,basis:Object.freeze({x:validateValue("vector3",b.x,`${path}.basis.x`) as Vector3Value,y:validateValue("vector3",b.y,`${path}.basis.y`) as Vector3Value,z:validateValue("vector3",b.z,`${path}.basis.z`) as Vector3Value})});
    }
    case "vector2iArray":
      invariant(Array.isArray(value) && value.length <= 65536, ERROR_CODES.VALUE, "Expected bounded cell array", path);
      return Object.freeze(value.map((item,index)=>validateValue("vector2i",item,`${path}[${index}]`))) as readonly Vector2Value[];
    case "vector2i":
    case "vector3i": {
      const fields=codec==="vector2i"?["x","y"]:["x","y","z"], vector=exact(value,fields,[],path);
      return Object.freeze(Object.fromEntries(fields.map(field=>[field,validateValue("integer",vector[field],`${path}.${field}`,{minimum:-2147483648,maximum:2147483647})]))) as unknown as Vector2Value;
    }
    case "vector2": {
      const vector = exact(value, ["x", "y"], [], path);
      return Object.freeze({ x: validateValue("number", vector.x, `${path}.x`) as number, y: validateValue("number", vector.y, `${path}.y`) as number });
    }
    case "vector3": {
      const v = exact(value, ["x", "y", "z"], [], path);
      return Object.freeze({x:validateValue("number",v.x,`${path}.x`) as number,y:validateValue("number",v.y,`${path}.y`) as number,z:validateValue("number",v.z,`${path}.z`) as number});
    }
    case "color": {
      const c = exact(value, ["r", "g", "b", "a"], [], path);
      return Object.freeze({ r: validateValue("number", c.r, `${path}.r`) as number, g: validateValue("number", c.g, `${path}.g`) as number, b: validateValue("number", c.b, `${path}.b`) as number, a: validateValue("number", c.a, `${path}.a`) as number });
    }
    case "assetRef": {
      const asset = exact(value, ["kind", "id", "type"], ["scope"], path);
      invariant(asset.kind === "asset" && typeof asset.id === "string" && asset.id.length > 0 && typeof asset.type === "string" && asset.type.length > 0, ERROR_CODES.VALUE, "Expected AssetRef", path);
      invariant(asset.scope === undefined || asset.scope === "shared" || asset.scope === "instance", ERROR_CODES.VALUE, "Invalid resource scope", `${path}.scope`);
      invariant(options.resourceTypes === undefined || options.resourceTypes.includes(asset.type), ERROR_CODES.VALUE, `Unsupported resource type ${String(asset.type)}`, `${path}.type`);
      return Object.freeze({ kind: "asset", id: asset.id, type: asset.type, ...(asset.scope === undefined ? {} : { scope: asset.scope }) }) as AssetRef;
    }
    case "stringArray":
      invariant(Array.isArray(value) && value.every(item => typeof item === "string" && !item.includes("\0")), ERROR_CODES.VALUE, "Expected string array", path);
      return Object.freeze([...value]) as readonly string[];
    case "nodeRef":
      return fail(ERROR_CODES.VALUE, "Node values must be wrapped by the private NativeBridge; arbitrary objects cannot become handles", path);
  }
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, i) => valuesEqual(value, right[i]));
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every(key => Object.hasOwn(right, key) && valuesEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
