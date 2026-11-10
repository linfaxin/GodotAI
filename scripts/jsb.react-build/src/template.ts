import path from "node:path";
import { promises as fs } from "node:fs";
import { canonicalJson, validateTemplatePlan, type TemplatePlanV1, type TemplateResourceV1, type TemplateNodeV1 } from "@godot-js/react/contracts";
import { getProfileSchema, getHostSchema, validateInitialProperties } from "@godot-js/react/schema";
import { command, fromRes, sha256, slash, toRes, within, write, type Snapshot,type CommandRunner } from "./fs.js";
import { extractorSource } from "./extractor.js";
import { fail, type ProjectConfig } from "./types.js";

import { parseSceneText, type Section } from "./core/scene-text.js";
export { parseSceneText } from "./core/scene-text.js";
interface ResourceReference { kind: "external-resource"; id: string; }
const reference = (value: unknown): value is ResourceReference => !!value && typeof value === "object" && (value as ResourceReference).kind === "external-resource";


function headerKeys(section: Section, required: string[], optional: string[] = []): void {
  for (const key of required) if (!Object.hasOwn(section.attributes, key)) fail("E_IMPORT_HEADER", `Missing ${section.name}.${key}`);
  for (const key of Object.keys(section.attributes)) if (![...required, ...optional].includes(key)) fail("E_IMPORT_UNSUPPORTED", `Unsupported ${section.name} header ${key}`);
}
function noSectionProperties(section:Section):void{if(Object.keys(section.properties).length)fail("E_IMPORT_HEADER",`${section.name} cannot contain properties`);}
function checkNoScript(sections: Section[]): void {
  for (const section of sections) {
    if (section.attributes.type === "Script" || Object.hasOwn(section.properties, "script")) fail("E_IMPORT_SCRIPT", "Scripts are not valid managed template inputs");
    if (["sub_resource", "connection"].includes(section.name)) fail("E_IMPORT_UNSUPPORTED", `Unsupported template section ${section.name}`);
  }
}

