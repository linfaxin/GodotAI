import type { CapabilityProfileV1 } from "../contracts";
import { CODEC_DEFINITIONS, type CodecName, type CodecValue } from "./codecs";

export type CoreHostType = "Node" | "Node2D" | "Control" | "VBoxContainer" | "HBoxContainer" | "Label" | "Button" | "CanvasLayer";
export interface PropertySchema {
  readonly publicName: string; readonly nativeName: string; readonly accessName: string;
  readonly codec: CodecName; readonly defaultValue: CodecValue; readonly aliases: readonly string[];
  readonly construction?: boolean; readonly layoutOutput?: boolean;
  /** Setter dependencies are explicit and included in the schema digest. */
  readonly writeOrder?: number;
  readonly minimum?: number; readonly maximum?: number; readonly resourceTypes?: readonly string[]; readonly normalize?: "unitVector2";
}
export interface SignalSchema { readonly publicName: string; readonly nativeName: string; readonly parameters: readonly CodecName[]; readonly echo: "suppress" | "deliver"; }
export interface CommandSchema { readonly publicName: string; readonly nativeName: string; readonly arguments: readonly CodecName[]; readonly result?: CodecName; readonly effects: readonly string[]; readonly phase: "process" | "physics" | "input" | "cleanup"; }
export interface HostSchema {
  readonly type: string; readonly nativeType: string;
  readonly properties: Readonly<Record<string, PropertySchema>>;
  readonly signals: Readonly<Record<string, SignalSchema>>;
  readonly commands: Readonly<Record<string, CommandSchema>>;
  readonly intrinsicEngineOwned: readonly string[];
  readonly visual: boolean;
}

const v2 = (x: number, y: number) => Object.freeze({ x, y });
const rgba = (r: number, g: number, b: number, a: number) => Object.freeze({ r, g, b, a });
const p = (publicName: string, nativeName: string, codec: CodecName, defaultValue: CodecValue, aliases: readonly string[] = [publicName], extra: Partial<PropertySchema> = {}): PropertySchema => Object.freeze({ publicName, nativeName, accessName: nativeName, codec, defaultValue, aliases: Object.freeze([...aliases]), ...extra, ...(extra.resourceTypes ? { resourceTypes: Object.freeze([...extra.resourceTypes]) } : {}) });
const s = (publicName: string, nativeName: string, parameters: readonly CodecName[] = [], echo: SignalSchema["echo"] = "deliver"): SignalSchema => Object.freeze({ publicName, nativeName, parameters: Object.freeze([...parameters]), echo });
const command = (publicName: string, nativeName: string, arguments_: readonly CodecName[], effects: readonly string[], phase: CommandSchema["phase"]): CommandSchema => Object.freeze({ publicName, nativeName, arguments: Object.freeze([...arguments_]), effects: Object.freeze([...effects]), phase });
const name = p("name", "name", "stringName", "", ["identity.name"], { construction: true });
const canvas = {
  visible: p("visible", "visible", "boolean", true, ["visibility"]),
  modulate: p("modulate", "modulate", "color", rgba(1, 1, 1, 1)),
  material: p("material", "material", "assetRef", null, ["material"], { resourceTypes: ["CanvasItemMaterial"] }),
};
const control = {
  name, ...canvas,
  customMinimumSize: p("customMinimumSize", "custom_minimum_size", "vector2", v2(0, 0), ["layout.minimum"]),
  sizeFlagsHorizontal: p("sizeFlagsHorizontal", "size_flags_horizontal", "integer", 1, ["layout.flags.horizontal"], { minimum: 0, maximum: 15 }),
  sizeFlagsVertical: p("sizeFlagsVertical", "size_flags_vertical", "integer", 1, ["layout.flags.vertical"], { minimum: 0, maximum: 15 }),
  mouseFilter: p("mouseFilter", "mouse_filter", "integer", 0, ["input.mouseFilter"], { minimum: 0, maximum: 2 }),
};
const focusSignals = { onFocusEntered: s("onFocusEntered", "focus_entered"), onFocusExited: s("onFocusExited", "focus_exited") };
const focusCommands = { grabFocus: command("grabFocus", "grab_focus", [], ["focus"], "input") };
const containerControl = { ...control, mouseFilter: p("mouseFilter", "mouse_filter", "integer", 1, ["input.mouseFilter"], { minimum: 0, maximum: 2 }) };
const labelControl = { ...control, mouseFilter: p("mouseFilter", "mouse_filter", "integer", 2, ["input.mouseFilter"], { minimum: 0, maximum: 2 }), sizeFlagsVertical: p("sizeFlagsVertical", "size_flags_vertical", "integer", 4, ["layout.flags.vertical"], { minimum: 0, maximum: 15 }) };
function host(type: CoreHostType, properties: Record<string, PropertySchema>, signals: Record<string, SignalSchema> = {}, commands: Record<string, CommandSchema> = {}, intrinsicEngineOwned: readonly string[] = [], visual = false): HostSchema {
  return Object.freeze({ type, nativeType: type, properties: Object.freeze(properties), signals: Object.freeze(signals), commands: Object.freeze(commands), intrinsicEngineOwned: Object.freeze([...intrinsicEngineOwned]), visual });
}

