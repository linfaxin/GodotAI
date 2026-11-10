import {validateRichText,normalizeRangeValue} from '../usability-values';
import {validateSimplePolygon} from '../geometry-values';
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
  return Object.freeze([...new Set(fields.flatMap(field => field==='layout'&&schema.properties.layout?['layout.position','layout.size']:[canonicalField(schema, field)]))].sort());
}

export function intrinsicFields(type: string, parentType?: string, profileId?: string): readonly string[] {
  const schema = getHostSchema(type, profileId), fields = [...schema.intrinsicEngineOwned];
  if (parentType && ['VBoxContainer', 'HBoxContainer', 'PanelContainer', 'MarginContainer', 'ScrollContainer','GridContainer','TabContainer','CenterContainer','AspectRatioContainer','HSplitContainer','VSplitContainer','HFlowContainer','VFlowContainer'].includes(parentType) && Object.hasOwn(schema.properties, "customMinimumSize")) fields.push("layout.position", "layout.size",...(schema.properties.pivotOffset?["uiTransform"]:[]));
  if(parentType==="SpringArm3D"&&schema.properties.position?.codec==="vector3")fields.push("transform3d");
  if(type==="SubViewport"&&parentType==="SubViewportContainer")fields.push("viewportSize");
  if(parentType==="TabContainer"&&Object.hasOwn(schema.properties,"visible"))fields.push("visibility");
  return Object.freeze([...new Set(fields)].sort());
}

