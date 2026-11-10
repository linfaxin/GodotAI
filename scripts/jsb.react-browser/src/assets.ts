import type { ManifestResource, SourceLocation } from "@godot-js/react/contracts";
import type { ProjectSnapshot } from "./contracts.js";

export class AssetCompileError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = "AssetCompileError"; }
}
export interface DecodedImage { width: number; height: number; rgba: Uint8Array }
export type ImageDecoder = (bytes: Uint8Array, mime: "image/png" | "image/jpeg", options: { signal?: AbortSignal; maxDimension?: number; maxPixels?: number }) => Promise<DecodedImage>;
export interface AssetBudgets {
  maxAssets?: number; maxInputBytes?: number; maxOutputBytes?: number;
  maxImageDimension?: number; maxImagePixels?: number; maxTextBytes?: number; maxResourceDepth?: number;
}
export interface CompiledAssets {
  files: Map<string, Uint8Array>;
  resources: Record<string, ManifestResource>;
  sourceOrigins: Record<string, SourceLocation>;
  sourceHashes: Record<string, string>;
}
/** Actual browser capabilities. No placeholder prevalidated-package API is public. */
export const BROWSER_ASSET_CAPABILITIES = Object.freeze({
  templates: false,
  prevalidatedTemplatePackages: false,
  images: Object.freeze(["image/png", "image/jpeg"] as const),
  resourceTypes: Object.freeze(["Resource", "CanvasItemMaterial", "CircleShape2D", "RectangleShape2D", "CapsuleShape2D"] as const),
});

const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
const simpleResources = new Set<string>(BROWSER_ASSET_CAPABILITIES.resourceTypes);
function fail(code: string, message: string): never { throw new AssetCompileError(code, message); }
async function hash(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer))].map(value => value.toString(16).padStart(2, "0")).join("");
}
function pathOf(source: string, relativeTo?: string): string {
  if (source.startsWith("res://")) source = source.slice(6);
  else if (relativeTo && !source.startsWith("/")) source = `${relativeTo.slice(0, relativeTo.lastIndexOf("/"))}/${source}`;
  if (/[\\\u0000-\u001f\u007f%?#:]/.test(source)) fail("E_ASSET_PATH", `Unsupported asset path ${JSON.stringify(source)}`);
  const parts: string[] = [];
  for (const segment of source.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { if (!parts.length) fail("E_ASSET_PATH", `Asset path escapes the project: ${source}`); parts.pop(); }
    else parts.push(segment);
  }
  if (!parts.length || parts[0] === "node_modules" || parts[0] === ".godot" || parts.join("/").startsWith("generated/react/")) fail("E_ASSET_PATH", `Asset must be a project input: ${source}`);
  return `/${parts.join("/")}`;
}
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 255) return undefined;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217 || marker === 218) return undefined;
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return undefined;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8) return undefined;
      return { height: bytes[offset + 3] * 256 + bytes[offset + 4], width: bytes[offset + 5] * 256 + bytes[offset + 6] };
    }
    offset += length;
  }
  return undefined;
}

/** Browser-native decoding; no Godot importer, Node, image library or file server. */
export const decodeBrowserImage: ImageDecoder = async (bytes, mime, options) => {
  options.signal?.throwIfAborted();
  if (typeof globalThis.createImageBitmap !== "function" || typeof globalThis.OffscreenCanvas !== "function") fail("E_IMAGE_DECODER", "Image assets require createImageBitmap and OffscreenCanvas, or an injected decoder");
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  let bitmap: ImageBitmap;
  try { bitmap = await globalThis.createImageBitmap(new Blob([copy.buffer], { type: mime }), { premultiplyAlpha: "none", colorSpaceConversion: "none" }); }
  catch (error) { options.signal?.throwIfAborted(); return fail("E_IMAGE_DECODE", `The browser could not decode ${mime}: ${String(error)}`); }
  try {
    options.signal?.throwIfAborted();
    if (bitmap.width <= 0 || bitmap.height <= 0 || bitmap.width > (options.maxDimension ?? 4096) || bitmap.height > (options.maxDimension ?? 4096) || bitmap.width * bitmap.height > (options.maxPixels ?? 1024 * 1024)) fail("E_IMAGE_BUDGET", `Decoded image dimensions exceed the configured budget: ${bitmap.width}x${bitmap.height}`);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) fail("E_IMAGE_DECODER", "OffscreenCanvas 2D context is unavailable");
    context.imageSmoothingEnabled = false; context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    options.signal?.throwIfAborted();
    return { width: bitmap.width, height: bitmap.height, rgba: new Uint8Array(image.data) };
  } finally { bitmap.close(); }
};