export class ResourceGraph {
  readonly resources = new Map<string, TemplateResourceV1>();
  readonly files: string[] = [];
  private readonly loading = new Set<string>();
  constructor(private readonly snapshot: Snapshot, private readonly localResources = false) {}
  async load(uri: string, declared: string): Promise<TemplateResourceV1> {
    if (!["Resource", "CanvasItemMaterial", "CircleShape2D", "RectangleShape2D", "CapsuleShape2D"].includes(declared) || !uri.endsWith(".tres")) fail("E_IMPORT_RESOURCE", `Unsupported resource ${declared}: ${uri}`);
    if (this.loading.has(uri)) fail("E_IMPORT_RESOURCE", `Cyclic resource graph: ${uri}`);
    const cached = this.resources.get(uri); if (cached) { if(cached.type!==declared)fail("E_IMPORT_RESOURCE",`Conflicting declared resource types for ${uri}`);return cached; }
    this.loading.add(uri);
    try {
      const file = fromRes(this.snapshot.root, uri), contents = await fs.readFile(file), parsed = parseSceneText(contents.toString("utf8")); checkNoScript(parsed);
      const local = parsed.some(s => s.properties.resource_local_to_scene === true);
      if (local && !this.localResources) fail("E_IMPORT_LOCAL_RESOURCE", "local-to-scene requires explicit template-local-v1 profile");
      if(local&&!["Resource","CanvasItemMaterial"].includes(declared))fail("E_IMPORT_LOCAL_RESOURCE",`Local ${declared} is outside template-local-v1 certification`);
      if (parsed[0]?.name !== "gd_resource") fail("E_IMPORT_RESOURCE", `Expected gd_resource: ${uri}`);
      headerKeys(parsed[0], ["type", "format"], ["load_steps", "uid"]);
      noSectionProperties(parsed[0]);
      if (parsed[0].attributes.type !== declared || parsed[0].attributes.format !== 3) fail("E_IMPORT_RESOURCE", `Resource type/format mismatch: ${uri}`);
      if(parsed.filter(section=>section.name==="resource").length!==1)fail("E_IMPORT_RESOURCE",`Expected exactly one [resource] body: ${uri}`);
      const dependencies = new Map<string, TemplateResourceV1>();
      for (const section of parsed.slice(1)) {
        if (section.name === "ext_resource") { headerKeys(section, ["type", "path", "id"], ["uid"]);noSectionProperties(section);const id=String(section.attributes.id);if(dependencies.has(id))fail("E_IMPORT_RESOURCE",`Duplicate resource id ${id}`);dependencies.set(id, await this.load(String(section.attributes.path), String(section.attributes.type))); }
        else if (section.name === "resource") {
          headerKeys(section, []);
          for (const [key, value] of Object.entries(section.properties)) {
            const shapeProperties = declared === "RectangleShape2D" ? ["size"] : declared === "CircleShape2D" ? ["radius"] : declared === "CapsuleShape2D" ? ["radius", "height"] : [];
            if (!["resource_name", "resource_local_to_scene", ...shapeProperties, ...(declared === "CanvasItemMaterial" ? ["blend_mode", "light_mode", "particles_animation", "particles_anim_h_frames", "particles_anim_v_frames", "particles_anim_loop"] : [])].includes(key)) fail("E_IMPORT_RESOURCE", `Unsupported ${declared}.${key}`);
            if (key === "resource_local_to_scene" && typeof value !== "boolean" || key === "resource_name" && typeof value !== "string") fail("E_IMPORT_RESOURCE", `Invalid ${declared}.${key}`);
            if (["radius", "height"].includes(key) && (typeof value !== "number" || value <= 0 || value > 3.4028234663852886e38)) fail("E_IMPORT_RESOURCE", `Invalid positive finite ${declared}.${key}`);
            if (["particles_animation","particles_anim_loop"].includes(key)&&typeof value!=="boolean")fail("E_IMPORT_RESOURCE",`Invalid boolean ${declared}.${key}`);
            if (["blend_mode","light_mode","particles_anim_h_frames","particles_anim_v_frames"].includes(key)) {
              const minimum=key.startsWith("particles_")?1:0,maximum=key==="blend_mode"?4:key==="light_mode"?2:2147483647;
              if(typeof value!=="number"||!Number.isInteger(value)||value<minimum||value>maximum)fail("E_IMPORT_RESOURCE",`Invalid integer ${declared}.${key}`);
            }
            if(key==="size") {const vector=value as {x?:unknown;y?:unknown};if(!vector||typeof vector.x!=="number"||typeof vector.y!=="number"||vector.x<=0||vector.y<=0||Math.max(vector.x,vector.y)>3.4028234663852886e38)fail("E_IMPORT_RESOURCE",`Invalid positive finite ${declared}.size`);}
            if (reference(value) && !dependencies.has(value.id)) fail("E_IMPORT_RESOURCE", `Unknown resource ${value.id}`);
          }
        } else fail("E_IMPORT_UNSUPPORTED", `Unsupported resource section ${section.name}`);
      }
      const result: TemplateResourceV1 = { resourceId: `asset-${sha256(uri).slice(0, 20)}`, uri, type: declared, sha256: sha256(contents), dependencies: [...dependencies.values()].map(r => r.resourceId), sharingPolicy: local ? "instance" : "shared" };
      this.resources.set(uri, result); this.files.push(file); return result;
    } finally { this.loading.delete(uri); }
  }
}
/** Re-emit only the preflighted resource grammar, rebasing references and removing stale UIDs. */
export function freezeResourceText(text:string,uris:ReadonlyMap<string,string>):string{
  const sections=parseSceneText(text);checkNoScript(sections);
  const encode=(value:unknown):string=>{
    if(value===null||typeof value==="string"||typeof value==="number"||typeof value==="boolean")return JSON.stringify(value);
    if(reference(value))return `ExtResource(${JSON.stringify(value.id)})`;
    const item=value as Record<string,unknown>;
    if(item&&Object.keys(item).length===2&&typeof item.x==="number"&&typeof item.y==="number")return `Vector2(${item.x}, ${item.y})`;
    if(item&&["r","g","b","a"].every(key=>typeof item[key]==="number"))return `Color(${item.r}, ${item.g}, ${item.b}, ${item.a})`;
    return fail("E_IMPORT_VALUE","Unsupported value in frozen resource");
  };
  return sections.map(section=>{
    const attributes=Object.entries(section.attributes).filter(([key])=>key!=="uid").map(([key,value])=>`${key}=${encode(section.name==="ext_resource"&&key==="path"?uris.get(String(value))??fail("E_IMPORT_RESOURCE",`Missing frozen dependency ${String(value)}`):value)}`);
    return `[${section.name}${attributes.length?` ${attributes.join(" ")}`:""}]\n${Object.entries(section.properties).map(([key,value])=>`${key} = ${encode(value)}`).join("\n")}\n`;
  }).join("\n");
}

