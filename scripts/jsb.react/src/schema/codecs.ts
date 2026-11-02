import { ERROR_CODES, exact, fail, invariant, type AssetRef, type ColorValue, type Vector2Value } from "../contracts";

export type CodecName = "boolean" | "number" | "integer" | "string" | "stringName" | "vector2" | "color" | "assetRef" | "stringArray" | "nodeRef";
export type CodecValue = null | boolean | number | string | Vector2Value | ColorValue | AssetRef | readonly string[];
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
    case "vector2": {
      const vector = exact(value, ["x", "y"], [], path);
      return Object.freeze({ x: validateValue("number", vector.x, `${path}.x`) as number, y: validateValue("number", vector.y, `${path}.y`) as number });
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