interface Vector { kind: "vector2"; x: number; y: number }
interface Reference { kind: "external-resource"; id: string }
type Value = string | number | boolean | null | Vector | Reference;
interface Section { name: string; attributes: Record<string, Value>; properties: Record<string, Value> }
interface Token { kind: "word" | "string" | "number" | "punct" | "newline" | "end"; value: string; line: number }
/** Closed grammar, intentionally smaller than Godot's general text resource loader. */
function parseResource(text: string): Section[] {
  const tokens: Token[] = []; let offset = 0, line = 1;
  while (offset < text.length) {
    const c = text[offset];
    if (c === " " || c === "\t" || c === "\r") { offset++; continue; }
    if (c === "\n") { tokens.push({ kind: "newline", value: c, line: line++ }); offset++; continue; }
    if (c === ";") { while (offset < text.length && text[offset] !== "\n") offset++; continue; }
    if (c === '"') {
      const start = offset++; let escaped = false, closed = false;
      while (offset < text.length) {
        const next = text[offset++];
        if (next === "\n" || next === "\r") fail("E_ASSET_SYNTAX", `Multiline resource string on line ${line}`);
        if (next === '"' && !escaped) { closed = true; break; }
        escaped = next === "\\" && !escaped;
      }
      if (!closed) fail("E_ASSET_SYNTAX", `Unterminated resource string on line ${line}`);
      let value: string; try { value = JSON.parse(text.slice(start, offset)); } catch { return fail("E_ASSET_SYNTAX", `Unsupported resource string escape on line ${line}`); }
      tokens.push({ kind: "string", value, line }); continue;
    }
    const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(offset));
    if (number) { tokens.push({ kind: "number", value: number[0], line }); offset += number[0].length; continue; }
    const word = /^[A-Za-z_][A-Za-z_0-9/]*\b/.exec(text.slice(offset));
    if (word) { tokens.push({ kind: "word", value: word[0], line }); offset += word[0].length; continue; }
    if ("[]=(),".includes(c)) { tokens.push({ kind: "punct", value: c, line }); offset++; continue; }
    fail("E_ASSET_SYNTAX", `Unsupported resource token ${JSON.stringify(c)} on line ${line}`);
  }
  tokens.push({ kind: "end", value: "", line }); let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const expect = (value: string) => { const token = take(); if (token.value !== value) fail("E_ASSET_SYNTAX", `Expected ${value} on line ${token.line}`); };
  const word = () => { const token = take(); if (token.kind !== "word") fail("E_ASSET_SYNTAX", `Expected identifier on line ${token.line}`); return token.value; };
  function value(): Value {
    const token = take();
    if (token.kind === "string") return token.value;
    if (token.kind === "number") { const result = Number(token.value); if (!Number.isFinite(result)) fail("E_ASSET_VALUE", "Resource numbers must be finite"); return result; }
    if (token.kind !== "word") fail("E_ASSET_SYNTAX", `Expected resource value on line ${token.line}`);
    if (token.value === "true" || token.value === "false") return token.value === "true";
    if (token.value === "null") return null;
    if (!["Vector2", "ExtResource"].includes(token.value)) fail("E_ASSET_VALUE", `Unsupported resource constructor ${token.value}`);
    expect("("); const values: Value[] = [];
    if (peek().value !== ")") { values.push(value()); while (peek().value === ",") { take(); values.push(value()); } }
    expect(")");
    if (token.value === "ExtResource") {
      if (values.length !== 1 || typeof values[0] !== "string") fail("E_ASSET_VALUE", "ExtResource requires one string id");
      return { kind: "external-resource", id: values[0] };
    }
    if (values.length !== 2 || typeof values[0] !== "number" || typeof values[1] !== "number") fail("E_ASSET_VALUE", "Vector2 requires two finite numbers");
    return { kind: "vector2", x: values[0], y: values[1] };
  }
  const sections: Section[] = []; let section: Section | undefined;
  while (peek().kind !== "end") {
    if (peek().kind === "newline") { take(); continue; }
    if (peek().value === "[") {
      take(); const name = word(), attributes: Record<string, Value> = Object.create(null);
      while (peek().value !== "]") { const key = word(); expect("="); if (Object.hasOwn(attributes, key)) fail("E_ASSET_SYNTAX", `Duplicate header ${key}`); attributes[key] = value(); }
      take(); section = { name, attributes, properties: Object.create(null) }; sections.push(section);
    } else {
      if (!section) fail("E_ASSET_SYNTAX", "Resource property before its header");
      const key = word(); expect("="); if (Object.hasOwn(section.properties, key)) fail("E_ASSET_SYNTAX", `Duplicate property ${key}`); section.properties[key] = value();
    }
    if (peek().kind !== "newline" && peek().kind !== "end") fail("E_ASSET_SYNTAX", `Unexpected trailing resource token on line ${peek().line}`);
  }
  return sections;
}
function header(section: Section, required: string[], optional: string[] = []): void {
  for (const key of required) if (!Object.hasOwn(section.attributes, key)) fail("E_ASSET_HEADER", `Missing ${section.name}.${key}`);
  for (const key of Object.keys(section.attributes)) if (![...required, ...optional].includes(key)) fail("E_ASSET_HEADER", `Unsupported ${section.name} header ${key}`);
}
function validateProperties(type: string, properties: Record<string, Value>): void {
  const shape = type === "RectangleShape2D" ? ["size"] : type === "CircleShape2D" ? ["radius"] : type === "CapsuleShape2D" ? ["radius", "height"] : [];
  const material = type === "CanvasItemMaterial" ? ["blend_mode", "light_mode", "particles_animation", "particles_anim_h_frames", "particles_anim_v_frames", "particles_anim_loop"] : [];
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 3.4028234663852886e38;
  for (const [key, value] of Object.entries(properties)) {
    if (key === "script") fail("E_ASSET_SCRIPT", "Resource scripts are not valid browser asset inputs");
    if (!["resource_name", "resource_local_to_scene", ...shape, ...material].includes(key)) fail("E_ASSET_PROPERTY", `Unsupported ${type}.${key}`);
    if (key === "resource_name" && (typeof value !== "string" || value.length > 4096)) fail("E_ASSET_PROPERTY", `Invalid ${type}.${key}`);
    if (key === "resource_local_to_scene" && value !== false) fail("E_ASSET_LOCAL_RESOURCE", "Scene-local resources require a separately certified template profile");
    if (["radius", "height"].includes(key) && !positive(value)) fail("E_ASSET_PROPERTY", `Invalid positive finite ${type}.${key}`);
    if (key === "size" && (!value || typeof value !== "object" || value.kind !== "vector2" || !positive(value.x) || !positive(value.y))) fail("E_ASSET_PROPERTY", `Invalid positive finite ${type}.size`);
    if (["particles_animation", "particles_anim_loop"].includes(key) && typeof value !== "boolean") fail("E_ASSET_PROPERTY", `Invalid boolean ${type}.${key}`);
    if (["blend_mode", "light_mode", "particles_anim_h_frames", "particles_anim_v_frames"].includes(key)) {
      const min = key.startsWith("particles_") ? 1 : 0, max = key === "blend_mode" ? 4 : key === "light_mode" ? 2 : 2147483647;
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail("E_ASSET_PROPERTY", `Invalid integer ${type}.${key}`);
    }
  }
}
function encodeValue(value: Value): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return value.kind === "vector2" ? `Vector2(${value.x}, ${value.y})` : `ExtResource(${JSON.stringify(value.id)})`;
}

