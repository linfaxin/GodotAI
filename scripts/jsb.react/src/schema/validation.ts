import { ContractError, ERROR_CODES, canonicalJson, fail, invariant, object } from "../contracts";
import { type HostSchema, type PropertySchema } from "./core";
import { getProfileSchema } from "./profiles";
import { type CodecValue, validateValue, valuesEqual } from "./codecs";

export interface HostDiagnostic { readonly code: string; readonly message: string; readonly path: string; }
export interface ValidatedHostProps {
  readonly controlled: Readonly<Record<string, CodecValue>>;
  readonly initial: Readonly<Record<string, CodecValue>>;
  readonly baseline: Readonly<Record<string, CodecValue>>;
  readonly engineOwned: readonly string[];
  readonly events: Readonly<Record<string, (...args: unknown[]) => unknown>>;
  readonly name?: string;
  readonly nativeScriptProfile?: string;
  readonly diagnostics: readonly HostDiagnostic[];
}
export interface HostValidationContext {
  previous?: ValidatedHostProps;
  templateInitial?: Readonly<Record<string, unknown>>;
  parentType?: string;
  profileId?: string;
  /** Internal capability set only after a local-resource template equivalence gate. */
  allowInstanceResources?: boolean;
  allowedNativeScriptProfiles?: readonly string[];
}

export function getHostSchema(type: string, profileId = "core-ui-v1"): HostSchema {
  const profile = getProfileSchema(profileId);
  return Object.hasOwn(profile.hosts, type) ? profile.hosts[type]! : fail(ERROR_CODES.HOST, `Host ${type} is not in ${profileId}`);
}

export function publicPropertyName(type: string, nativeName: string, profileId?: string): string {
  const property = Object.values(getHostSchema(type, profileId).properties).find(p => p.nativeName === nativeName);
  return property?.publicName ?? fail(ERROR_CODES.PROP, `Unsupported native property ${type}.${nativeName}`);
}

function canonicalField(schema: HostSchema, field: string): string {
  const property = schema.properties[field];
  if (property) {
    invariant(!property.construction, ERROR_CODES.OWNER, `Construction field ${field} cannot be engine-owned`);
    return property.aliases[0] ?? property.publicName;
  }
  for (const p of Object.values(schema.properties)) if (p.aliases.includes(field)) {
    invariant(!p.construction, ERROR_CODES.OWNER, `Construction field ${field} cannot be engine-owned`);
    return p.aliases[0] ?? p.publicName;
  }
  if (schema.intrinsicEngineOwned.includes(field) || Object.values(schema.commands).some(command => command.effects.includes(field)) || field === "layout.position" || field === "layout.size") return field;
  return fail(ERROR_CODES.OWNER, `Unknown property/effect ${schema.type}.${field}`);
}

/** Alias closure, represented by conservative exclusive canonical field groups. */
export function canonicalFields(type: string, fields: readonly string[], _parentType?: string, profileId?: string): readonly string[] {
  const schema = getHostSchema(type, profileId);
  invariant(Array.isArray(fields) && fields.every(field => typeof field === "string"), ERROR_CODES.OWNER, "Expected field names");
  return Object.freeze([...new Set(fields.map(field => canonicalField(schema, field)))].sort());
}

export function intrinsicFields(type: string, parentType?: string, profileId?: string): readonly string[] {
  const schema = getHostSchema(type, profileId), fields = [...schema.intrinsicEngineOwned];
  if ((parentType === "VBoxContainer" || parentType === "HBoxContainer") && Object.hasOwn(schema.properties, "customMinimumSize")) fields.push("layout.position", "layout.size");
  return Object.freeze([...new Set(fields)].sort());
}

function propertyValue(schema: PropertySchema, value: unknown, path: string, allowInstanceResources = false): CodecValue {
  let checked = validateValue(schema.codec, value, path, { resourceTypes: schema.resourceTypes, minimum: schema.minimum, maximum: schema.maximum });
  if (checked !== null && typeof checked === "object" && "kind" in checked && checked.kind === "asset") invariant(allowInstanceResources || checked.scope !== "instance", ERROR_CODES.PROFILE, "Instance resources require a certified clone profile", path);
  if (schema.normalize === "unitVector2") {
    const vector = checked as { x: number; y: number }, length = Math.hypot(vector.x, vector.y);
    invariant(length > 0 && Number.isFinite(length), ERROR_CODES.VALUE, "Expected nonzero direction", path);
    checked = Object.freeze({ x: vector.x / length, y: vector.y / length });
  }
  return checked;
}

