import path from "node:path";
import { slash } from "./fs.js";
import type { ImportedTemplate } from "./template.js";

interface SourceMapData { version: number; file?: string; sourceRoot?: string; sources: string[]; sourcesContent?: (string | null)[]; names: string[]; mappings: string; }
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decode(text: string): number[] {
  const result: number[] = []; let value = 0, shift = 0;
  for (const char of text) {
    const digit = alphabet.indexOf(char); if (digit < 0 || shift > 30) throw new Error("E_SOURCE_MAP: Invalid VLQ");
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) shift += 5; else { result.push(value & 1 ? -Math.floor(value / 2) : Math.floor(value / 2)); value = shift = 0; }
  }
  if (shift) throw new Error("E_SOURCE_MAP: Truncated VLQ"); return result;
}
function encode(values: number[]): string {
  let out = "";
  for (const value of values) { let v = Math.abs(value) * 2 + (value < 0 ? 1 : 0); do { let digit = v % 32; v = Math.floor(v / 32); if (v) digit |= 32; out += alphabet[digit]; } while (v); }
  return out;
}
/** esbuild composes TypeScript's and dependency maps; normalize frozen input paths. */
export function normalizeSourceMap(raw: string, output: string, snapshotRoot: string, runtimeRoot: string, templates: ImportedTemplate[]): string {
  const map = JSON.parse(raw) as SourceMapData;
  const templateByFile = new Map(templates.map(t => [path.resolve(t.module), t]));
  const templateIndices = new Map<number, ImportedTemplate>();
  map.sources = map.sources.map((source, i) => {
    const abs = path.resolve(path.dirname(output), map.sourceRoot ?? "", source), template = templateByFile.get(abs);
    if (template) { templateIndices.set(i, template); return template.plan.source; }
    const rel = path.relative(snapshotRoot, abs);
    if (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return `res://${slash(rel)}`;
    const runtimeRel = path.relative(runtimeRoot, abs);
    if (!runtimeRel.startsWith(`..${path.sep}`)) return `res://node_modules/@godot-js/react/${slash(runtimeRel)}`;
    const marker = `${path.sep}node_modules${path.sep}`, index = abs.lastIndexOf(marker);
    return index >= 0 ? `res://${slash(abs.slice(index + 1))}` : `res://generated/react/vendor-sources/${path.basename(abs)}`;
  });
  if (templateIndices.size) {
    let source = 0, originalLine = 0, originalColumn = 0, name = 0;
    const absolute = map.mappings.split(";").map(line => { let generated = 0; return line.split(",").filter(Boolean).map(segment => {
      const fields = decode(segment); generated += fields[0];
      if (fields.length === 1) return [generated];
      source += fields[1]; originalLine += fields[2]; originalColumn += fields[3]; if (fields.length === 5) name += fields[4];
      const template = templateIndices.get(source); const fieldsOut = [generated, source, template ? template.plan.nodes[0].source.line : originalLine, template ? 0 : originalColumn];
      if (fields.length === 5) fieldsOut.push(name); return fieldsOut;
    }); });
    let previousSource = 0, previousLine = 0, previousColumn = 0, previousName = 0;
    map.mappings = absolute.map(line => { let previousGenerated = 0; return line.map(fields => {
      const outputFields = [fields[0] - previousGenerated]; previousGenerated = fields[0];
      if (fields.length > 1) { outputFields.push(fields[1] - previousSource, fields[2] - previousLine, fields[3] - previousColumn); [previousSource, previousLine, previousColumn] = fields.slice(1, 4); }
      if (fields.length === 5) { outputFields.push(fields[4] - previousName); previousName = fields[4]; }
      return encode(outputFields);
    }).join(","); }).join(";");
    if (map.sourcesContent) for (const [index] of templateIndices) map.sourcesContent[index] = null;
  }
  map.sourceRoot = ""; map.file = path.basename(output); return `${JSON.stringify(map)}\n`;
}
