import {
  validateNativeInterfaceSchema, nativeInterfaceSchemaHash,
  type NativeInterfaceSchema, type NativeRpcCodec,
} from "@godot-js/react/native-interfaces";

export type { NativeInterfaceSchema, NativeRpcSchema } from "@godot-js/react/native-interfaces";
export interface NativeInterfaceGenerationOptions {
  readonly profile: string;
  readonly generatedDir?: string;
  /** Required by publication: a cached NativeScript must never import an older runtime generation. */
  readonly generation?: string;
  /** Framework import only. Native scripts remain separate files, never bundled. */
  readonly runtimeModule?: string;
}
export interface GeneratedNativeInterface {
  readonly source: string;
  readonly nativeLeaf: string;
  readonly schemaHash: string;
  /** Project relative source path, without a res:// prefix. */
  readonly relativeSource: string;
  readonly profile: string;
}
const tsType = (codec: NativeRpcCodec): string => codec === "boolean" ? "boolean" : codec === "integer" || codec === "number" ? "number" : "string";
const q = JSON.stringify;
/** Generates the concrete Script.ts identity selected before a host is constructed. */
export function generateNativeInterface(input: NativeInterfaceSchema | unknown, options: NativeInterfaceGenerationOptions): GeneratedNativeInterface {
  const schema = validateNativeInterfaceSchema(input);
  if (!options || !/^[a-z][a-z0-9_-]{0,63}$/.test(options.profile)) throw new TypeError("E_NATIVE_INTERFACE: Invalid profile id");
  const generatedDir = options.generatedDir ?? "generated/react";
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(generatedDir) || generatedDir === "src") throw new TypeError("E_NATIVE_INTERFACE: Invalid dedicated generatedDir");
  const runtimeModule = options.runtimeModule ?? "@godot-js/react/native-interfaces";
  if (runtimeModule !== "@godot-js/react/native-interfaces") throw new TypeError("E_NATIVE_INTERFACE: Native stubs require the canonical singleton runtime");
  const schemaHash = nativeInterfaceSchemaHash(schema);
  // A profile is an endpoint identity in addition to the schema identity. Sharing
  // a class across profiles would bake the wrong profile into its dispatch stub.
  if (options.generation !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(options.generation)) throw new TypeError("E_NATIVE_INTERFACE: Invalid generation identity");
  const relativeSource = `${generatedDir}/native/${options.generation ? `${options.generation}/` : ""}${options.profile}-${schemaHash}.ts`;
  const methods: string[] = [];
  const dispatch = (method: string, args: string, rpc=false) => `dispatchNativeInterface(invokeNative(this, "get_meta", "__godot_react_identity"), ${q(options.profile)}, ${q(schemaHash)}, ${q(method)}, ${args}${rpc ? ', Object.freeze({ senderPeerId: invokeNative(invokeNative(this, "get_multiplayer"), "get_remote_sender_id") })' : ''});`;
  for (const callback of schema.callbacks) {
    if (callback === "_ready") methods.push(`  _ready(): void { ${dispatch(callback, "[]")} }`);
    else if (callback === "_process" || callback === "_physics_process") methods.push(`  ${callback}(delta: number): void { ${dispatch(callback, "[delta]")} }`);
    else methods.push(`  ${callback}(event: InputEvent): void { ${dispatch(callback, "[Object.freeze({ type: invokeNative(event, \"get_class\"), text: invokeNative(event, \"as_text\"), pressed: invokeNative(event, \"is_pressed\"), echo: invokeNative(event, \"is_echo\") })]")} }`);
  }
  for (const [method, spec] of Object.entries(schema.rpc)) {
    // Fixed Godot 4 native ABI enum values avoid project-specific binding-name
    // remapping (RPCMode/RpcMode and RPC_MODE_AUTHORITY/RpcModeAuthority).
    const mode = spec.mode === "authority" ? 2 : 1;
    const transferMode = { reliable: 2, unreliable: 0, unreliableOrdered: 1 }[spec.transferMode];
    const parameters = spec.arguments.map((codec, index) => `arg${index}: ${tsType(codec)}`).join(", ");
    const args = `[${spec.arguments.map((_, index) => `arg${index}`).join(", ")}]`;
    methods.push(`  @bind.rpc({ mode: ${mode}, sync: ${q(spec.sync === "local" ? "call_local" : "call_remote")}, transfer_mode: ${transferMode}, transfer_channel: ${spec.channel} })\n  ${method}(${parameters}): void { ${dispatch(method, args,true)} }`);
  }
  const imports = [schema.nativeLeaf, ...(schema.callbacks.some(callback => callback === "_input" || callback === "_unhandled_input") ? ["InputEvent"] : [])];
  const nativeInvoker = `function invokeNative(target: any, name: string, ...args: unknown[]): any {
  const camel = (value: string) => value.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
  const method = target[name] ?? target[camel(name)];
  if (typeof method === "function") return method.apply(target, args);
  if (args.length === 0 && (name.startsWith("get_") || name.startsWith("is_"))) {
    const property = name.slice(name.startsWith("get_") ? 4 : 3);
    let value = target[property]; if (value === undefined) value = target[camel(property)];
    if (value !== undefined) return value;
  }
  throw new Error("Missing native reader " + name);
}`;
  const source = `// Generated by @godot-js/react-build. Edit the static schema, not this file.\n// Native leaf: ${schema.nativeLeaf}; profile: ${options.profile}; schema: ${schemaHash}\nimport { ${imports.join(", ")} } from "godot";\nimport { createClassBinder } from "godot.annotations";\nimport { dispatchNativeInterface } from ${q(runtimeModule)};\nconst bind = createClassBinder();\n${nativeInvoker}\n@bind()\nexport default class ReactNative_${options.profile.replace(/-/g,"_")}_${schemaHash.slice(0,12)} extends ${schema.nativeLeaf} {\n${methods.join("\n")}\n}\n`;
  return Object.freeze({ source, nativeLeaf:schema.nativeLeaf, schemaHash, relativeSource, profile:options.profile });
}