export function validateInitialProperties(type: string, value: unknown = {}, path = "$.initial", profileId?: string, allowInstanceResources = false): Readonly<Record<string, CodecValue>> {
  const schema = getHostSchema(type, profileId), props = object(value, path), result: Record<string, CodecValue> = Object.create(null);
  for (const [key, val] of Object.entries(props)) {
    const property = schema.properties[key];
    invariant(property !== undefined, ERROR_CODES.PROP, `Unknown ${type} initial property ${key}`, `${path}.${key}`);
    invariant(!property.construction, ERROR_CODES.CONSTRUCTION, `${key} is a top-level construction property`, `${path}.${key}`);
    invariant(val !== undefined, ERROR_CODES.VALUE, "Initial values cannot be undefined", `${path}.${key}`);
    result[key] = propertyValue(property, val, `${path}.${key}`, allowInstanceResources);
  }
  return Object.freeze(result);
}

function propsRecord(value: unknown): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), ERROR_CODES.VALUE, "Expected host props");
  const prototype = Object.getPrototypeOf(value);
  invariant(prototype === Object.prototype || prototype === null, ERROR_CODES.VALUE, "Expected plain host props");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    invariant(typeof key === "string", ERROR_CODES.UNKNOWN_FIELD, "Symbol prop is unsupported");
    // React development props may carry its reserved warning getter for key.
    if (key === "key") continue;
    invariant(key !== "__proto__" && key !== "constructor" && key !== "prototype", ERROR_CODES.UNKNOWN_FIELD, `Forbidden prop ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    invariant("value" in descriptor, ERROR_CODES.VALUE, "Getter props are unsupported", `$.${key}`);
    result[key] = descriptor.value;
  }
  return result;
}

function validateChildren(value: unknown, path = "$.children"): void {
  if (value === null || value === undefined || typeof value === "boolean") return;
  if (Array.isArray(value)) { value.forEach((child, i) => validateChildren(child, `${path}[${i}]`)); return; }
  const tag = typeof value === "object" && value !== null ? Object.getOwnPropertyDescriptor(value, "$$typeof") : undefined;
  invariant(tag !== undefined && "value" in tag && tag.value === Symbol.for("react.transitional.element"), ERROR_CODES.VALUE, "Native children must be React 19 elements; use Label.text for text", path);
}

export function validateHostProps(type: string, value: unknown, context: HostValidationContext = {}): ValidatedHostProps {
  const schema = getHostSchema(type, context.profileId), props = propsRecord(value), controlled: Record<string, CodecValue> = Object.create(null), events: Record<string, (...args: unknown[]) => unknown> = Object.create(null);
  const diagnostics: HostDiagnostic[] = [];
  let name: string | undefined;
  let nativeScriptProfile: string | undefined;
  for (const [key, val] of Object.entries(props)) {
    if (["children", "ref", "initial", "engineOwned", "nativeScriptProfile", "__self", "__source"].includes(key)) continue;
    const signal = schema.signals[key];
    if (signal) {
      invariant(val === undefined || val === null || typeof val === "function", ERROR_CODES.VALUE, `Expected signal handler ${key}`, `$.${key}`);
      if (typeof val === "function") events[key] = val as (...args: unknown[]) => unknown;
      continue;
    }
    const property = schema.properties[key];
    invariant(property !== undefined, ERROR_CODES.PROP, `Unsupported ${type} prop ${key}`, `$.${key}`);
    if (val === undefined) continue;
    const checked = propertyValue(property, val, `$.${key}`, context.allowInstanceResources);
    if (key === "name") {
      invariant(typeof checked === "string" && checked.length > 0 && !/[\/:@.\0]/.test(checked) && !checked.startsWith("__react_tmp_"), ERROR_CODES.NAME, "Invalid or reserved node name", "$.name");
      name = checked;
    } else controlled[key] = checked;
  }
  validateChildren(props.children);
  if (props.nativeScriptProfile !== undefined) {
    invariant(typeof props.nativeScriptProfile === "string" && context.allowedNativeScriptProfiles?.includes(props.nativeScriptProfile), ERROR_CODES.PROFILE, "NativeScript profile is not certified", "$.nativeScriptProfile");
    nativeScriptProfile = props.nativeScriptProfile;
  }
  const requested = props.engineOwned ?? [];
  invariant(Array.isArray(requested) && requested.every(field => typeof field === "string"), ERROR_CODES.OWNER, "engineOwned must be a field-name array", "$.engineOwned");
  const reserved = Object.freeze([...new Set([...canonicalFields(type, requested as string[], context.parentType, context.profileId), ...intrinsicFields(type, context.parentType, context.profileId)])].sort());
  for (const property of Object.keys(controlled)) invariant(!reserved.includes(canonicalField(schema, property)), ERROR_CODES.OWNER, `React controlled ${property} conflicts with engine ownership`, `$.${property}`);
  const template = validateInitialProperties(type, context.templateInitial ?? {}, "$.templateInitial", context.profileId, context.allowInstanceResources);
  let initial = validateInitialProperties(type, props.initial ?? {}, "$.initial", context.profileId, context.allowInstanceResources);
  let baseline: Readonly<Record<string, CodecValue>>;
  const previous = context.previous;
  if (previous) {
    invariant(previous.name === name && previous.nativeScriptProfile === nativeScriptProfile && valuesEqual(previous.engineOwned, reserved), ERROR_CODES.CONSTRUCTION, "name, engineOwned and nativeScriptProfile are fixed for a host lifetime; change key", "$.");
    if (!valuesEqual(previous.initial, initial)) {
      diagnostics.push(Object.freeze({ code: ERROR_CODES.INITIAL, message: "initial changed on a mounted host; old baseline retained, change key to reinitialize", path: "$.initial" }));
      initial = previous.initial;
    }
    baseline = previous.baseline;
  } else {
    const defaults: Record<string, CodecValue> = Object.create(null);
    for (const [key, property] of Object.entries(schema.properties)) if (!property.construction) defaults[key] = propertyValue(property, property.defaultValue, `$.schema.${key}`);
    baseline = Object.freeze({ ...defaults, ...template, ...initial });
  }
  if (type === "Button") {
    const toggleMode = controlled.toggleMode ?? baseline.toggleMode;
    const requestedPressed = controlled.buttonPressed ?? (previous ? false : baseline.buttonPressed);
    invariant(requestedPressed !== true || toggleMode === true, ERROR_CODES.VALUE, "buttonPressed=true requires effective toggleMode=true", "$.buttonPressed");
  }
  return Object.freeze({ controlled: Object.freeze(controlled), initial, baseline, engineOwned: reserved, events: Object.freeze(events), ...(name === undefined ? {} : { name }), ...(nativeScriptProfile === undefined ? {} : { nativeScriptProfile }), diagnostics: Object.freeze(diagnostics) });
}

/** Independent of author JSX/initial key order and object serialization order. */
export function orderedPropertyNames(type: string, profileId?: string): readonly string[] {
  const properties = getHostSchema(type, profileId).properties;
  return Object.freeze(Object.keys(properties).sort((a, b) => (properties[a]!.writeOrder ?? 0) - (properties[b]!.writeOrder ?? 0) || (a < b ? -1 : a > b ? 1 : 0)));
}

export interface PropertyUpdate { readonly publicName: string; readonly nativeName: string; readonly value: CodecValue; readonly reset: boolean; }
export function diffHostProps(type: string, previous: ValidatedHostProps | undefined, next: ValidatedHostProps, profileId?: string): readonly PropertyUpdate[] {
  const schema = getHostSchema(type, profileId), updates: PropertyUpdate[] = [];
  const before = previous?.controlled ?? {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(next.controlled)])) {
    const present = Object.hasOwn(next.controlled, key), value = present ? next.controlled[key]! : next.baseline[key]!;
    if (!present || !Object.hasOwn(before, key) || !valuesEqual(before[key], value)) updates.push(Object.freeze({ publicName: key, nativeName: schema.properties[key]!.nativeName, value, reset: !present }));
  }
  return Object.freeze(updates);
}

export function schemaFingerprintInput(profileId = "core-ui-v1"): string {
  // Undefined optional keys are omitted by construction, so this is strict JSON.
  const { profile, hosts, codecs } = getProfileSchema(profileId);
  return canonicalJson({ profile, hosts, codecs });
}

export function isContractError(error: unknown, code?: string): error is ContractError { return error instanceof ContractError && (code === undefined || error.code === code); }