export const HOST_SCHEMA: Readonly<Record<CoreHostType, HostSchema>> = Object.freeze({
  Node: host("Node", { name }),
  Node2D: host("Node2D", {
    name, ...canvas,
    position: p("position", "position", "vector2", v2(0, 0), ["transform2d", "globalPosition", "transform", "globalTransform"]),
    rotation: p("rotation", "rotation", "number", 0, ["transform2d", "rotationDegrees", "globalRotation"]),
    scale: p("scale", "scale", "vector2", v2(1, 1), ["transform2d", "globalScale"]),
  }, {}, {
    setPosition: command("setPosition", "set_position", ["vector2"], ["transform2d"], "process"),
    setRotation: command("setRotation", "set_rotation", ["number"], ["transform2d"], "process"),
    setScale: command("setScale", "set_scale", ["vector2"], ["transform2d"], "process"),
  }, [], true),
  Control: host("Control", { ...control }, { ...focusSignals }, { ...focusCommands }, ["focus"], true),
  VBoxContainer: host("VBoxContainer", { ...containerControl }, { ...focusSignals }, { ...focusCommands }, ["focus"], true),
  HBoxContainer: host("HBoxContainer", { ...containerControl }, { ...focusSignals }, { ...focusCommands }, ["focus"], true),
  Label: host("Label", { ...labelControl, text: p("text", "text", "string", "") }, { ...focusSignals }, {}, ["focus"], true),
  Button: host("Button", {
    ...control,
    text: p("text", "text", "string", ""),
    disabled: p("disabled", "disabled", "boolean", false),
    toggleMode: p("toggleMode", "toggle_mode", "boolean", false, ["button.state", "button.toggleMode"], { writeOrder: 10 }),
    buttonPressed: p("buttonPressed", "button_pressed", "boolean", false, ["button.state", "button.pressed"], { writeOrder: 20 }),
  }, { ...focusSignals, onPressed: s("onPressed", "pressed"), onToggled: s("onToggled", "toggled", ["boolean"], "suppress") }, { ...focusCommands }, ["focus"], true),
  CanvasLayer: host("CanvasLayer", {
    name,
    visible: p("visible", "visible", "boolean", true, ["visibility"]),
    layer: p("layer", "layer", "integer", 1, ["layer"], { minimum: -2147483648, maximum: 2147483647 }),
    offset: p("offset", "offset", "vector2", v2(0, 0), ["canvasLayerTransform"]),
    rotation: p("rotation", "rotation", "number", 0, ["canvasLayerTransform"]),
    scale: p("scale", "scale", "vector2", v2(1, 1), ["canvasLayerTransform"]),
  }, {}, {}, [], true),
});

export const CORE_PROFILE: CapabilityProfileV1 = Object.freeze({
  id: "core-ui-v1", version: 1,
  hosts: Object.freeze(Object.keys(HOST_SCHEMA)),
  codecs: Object.freeze(["boolean", "number", "integer", "string", "stringName", "vector2", "color", "assetRef"]),
  resources: Object.freeze(["Resource", "CanvasItemMaterial"]),
  features: Object.freeze({ portal: false, physics: false, rpc: false, perNodeScript: false, localToScene: false, complexAnimation: false, inheritedTemplates: false, lineEdit: false }),
});
export const CORE_SCHEMA_DESCRIPTOR = Object.freeze({ profile: CORE_PROFILE, hosts: HOST_SCHEMA, codecs: CODEC_DEFINITIONS });
/** SHA-256 of canonicalJson(CORE_SCHEMA_DESCRIPTOR). Kept in lockstep by conformance tests. */
export const CORE_PROFILE_HASH = "2807c96de6bd7f87174263262ec5c9d1a8f473a1e5620175f2edf179cb58eae5" as const;
export const PROFILE = Object.freeze({ ...CORE_PROFILE, hash: CORE_PROFILE_HASH });
export const coreProfileReference = () => Object.freeze({ id: CORE_PROFILE.id, version: CORE_PROFILE.version, hash: CORE_PROFILE_HASH });