export async function rewriteTemplateModule(template:ImportedTemplate):Promise<void>{
  const {plan}=template;
  await write(template.module,`// Generated from ${plan.source}; every node is owned by React.\nimport type {ComponentProps,ComponentType} from "react";\nimport {createTemplateComponent,${plan.nodes[0].nativeType}} from "@godot-js/react";\nexport type TemplateProps = Omit<ComponentProps<typeof ${plan.nodes[0].nativeType}>, "children">;\nconst Template = createTemplateComponent(${canonicalJson(plan)}) as ComponentType<TemplateProps>;\nexport default Template;\n`);
}

export interface ImportedTemplate { id: string; plan: TemplatePlanV1; module: string; declaration: string; resourceFiles: string[]; }
export async function importTemplate(id: string, source: string, snapshot: Snapshot, generatedRoot: string, options: {profile?: "template-t0" | "template-local-v1" | "template-structural-v1";hostProfile?:string} = {}, ancestors: readonly string[] = []): Promise<ImportedTemplate> {
  if (ancestors.includes(source)) fail("E_IMPORT_CYCLE", `Recursive PackedScene dependency: ${[...ancestors, source].join(" -> ")}`);
  if (ancestors.length >= 32) fail("E_IMPORT_DEPTH", "PackedScene dependency depth exceeds the certified limit (32)");
  const filename = within(snapshot.root, source), sourceUri = `res://${slash(source)}`;
  if (!source.endsWith(".tscn")) fail("E_IMPORT_FORMAT", `Only text .tscn inputs supported: ${source}`);
  const bytes = await fs.readFile(filename), sections = parseSceneText(bytes.toString("utf8")); checkNoScript(sections);
  if (sections[0]?.name !== "gd_scene") fail("E_IMPORT_HEADER", "Expected gd_scene");
  headerKeys(sections[0], ["format"], ["load_steps", "uid"]); if (sections[0].attributes.format !== 3) fail("E_IMPORT_FORMAT", "Only TSCN format 3 supported");
  noSectionProperties(sections[0]);
  const graph = new ResourceGraph(snapshot, options.profile === "template-local-v1"), asset = graph.load.bind(graph);
  const ext = new Map<string, TemplateResourceV1>();
  const scenes = new Map<string, ImportedTemplate>(), dependencyFiles: string[] = [];
  for (const section of sections.slice(1)) if (section.name === "ext_resource") {
    headerKeys(section, ["type", "path", "id"], ["uid"]);
    noSectionProperties(section);
    const key = String(section.attributes.id); if (ext.has(key) || scenes.has(key)) fail("E_IMPORT_RESOURCE", `Duplicate resource id ${key}`);
    if (section.attributes.type === "PackedScene") {
      if(options.profile!=="template-structural-v1")fail("E_IMPORT_UNSUPPORTED","Nested/inherited PackedScenes require explicit template-structural-v1; combining nested scenes with local resources is not certified");
      const uri = String(section.attributes.path), relative = slash(path.relative(snapshot.root, fromRes(snapshot.root, uri)));
      const child = await importTemplate(`dependency-${sha256(uri).slice(0,16)}`, relative, snapshot, generatedRoot, options, [...ancestors, source]);
      scenes.set(key, child); dependencyFiles.push(fromRes(snapshot.root, uri), ...child.resourceFiles);
      for (const resource of child.plan.resources) graph.resources.set(resource.uri, resource);
    } else ext.set(key, await asset(String(section.attributes.path), String(section.attributes.type)));
  }
  const nodes: TemplateNodeV1[] = [], paths = new Map<string, TemplateNodeV1>(), counts = new Map<string, number>();
  for (const section of sections.slice(1)) {
    if (section.name === "ext_resource") continue;
    if (section.name !== "node") fail("E_IMPORT_UNSUPPORTED", `Unsupported section ${section.name}`);
    headerKeys(section, ["name"], ["type", "parent", "index", "instance"]);
    const name = String(section.attributes.name); if (!name || /[\/:@.\0]/.test(name)) fail("E_IMPORT_NAME", `Invalid node name ${name}`);
    const parentPath = section.attributes.parent;
    if (nodes.length && typeof parentPath !== "string") fail("E_IMPORT_PARENT", "Template must have exactly one root");
    if (!nodes.length && parentPath !== undefined) fail("E_IMPORT_PARENT", "Root cannot have a parent");
    const parent = parentPath === undefined ? undefined : paths.get(parentPath as string);
    if (parentPath !== undefined && !parent) fail("E_IMPORT_PARENT", `Parent must precede child: ${String(parentPath)}`);
    const nodePath = parent ? (parentPath === "." ? name : `${String(parentPath)}/${name}`) : ".";
    const existing = paths.get(nodePath), instanceRef = section.attributes.instance;
    const instance = reference(instanceRef) ? scenes.get(instanceRef.id) : undefined;
    if (instanceRef !== undefined && !instance) fail("E_IMPORT_INSTANCE", "Instance must reference a preflighted PackedScene");
    if (instance && section.attributes.type !== undefined) fail("E_IMPORT_INSTANCE", "Instance cannot replace its native root type");
    if (existing && (section.attributes.type !== undefined || instance)) fail("E_IMPORT_NAME", `Duplicate node path ${nodePath}`);
    const nativeType = instance?.plan.nodes[0].nativeType ?? existing?.nativeType ?? String(section.attributes.type);
    if (!getProfileSchema(options.hostProfile).profile.hosts.includes(nativeType)) fail("E_PROFILE_UNSUPPORTED", `Template host ${nativeType} is outside ${options.hostProfile ?? "core-ui-v1"}`);
    const initial: Record<string, unknown> = {};
    const schema = getHostSchema(nativeType, options.hostProfile);
    for (const [key, raw] of Object.entries(section.properties)) {
      if (key === "owner") fail("E_IMPORT_OWNER", "Custom owner paths are not in template-t0");
      const field = Object.entries(schema.properties).find(([, prop]) => prop.nativeName === key || prop.accessName === key || key === prop.publicName);
      if (!field) fail("E_IMPORT_PROPERTY", `Unsupported ${nativeType}.${key}`);
      const value = reference(raw) ? (() => { const resource = ext.get(raw.id); if (!resource) fail("E_IMPORT_RESOURCE", `Missing ExtResource ${raw.id}`); return { kind: "asset", id: resource.resourceId, type: resource.type, scope: resource.sharingPolicy }; })() : raw;
      initial[field[0]] = value;
    }
    const siblingOrder = existing?.siblingOrder ?? counts.get(parent?.nodeId ?? "root") ?? 0;
    if (section.attributes.index !== undefined && section.attributes.index !== siblingOrder) fail("E_IMPORT_ORDER", "Explicit index must match serialized order");
    validateInitialProperties(nativeType, initial, "$.initial", options.hostProfile, options.profile === "template-local-v1");
    if (existing) { Object.assign(existing.initial, initial); existing.name = name; existing.source = { source: sourceUri, line: section.line - 1, column: 0 }; continue; }
    counts.set(parent?.nodeId ?? "root", siblingOrder + 1);
    if (instance) {
      if (nodes.length + instance.plan.nodes.length > 10_000) fail("E_IMPORT_LIMIT", "Expanded template exceeds 10,000 nodes");
      const ids = new Map(instance.plan.nodes.map((n, i) => [n.nodeId, `node-${nodes.length + i}`]));
      const childPaths = new Map<string,string>();
      for (const child of instance.plan.nodes) {
        const isRoot = child.nodeId === instance.plan.rootId;
        const childPath = isRoot ? nodePath : `${childPaths.get(child.parentId!) === "." ? "" : `${childPaths.get(child.parentId!)}/`}${child.name}`;
        const cloned: TemplateNodeV1 = { ...child, nodeId: ids.get(child.nodeId)!, parentId: isRoot ? parent?.nodeId ?? null : ids.get(child.parentId!)!, name: isRoot ? name : child.name, siblingOrder: isRoot ? siblingOrder : child.siblingOrder, initial: {...child.initial, ...(isRoot ? initial : {})}, ownerId: isRoot ? parent ? nodes[0].nodeId : null : child.ownerId ? ids.get(child.ownerId)! : null };
        nodes.push(cloned); paths.set(childPath, cloned); childPaths.set(child.nodeId, childPath);
        if (!isRoot) counts.set(cloned.parentId!, Math.max(counts.get(cloned.parentId!) ?? 0, cloned.siblingOrder + 1));
      }
      continue;
    }
    const node: TemplateNodeV1 = { nodeId: `node-${nodes.length}`, nativeType, parentId: parent?.nodeId ?? null, siblingOrder, name, initial, ownerId: parent ? nodes[0].nodeId : null, source: { source: sourceUri, line: section.line - 1, column: 0 } };
    paths.set(nodePath, node); nodes.push(node);
  }
  const plan: TemplatePlanV1 = { schemaVersion: 1, assetId: id, source: sourceUri, sourceHash: sha256(bytes), snapshotHash: snapshot.hash, profile: options.profile ?? "template-t0", rootId: nodes[0]?.nodeId ?? "", nodes, resources: [...graph.resources.values()] };
  validateTemplatePlan(plan);
  const module = path.join(generatedRoot, `${id}.tsx`), declaration = path.join(generatedRoot, `${id}.d.ts`);
  await write(module, `// Generated from ${sourceUri}; every node is owned by React.\nimport type {ComponentProps,ComponentType} from "react";\nimport {createTemplateComponent,${nodes[0].nativeType}} from "@godot-js/react";\nexport type TemplateProps = Omit<ComponentProps<typeof ${nodes[0].nativeType}>, "children">;\nconst Template = createTemplateComponent(${canonicalJson(plan)}) as ComponentType<TemplateProps>;\nexport default Template;\n`);
  await write(declaration, `import type {ComponentProps,ReactElement} from "react";\nimport {${nodes[0].nativeType}} from "@godot-js/react";\nexport type TemplateProps = Omit<ComponentProps<typeof ${nodes[0].nativeType}>, "children">;\nexport default function Template(props:TemplateProps):ReactElement;\n`);
  return { id, plan, module, declaration, resourceFiles: [...new Set([...graph.files, ...dependencyFiles])] };
}