function propertyValue(schema: PropertySchema, value: unknown, path: string, allowInstanceResources = false): CodecValue {
  let checked = validateValue(schema.codec, value, path, { resourceTypes: schema.resourceTypes, minimum: schema.minimum, maximum: schema.maximum });
  if (checked !== null && typeof checked === "object" && "kind" in checked && checked.kind === "asset") invariant(allowInstanceResources || checked.scope !== "instance", ERROR_CODES.PROFILE, "Instance resources require a certified clone profile", path);
  if (schema.normalize === "unitVector2" || schema.normalize === "unitVector3") {
    const vector = checked as { x: number; y: number; z?: number }, length = Math.hypot(vector.x, vector.y, vector.z ?? 0);
    invariant(length > 0 && Number.isFinite(length), ERROR_CODES.VALUE, "Expected nonzero direction", path);
    checked = Object.freeze({ x: vector.x / length, y: vector.y / length, ...(schema.normalize === "unitVector3" ? {z: vector.z! / length} : {}) });
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
  for (const property of Object.keys(controlled)) invariant(!canonicalFields(type,[property],context.parentType,context.profileId).some(field=>reserved.includes(field)), ERROR_CODES.OWNER, `React controlled ${property} conflicts with engine ownership`, `$.${property}`);
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
  if(schema.properties.layout&&Object.hasOwn(controlled,'layout'))invariant(!Object.hasOwn(controlled,'position')&&!Object.hasOwn(controlled,'size'),ERROR_CODES.OWNER,'layout conflicts with position/size','$.layout');
  if ((type === "Button" || type === "TextureButton")) {
    const toggleMode = controlled.toggleMode ?? baseline.toggleMode;
    const requestedPressed = controlled.buttonPressed ?? (previous ? false : baseline.buttonPressed);
    invariant(requestedPressed !== true || toggleMode === true, ERROR_CODES.VALUE, "buttonPressed=true requires effective toggleMode=true", "$.buttonPressed");
  }
  if (type === "AnimationTree" || type === "MeshInstance3D") {
    const key=type==="AnimationTree"?"animPlayer":"skeleton",value=controlled[key]??baseline[key];
    if(value!==undefined)invariant(typeof value==="string"&&(value===""||value==="."||value===".."||/^(?:\.\.\/|\.\/)?[A-Za-z_][A-Za-z0-9_-]*(?:\/[A-Za-z_][A-Za-z0-9_-]*)*$/.test(value)),ERROR_CODES.VALUE,"Native node references must stay within the managed parent",`$.${key}`);
  }
  if (type === "AnimationPlayer") {
    const rootNode = controlled.rootNode ?? baseline.rootNode;
    invariant(rootNode === "." || rootNode === "..", ERROR_CODES.VALUE, "Animation root must be the player or its managed parent", "$.rootNode");
  }
  if(type==='CPUParticles2D'||type==='CPUParticles3D'){for(const key of ['angle','radialAccel','tangentialAccel','orbitVelocity','hueVariation'])invariant(Number(controlled[key+'Min']??baseline[key+'Min'])<=Number(controlled[key+'Max']??baseline[key+'Max']),ERROR_CODES.VALUE,'Particle minimum exceeds maximum','$.'+key);}
  if(type==='Polygon2D'){for(const key of ['offset','textureOffset','textureScale']){const v=(controlled[key]??baseline[key]) as {x:number;y:number}|undefined;if(v)invariant(Math.abs(v.x)<=10000&&Math.abs(v.y)<=10000&&(key!=='textureScale'||v.x!==0&&v.y!==0),ERROR_CODES.VALUE,'Invalid polygon texture/offset transform','$.guards');}const colors=(controlled.vertexColors??baseline.vertexColors??[]) as readonly unknown[],points=(controlled.polygon??baseline.polygon??[]) as readonly unknown[];invariant(colors.length<=points.length,ERROR_CODES.VALUE,'Vertex colors exceed polygon vertices','$.vertexColors');}
  if(type==='Parallax2D'){const value=(key:string)=>(controlled[key]??baseline[key]) as {x:number;y:number};for(const key of ['scrollScale','scrollOffset','repeatSize','autoscroll','limitBegin','limitEnd']){const v=value(key);invariant(Math.abs(v.x)<=1e7&&Math.abs(v.y)<=1e7,ERROR_CODES.VALUE,'Parallax vector out of range','$.guards');}const size=value('repeatSize'),scale=value('scale'),begin=value('limitBegin'),end=value('limitEnd'),auto=value('autoscroll');invariant(size.x>=0&&size.y>=0&&size.x<=16384&&size.y<=16384&&scale.x>0&&scale.y>0&&begin.x<=end.x&&begin.y<=end.y,ERROR_CODES.VALUE,'Invalid parallax bounds/repeat/scale','$.guards');invariant(!Object.hasOwn(initial,'position'),ERROR_CODES.OWNER,'Parallax position is a native scroll output','$.initial.position');invariant(!(auto.x||auto.y)||!Object.hasOwn(controlled,'scrollOffset'),ERROR_CODES.OWNER,'Autoscroll owns scrollOffset; use initial','$.scrollOffset');}
  if(type==='OptionButton'){const items=(controlled.items??baseline.items) as readonly string[],selected=(controlled.selected??baseline.selected) as number;invariant(items.length<=1024&&items.every(item=>item.length<=256)&&selected<items.length,ERROR_CODES.VALUE,'Option selection must refer to an existing item','$.selected');}
  if (['HSlider','VSlider','HScrollBar','VScrollBar','SpinBox'].includes(type)||(type==='ProgressBar'||type==='TextureProgressBar')&&context.profileId==='showcase-v1') {
    const v=(key:string,fallback:any=0)=>controlled[key]??baseline[key]??fallback;
    const min=Number(v('minValue')),max=Number(v('maxValue')),value=Number(v('value')),page=Number(v('page')),step=Number(v('step')),rounded=v('rounded',false)===true,greater=v('allowGreater',false)===true,lesser=v('allowLesser',false)===true;
    invariant(min<=max&&page<=max-min&&(lesser||value>=min)&&(greater||value<=max-page),ERROR_CODES.VALUE,'Invalid range bounds, page or value','$.value');
    invariant(!v('expEdit',false)||(min>=0&&max>min&&(min>0||max>1)),ERROR_CODES.VALUE,'Exponential range requires nonnegative minimum and increasing positive logarithmic bounds','$.expEdit');
    invariant(Math.max(Math.abs(min),Math.abs(max),Math.abs(value))<=1e9&&(!step||step>=1e-9),ERROR_CODES.VALUE,'Range exceeds supported precision','$.guards');
    const normalized=normalizeRangeValue(value,min,max,step,page,rounded,greater,lesser);if(Object.hasOwn(controlled,'value'))controlled.value=normalized;else if(!previous)baseline=Object.freeze({...baseline,value:normalized});
  }
  if(schema.properties.clipChildren&&context.parentType==='CanvasGroup')invariant(Number(controlled.clipChildren??baseline.clipChildren)===0,ERROR_CODES.VALUE,'CanvasGroup children cannot enable clipping');
  if(type==='CPUParticles2D')for(const key of ['animSpeed','animOffset'])invariant(Number(controlled[key+'Min']??baseline[key+'Min'])<=Number(controlled[key+'Max']??baseline[key+'Max']),ERROR_CODES.VALUE,'Particle animation minimum exceeds maximum');
  if(type==='TextEdit'||type==='CodeEdit')invariant(Array.from(String(controlled.searchText??baseline.searchText??'')).length<=1024,ERROR_CODES.VALUE,'Search text exceeds 1024 characters');
  if(type==='TextEdit'||type==='CodeEdit'){invariant(Array.from(String(controlled.text??baseline.text)).length<=65536,ERROR_CODES.VALUE,'TextEdit exceeds 65536 characters');invariant(String(controlled.placeholderText??baseline.placeholderText??'').length<=1024,ERROR_CODES.VALUE,'Placeholder exceeds 1024');}
  if(type==='ItemList'){const items=(controlled.items??baseline.items) as any[],selected=(controlled.selectedItems??baseline.selectedItems) as number[],mode=Number(controlled.selectMode??baseline.selectMode);invariant(selected.length<=1024&&new Set(selected).size===selected.length&&(mode!==0||selected.length<=1)&&selected.every(i=>Number.isInteger(i)&&i>=0&&i<items.length&&!items[i][2]&&items[i][3]),ERROR_CODES.VALUE,'Invalid list selection');const size=(controlled.fixedIconSize??baseline.fixedIconSize) as any;invariant(size.x>=0&&size.y>=0&&size.x<=1024&&size.y<=1024,ERROR_CODES.VALUE,'Invalid icon size');}
  if(schema.properties.visibilityRangeBegin){const begin=Number(controlled.visibilityRangeBegin??baseline.visibilityRangeBegin),end=Number(controlled.visibilityRangeEnd??baseline.visibilityRangeEnd);invariant(end===0||end>=begin,ERROR_CODES.VALUE,'Visibility end must be zero or >= begin');}
  if(type==='RichTextLabel')validateRichText(String(controlled.text??baseline.text),Boolean(controlled.bbcodeEnabled??baseline.bbcodeEnabled));
  if(type==='SpinBox')invariant(String(controlled.prefix??baseline.prefix??'').length<=256,ERROR_CODES.VALUE,'Spin prefix exceeds 256 characters');
  if(type==='SubViewport'&&schema.properties.size2dOverride){const size=(controlled.size2dOverride??baseline.size2dOverride) as {x:number;y:number};invariant(Number.isInteger(size.x)&&Number.isInteger(size.y)&&size.x>=0&&size.y>=0&&size.x<=4096&&size.y<=4096,ERROR_CODES.VALUE,'2D override must be 0..4096','$.size2dOverride');}
  if(['PinJoint2D','DampedSpringJoint2D','PinJoint3D','HingeJoint3D','SliderJoint3D'].includes(type)){for(const key of ['nodeA','nodeB']){const value=controlled[key]??baseline[key];invariant(typeof value==='string'&&/^(?:|(?:\.\.\/)?[A-Za-z_][A-Za-z0-9_-]*(?:\/[A-Za-z_][A-Za-z0-9_-]*)*)$/.test(value),ERROR_CODES.VALUE,'Joint requires a local body path','$.sticky');}}
  if(type==='SubViewport'){const size=(controlled.size??baseline.size) as {x:number;y:number};invariant(size.x>=2&&size.y>=2&&size.x<=4096&&size.y<=4096,ERROR_CODES.VALUE,'Viewport size must be 2..4096','$.size');if((controlled.guiDisableInput??baseline.guiDisableInput)===false&&context.parentType)invariant(context.parentType==='SubViewportContainer',ERROR_CODES.VALUE,'Interactive viewport requires SubViewportContainer','$.guiDisableInput');}
  if(type==='Sprite2D'||type==='Sprite3D'){const h=(controlled.hframes??baseline.hframes) as number,v=(controlled.vframes??baseline.vframes) as number,frame=(controlled.frame??baseline.frame) as number;invariant(frame<h*v,ERROR_CODES.VALUE,'Sprite frame exceeds atlas grid','$.frame');}
  if(type==='Polygon2D'||type==='CollisionPolygon2D'){const points=(controlled.polygon??baseline.polygon) as {x:number;y:number}[];validateSimplePolygon(points);if(type==='Polygon2D'){const uv=(controlled.uv??baseline.uv) as unknown[];invariant(!uv.length||uv.length===points.length,ERROR_CODES.VALUE,'UV count must match polygon','$.uv');}}
  if(type==='Sprite2D'||type==='TextureRect'){const path=(controlled.viewportPath??baseline.viewportPath) as string;if(path){invariant(/^(?:\.\.\/){0,16}[A-Za-z_][A-Za-z0-9_-]*(?:\/[A-Za-z_][A-Za-z0-9_-]*)*$/.test(path),ERROR_CODES.VALUE,'Expected local viewport path','$.viewportPath');invariant(!controlled.texture,ERROR_CODES.OWNER,'Viewport binding conflicts with controlled texture','$.texture');}}
  if(type.startsWith('NavigationObstacle')){const points=(controlled.vertices??baseline.vertices) as unknown[];invariant(points.length===0||points.length>=3,ERROR_CODES.VALUE,'Obstacle polygon needs at least three vertices','$.vertices');}
  if(schema.properties.customMinimumSize)for(const key of ['focusNeighborLeft','focusNeighborTop','focusNeighborRight','focusNeighborBottom','focusNext','focusPrevious']){const value=controlled[key]??baseline[key];if(value!==undefined)invariant(typeof value==='string'&&value.length<=512&&/^(?:|(?:\.\.\/){0,16}[A-Za-z_][A-Za-z0-9_-]*(?:\/[A-Za-z_][A-Za-z0-9_-]*)*)$/.test(value),ERROR_CODES.VALUE,'Expected local Control path','$.focus');}
  if(type.startsWith('CPUParticles'))for(const key of ['linearAccel','damping','angularVelocity'])if(schema.properties[key+'Min'])invariant(Number(controlled[key+'Min']??baseline[key+'Min'])<=Number(controlled[key+'Max']??baseline[key+'Max']),ERROR_CODES.VALUE,'Particle minimum exceeds maximum','$.'+key);
  if(type==='CPUParticles2D'||type==='CPUParticles3D'){
    const shape=(controlled.emissionShape??baseline.emissionShape) as number,points=(controlled.emissionPoints??baseline.emissionPoints) as unknown[],normals=(controlled.emissionNormals??baseline.emissionNormals) as unknown[];
    if(shape===4||shape===5)invariant(points.length>0,ERROR_CODES.VALUE,'Point emission requires points','$.emissionPoints');if(shape===5)invariant(normals.length===points.length,ERROR_CODES.VALUE,'Directed emission normals must match points','$.emissionNormals');
    if(type==='CPUParticles3D')invariant(Number(controlled.emissionRingInnerRadius??baseline.emissionRingInnerRadius)<=Number(controlled.emissionRingRadius??baseline.emissionRingRadius),ERROR_CODES.VALUE,'Ring inner radius exceeds radius','$.emissionRingInnerRadius');
    const extents=(controlled[type==='CPUParticles2D'?'emissionRectExtents':'emissionBoxExtents']??baseline[type==='CPUParticles2D'?'emissionRectExtents':'emissionBoxExtents']) as any;if(extents)invariant(extents.x>=0&&extents.y>=0&&(extents.z===undefined||extents.z>=0),ERROR_CODES.VALUE,'Negative emission extents','$.emissionShape');
  }
  if(schema.properties.customMinimumSize){const size=(controlled.size??baseline.size) as any,scale=(controlled.scale??baseline.scale) as any;if(size)invariant(size.x>=0&&size.y>=0,ERROR_CODES.VALUE,'Negative Control size','$.size');if(scale)invariant(scale.x>0&&scale.y>0,ERROR_CODES.VALUE,'Non-positive Control scale','$.scale');}
  if (type === "Camera2D") {
    const zoom = (controlled.zoom ?? baseline.zoom) as {x:number;y:number};
    invariant(zoom.x > 0 && zoom.y > 0, ERROR_CODES.VALUE, "Camera zoom must be positive", "$.zoom");
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