export async function compileAssets(snapshot: ProjectSnapshot, options: {
  generation: string; signal?: AbortSignal; decodeImage?: ImageDecoder; budgets?: AssetBudgets;
}): Promise<CompiledAssets> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.generation)) fail("E_ASSET_GENERATION", "Generation must be a safe immutable identifier");
  const limits = { maxAssets: 128, maxInputBytes: 32 * 1024 * 1024, maxOutputBytes: 32 * 1024 * 1024, maxImageDimension: 4096, maxImagePixels: 1024 * 1024, maxTextBytes: 256 * 1024, maxResourceDepth: 32, ...options.budgets };
  const abort = () => options.signal?.throwIfAborted(); abort();
  const result: CompiledAssets = { files: new Map(), resources: Object.create(null), sourceOrigins: Object.create(null), sourceHashes: Object.create(null) };
  const inputFiles = new Map<string, Uint8Array>();
  for (const [path, bytes] of snapshot.files) {
    // SDK and lib files are irrelevant here; do not normalize them as author assets.
    if (/^(?:\/)?(?:node_modules|typescript)(?:\/|$)/.test(path)) continue;
    const canonical = pathOf(path); if (inputFiles.has(canonical)) fail("E_ASSET_PATH", `Duplicate asset input ${canonical}`); inputFiles.set(canonical, bytes.slice());
  }
  const configured = Object.entries(snapshot.config.assets ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (configured.length > limits.maxAssets) fail("E_ASSET_BUDGET", `More than ${limits.maxAssets} configured assets`);
  const sourceIds = new Map<string, string>(), cached = new Map<string, { id: string; resource: ManifestResource }>();
  for (const [id, asset] of configured) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) fail("E_ASSET_ID", `Invalid asset id ${id}`);
    const path = pathOf(asset.source); if (!sourceIds.has(path)) sourceIds.set(path, id);
  }
  const loading = new Set<string>(); let inputSize = 0, outputSize = 0;
  async function load(source: string, declaredType: string, depth = 0): Promise<{ id: string; resource: ManifestResource }> {
    abort();
    const path = pathOf(source), existing = cached.get(path);
    if (existing) { if (existing.resource.type !== declaredType) fail("E_ASSET_TYPE", `Conflicting types for ${path}`); return existing; }
    if (loading.has(path)) fail("E_ASSET_CYCLE", `Cyclic asset dependency at ${path}`);
    if (depth >= limits.maxResourceDepth) fail("E_ASSET_DEPTH", `Resource depth exceeds ${limits.maxResourceDepth}`);
    if (loading.size + cached.size >= limits.maxAssets) fail("E_ASSET_BUDGET", `More than ${limits.maxAssets} resource inputs`);
    const bytes = inputFiles.get(path); if (!bytes) fail("E_ASSET_NOT_FOUND", `Asset is missing from the immutable snapshot: ${path}`);
    inputSize += bytes.byteLength; if (inputSize > limits.maxInputBytes) fail("E_ASSET_BUDGET", "Asset inputs exceed the configured byte budget");
    const sourceUri = `res://${path.slice(1)}`, sourceHash = await hash(bytes);
    result.sourceHashes[sourceUri] = sourceHash;
    const id = sourceIds.get(path) ?? `asset-dep-${(await hash(encoder.encode(sourceUri))).slice(0, 24)}`;
    if (Object.hasOwn(result.resources, id)) fail("E_ASSET_ID", `Asset id collision: ${id}`);
    loading.add(path);
    try {
      let text: string; const dependencies: string[] = [];
      if (/\.tscn$/i.test(path) || declaredType === "PackedScene") fail("E_TEMPLATE_PREVALIDATION_REQUIRED", "Browser templates are disabled: native SceneState validation and a trusted prevalidated-package consumer are not implemented; arbitrary scene text and self-declared certificates are not accepted");
      if (/\.(?:png|jpe?g)$/i.test(path)) {
        if (declaredType !== "Texture2D") fail("E_ASSET_TYPE", `PNG/JPEG inputs compile as Texture2D, received ${declaredType}`);
        const png = /\.png$/i.test(path), mime = png ? "image/png" : "image/jpeg";
        const validMagic = png ? bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        if (!validMagic) fail("E_IMAGE_FORMAT", `Invalid ${mime} signature for ${path}`);
        // PNG dimensions are available before decompression, so reject a large
        // IHDR before asking the browser to allocate its decoded bitmap.
        if (png && bytes.length >= 24 && bytes[12] === 73 && bytes[13] === 72 && bytes[14] === 68 && bytes[15] === 82) {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), width = view.getUint32(16), height = view.getUint32(20);
          if (!width || !height || width > limits.maxImageDimension || height > limits.maxImageDimension || width * height > limits.maxImagePixels) fail("E_IMAGE_BUDGET", `PNG dimensions exceed the configured budget: ${width}x${height}`);
        }
        if (!png) {
          const dimensions = jpegDimensions(bytes);
          if (dimensions && (!dimensions.width || !dimensions.height || dimensions.width > limits.maxImageDimension || dimensions.height > limits.maxImageDimension || dimensions.width * dimensions.height > limits.maxImagePixels)) fail("E_IMAGE_BUDGET", `JPEG dimensions exceed the configured budget: ${dimensions.width}x${dimensions.height}`);
        }
        const image = await (options.decodeImage ?? decodeBrowserImage)(bytes.slice(), mime, { signal: options.signal, maxDimension: limits.maxImageDimension, maxPixels: limits.maxImagePixels }); abort();
        if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0 || image.width > limits.maxImageDimension || image.height > limits.maxImageDimension || image.width * image.height > limits.maxImagePixels) fail("E_IMAGE_BUDGET", `Decoded image dimensions exceed the configured budget: ${image.width}x${image.height}`);
        if (!(image.rgba instanceof Uint8Array) || image.rgba.byteLength !== image.width * image.height * 4) fail("E_IMAGE_DATA", "Decoder must supply exactly width * height * 4 RGBA8 bytes");
        if (image.rgba.length * 4 + outputSize + 512 > limits.maxOutputBytes) fail("E_ASSET_BUDGET", "Image's text resource would exceed the output budget");
        const chunks: string[] = [];
        for (let offset = 0; offset < image.rgba.length; offset += 4096) { abort(); chunks.push(Array.from(image.rgba.subarray(offset, offset + 4096)).join(",")); }
        // Godot 4.6.1 core/io/image.cpp::_set_data requires these five dictionary keys,
        // with the format NAME ("RGBA8"), not its numeric FORMAT_RGBA8 enum value.
        text = `[gd_resource type="ImageTexture" load_steps=2 format=3]\n\n[sub_resource type="Image" id="Image_asset"]\ndata = {\n"data": PackedByteArray(${chunks.join(",")}),\n"format": "RGBA8",\n"height": ${image.height},\n"mipmaps": false,\n"width": ${image.width}\n}\n\n[resource]\nimage = SubResource("Image_asset")\n`;
      } else {
        if (!path.endsWith(".tres") || !simpleResources.has(declaredType)) fail("E_ASSET_FORMAT", `Unsupported browser asset ${declaredType}: ${path}`);
        if (bytes.byteLength > limits.maxTextBytes) fail("E_ASSET_BUDGET", `${path} exceeds the text resource budget`);
        let sourceText: string; try { sourceText = decoder.decode(bytes); } catch { return fail("E_ASSET_SYNTAX", `${path} is not valid UTF-8`); }
        const sections = parseResource(sourceText), first = sections[0];
        if (!first || first.name !== "gd_resource") fail("E_ASSET_HEADER", `Expected gd_resource in ${path}`);
        header(first, ["type", "format"], ["load_steps", "uid"]);
        if (first.attributes.type !== declaredType || first.attributes.format !== 3 || Object.keys(first.properties).length) fail("E_ASSET_TYPE", `Resource type/format mismatch in ${path}`);
        if (sections.filter(section => section.name === "resource").length !== 1) fail("E_ASSET_HEADER", `Exactly one [resource] body is required in ${path}`);
        const external = new Map<string, { resource: ManifestResource; id: string }>();
        for (const section of sections.slice(1)) {
          if (section.attributes.type === "Script" || Object.hasOwn(section.properties, "script")) fail("E_ASSET_SCRIPT", "Scripts cannot enter the browser resource closure");
          if (section.name === "ext_resource") {
            header(section, ["type", "path", "id"], ["uid"]);
            const { type, path: dependencyPath, id: referenceId } = section.attributes;
            if (typeof type !== "string" || typeof dependencyPath !== "string" || typeof referenceId !== "string" || !referenceId || Object.keys(section.properties).length) fail("E_ASSET_HEADER", `Invalid ext_resource in ${path}`);
            if (external.has(referenceId)) fail("E_ASSET_HEADER", `Duplicate external resource id ${referenceId}`);
            const dependency = await load(pathOf(dependencyPath, path), type, depth + 1);
            external.set(referenceId, dependency); dependencies.push(dependency.id);
          } else if (section.name === "resource") { header(section, []); validateProperties(declaredType, section.properties); }
          else fail("E_ASSET_SECTION", `Unsupported resource section ${section.name}`);
        }
        text = `[gd_resource type=${JSON.stringify(declaredType)}${external.size ? ` load_steps=${external.size + 1}` : ""} format=3]\n`;
        for (const [referenceId, dependency] of external) text += `\n[ext_resource type=${JSON.stringify(dependency.resource.type)} path=${JSON.stringify(dependency.resource.uri)} id=${JSON.stringify(referenceId)}]\n`;
        const body = sections.find(section => section.name === "resource")!;
        text += `\n[resource]\n${Object.entries(body.properties).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key} = ${encodeValue(value)}\n`).join("")}`;
      }
      const output = encoder.encode(text), digest = await hash(output); outputSize += output.byteLength;
      if (outputSize > limits.maxOutputBytes) fail("E_ASSET_BUDGET", "Compiled assets exceed the configured output budget");
      const uri = `res://generated/react/${options.generation}/assets/${digest}.tres`;
      result.files.set(uri, output); result.sourceOrigins[uri] = { source: sourceUri, line: 0, column: 0 };
      const resource: ManifestResource = { uri, sha256: digest, type: declaredType, dependencies: [...new Set(dependencies)].sort(), importedArtifacts: [uri] };
      const loaded = { id, resource }; result.resources[id] = resource; cached.set(path, loaded); return loaded;
    } finally { loading.delete(path); }
  }
  for (const [id, asset] of configured) { const loaded = await load(asset.source, asset.type); result.resources[id] = loaded.resource; }
  return result;
}

export { parseSceneText } from "@godot-js/react-build/scene-text";