/** Native equivalence verification runs in a fresh minimal project, never the user project. */
export async function verifyTemplatesNative(config: ProjectConfig, snapshot: Snapshot, templates: ImportedTemplate[], godot: string,run:CommandRunner=command): Promise<void> {
  if (!templates.length) return;
  const root = path.join(snapshot.root, "..", "extractor"); await write(path.join(root, "project.godot"), 'config_version=5\n[application]\nconfig/name="Godot React isolated extractor"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  for (const template of templates) {
    const files = [fromRes(snapshot.root, template.plan.source), ...template.resourceFiles];
    for (const file of files) { const rel = path.relative(snapshot.root, file); await write(path.join(root, rel), await fs.readFile(file)); }
  }
  const sources = templates.map(t => t.plan.source);
  await write(path.join(root, "extract.gd"), extractorSource(sources));
  const result = await run(godot, ["--headless", "--path", root, "--script", "res://extract.gd"], { cwd: root });
  if (result.code !== 0 || /SCRIPT ERROR|Parse Error|\[jsb\]\[Error\]/i.test(result.stdout + result.stderr)) fail("E_TEMPLATE_EXTRACT", "Isolated native extractor failed", result);
  const actual = JSON.parse(await fs.readFile(path.join(root, "extracted.json"), "utf8")) as Array<{ source: string; nodes: Record<string,{name:string;type:string;properties:Record<string,unknown>;owner:string;order:number}> }>;
  for (let i = 0; i < templates.length; i++) {
    const template = templates[i], paths = new Map<string,string>(), expected: Record<string,{name:string;type:string}> = {};
    for (const node of template.plan.nodes) {
      const parentPath = node.parentId ? paths.get(node.parentId)! : undefined;
      const nodePath = parentPath === undefined ? "." : parentPath === "." ? node.name : `${parentPath}/${node.name}`;
      paths.set(node.nodeId,nodePath); expected[nodePath] = {name:node.name,type:node.nativeType};
      const found = actual[i]?.nodes[nodePath];
      if (!found) fail("E_TEMPLATE_EQUIVALENCE", `Native node missing: ${template.id}/${nodePath}`);
      const expectedOwner = node.ownerId ? paths.get(node.ownerId) : "";
      if (found.owner !== expectedOwner || found.order !== node.siblingOrder) fail("E_TEMPLATE_EQUIVALENCE", `Native owner/order differs: ${template.id}/${nodePath}`, {expected:{owner:expectedOwner,order:node.siblingOrder},actual:{owner:found.owner,order:found.order}});
      const schema = getHostSchema(node.nativeType,config.profileId);
      for (const [key,value] of Object.entries(node.initial)) {
        const nativeName = schema.properties[key].nativeName;
        const input = value as {kind?:string;id?:string;type?:string};
        const expectedValue = input && input.kind === "asset" ? {resource:template.plan.resources.find(r=>r.resourceId===input.id)!.uri,type:input.type} : value;
        if (canonicalJson(found.properties[nativeName]) !== canonicalJson(expectedValue)) fail("E_TEMPLATE_EQUIVALENCE", `Native property differs: ${template.id}/${nodePath}.${nativeName}`, {expected:expectedValue,actual:found.properties[nativeName]});
      }
    }
    const topology = Object.fromEntries(Object.entries(actual[i]?.nodes ?? {}).map(([p,n])=>[p,{name:n.name,type:n.type}]));
    if (canonicalJson(topology) !== canonicalJson(expected)) fail("E_TEMPLATE_EQUIVALENCE", `Native/template topology differs: ${template.id}`, {expected,actual:topology});
  }
}
