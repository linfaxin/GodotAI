import { fail } from "../types.js";
interface Token { kind: "word" | "string" | "number" | "punct" | "newline" | "end"; value: string; line: number; column: number; }
export interface Section { name: string; attributes: Record<string, unknown>; properties: Record<string, unknown>; line: number; }
/** Strict text grammar. No eval, user scripts, native load or permissive fallback. */
export function parseSceneText(text: string, options: {worldValues?:boolean} = {}): Section[] {
  const tokens: Token[] = []; let offset = 0, line = 1, column = 0;
  while (offset < text.length) {
    const c = text[offset];
    if (c === "\r" || c === " " || c === "\t") { offset++; column++; continue; }
    if (c === "\n") { tokens.push({ kind: "newline", value: c, line, column }); offset++; line++; column = 0; continue; }
    if (c === ";") { while (offset < text.length && text[offset] !== "\n") { offset++; column++; } continue; }
    if (c === '"') {
      const start = offset, startColumn = column; offset++; column++; let escaped = false;
      while (offset < text.length) {
        const next = text[offset++]; column++;
        if (next === "\n" || next === "\r") fail("E_IMPORT_SYNTAX", `Multiline string at ${line}:${startColumn}`);
        if (next === '"' && !escaped) break;
        if (next === "\\" && !escaped) escaped = true; else escaped = false;
      }
      if (text[offset - 1] !== '"') fail("E_IMPORT_SYNTAX", `Unterminated string at ${line}:${startColumn}`);
      const raw = text.slice(start, offset); let value: string;
      try { value = JSON.parse(raw) as string; } catch { fail("E_IMPORT_SYNTAX", `Unsupported string escape at ${line}:${startColumn}`); }
      tokens.push({ kind: "string", value, line, column: startColumn }); continue;
    }
    const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(offset));
    if (number) { tokens.push({ kind: "number", value: number[0], line, column }); offset += number[0].length; column += number[0].length; continue; }
    const word = /^[A-Za-z_][A-Za-z_0-9/]*\b/.exec(text.slice(offset));
    if (word) { tokens.push({ kind: "word", value: word[0], line, column }); offset += word[0].length; column += word[0].length; continue; }
    if (("[]=(),"+(options.worldValues?"{}:&":"")).includes(c)) { tokens.push({ kind: "punct", value: c, line, column }); offset++; column++; continue; }
    fail("E_IMPORT_SYNTAX", `Unsupported token ${JSON.stringify(c)} at ${line}:${column}`);
  }
  tokens.push({ kind: "end", value: "", line, column }); let index = 0;
  const peek = () => tokens[index]; const take = () => tokens[index++];
  const expect = (value: string) => { const t = take(); if (t.value !== value) fail("E_IMPORT_SYNTAX", `Expected ${value} at ${t.line}:${t.column}`); };
  const word = () => { const t = take(); if (t.kind !== "word") fail("E_IMPORT_SYNTAX", `Expected identifier at ${t.line}:${t.column}`); return t; };
  let valueCount=0;
  function value(depth=0): unknown {
    if(options.worldValues&&(++valueCount>65536||depth>32))fail("E_IMPORT_VALUE","Value nesting/count budget exceeded");
    const t = take();
    if (t.kind === "string") return t.value;
    if(options.worldValues&&t.value==='&'){const name=take();if(name.kind!=="string")fail("E_IMPORT_VALUE","StringName requires a string literal");return name.value;}
    if (t.kind === "number") { const n = Number(t.value); if (!Number.isFinite(n)) fail("E_IMPORT_VALUE", "Nonfinite value"); return n; }
    if(options.worldValues&&t.value==='{'){const result:Record<string,unknown>=Object.create(null);const skip=()=>{while(peek().kind==='newline')take();};skip();let count=0;while(peek().value!=='}'){if(++count>128)fail('E_IMPORT_VALUE','Dictionary budget exceeded');const key=take();if(key.kind!=='string'||['__proto__','constructor','prototype'].includes(key.value)||Object.hasOwn(result,key.value))fail('E_IMPORT_VALUE','Invalid or duplicate dictionary key');expect(':');skip();result[key.value]=value(depth+1);skip();if(peek().value!==',')break;take();skip();}expect('}');return result;}
    if(options.worldValues&&t.value==='['){const items:unknown[]=[];const skip=()=>{while(peek().kind==='newline')take();};skip();while(peek().value!==']'){if(items.length>=16384)fail('E_IMPORT_VALUE','Array budget exceeded');items.push(value(depth+1));skip();if(peek().value!==',')break;take();skip();}expect(']');return items;}
    if (t.kind !== "word") fail("E_IMPORT_VALUE", `Expected value at ${t.line}:${t.column}`);
    if (t.value === "true" || t.value === "false") return t.value === "true";
    if (t.value === "null") return null;
    if (!["Vector2", "Color", "ExtResource", ...(options.worldValues?["Vector3","Vector2i","Vector3i","Rect2","AABB","PackedVector2Array","PackedVector3Array","Plane","SubResource","PackedFloat32Array","PackedColorArray","PackedByteArray"]:[])].includes(t.value)) fail("E_IMPORT_VALUE", `Unsupported constructor ${t.value}`);
    expect("("); const values: unknown[] = [];
    if (peek().value !== ")") { values.push(value(depth+1)); while (peek().value === ",") { take(); values.push(value(depth+1)); } }
    expect(")");
    if (t.value === "ExtResource" || t.value === "SubResource") { if (values.length !== 1 || typeof values[0] !== "string") fail("E_IMPORT_VALUE", "ExtResource needs one string id"); return { kind: t.value === "ExtResource" ? "external-resource" : "sub-resource", id: values[0] }; }
    if (values.some(v => typeof v !== "number")) fail("E_IMPORT_VALUE", `Invalid ${t.value}`);
    if(options.worldValues){
      if(t.value==='PackedByteArray'){if(values.length>16384||values.some(v=>!Number.isInteger(v)||Number(v)<0||Number(v)>255))fail('E_IMPORT_VALUE','Invalid packed byte array');return values;}
      if(t.value==='PackedFloat32Array'){if(values.length>16384)fail('E_IMPORT_VALUE','Packed array budget exceeded');return values;}
      if(t.value==='PackedColorArray'){if(values.length%4||values.length>16384)fail('E_IMPORT_VALUE','Invalid packed color array');return Array.from({length:values.length/4},(_,i)=>({r:values[i*4],g:values[i*4+1],b:values[i*4+2],a:values[i*4+3]}));}
      if(t.value==='AABB'&&values.length===6)return {position:{x:values[0],y:values[1],z:values[2]},size:{x:values[3],y:values[4],z:values[5]}};
      if(t.value==='Rect2'&&values.length===4)return {position:{x:values[0],y:values[1]},size:{x:values[2],y:values[3]}};
      if(t.value==='Plane'&&values.length===4)return {normal:{x:values[0],y:values[1],z:values[2]},distance:values[3]};
      if((t.value==='Vector2i'&&values.length===2)||(t.value==='Vector3i'&&values.length===3)){if(values.some(n=>!Number.isInteger(n)))fail('E_IMPORT_VALUE','Integer vector requires integer components');return {x:values[0],y:values[1],...(values.length===3?{z:values[2]}:{})};}
      if(t.value==='PackedVector2Array'||t.value==='PackedVector3Array'){const dimension=t.value==='PackedVector2Array'?2:3;if(values.length%dimension||values.length>12288)fail('E_IMPORT_VALUE','Invalid packed vector array');return Array.from({length:values.length/dimension},(_,i)=>({x:values[i*dimension],y:values[i*dimension+1],...(dimension===3?{z:values[i*dimension+2]}:{})}));}
    }
    if (t.value === "Vector2" && values.length === 2) return { x: values[0], y: values[1] };
    if (t.value === "Vector3" && values.length === 3) return { x: values[0], y: values[1], z: values[2] };
    if (t.value === "Color" && (values.length === 3 || values.length === 4)) return { r: values[0], g: values[1], b: values[2], a: values[3] ?? 1 };
    return fail("E_IMPORT_VALUE", `Invalid ${t.value} arity`);
  }
  const sections: Section[] = []; let current: Section | undefined;
  while (peek().kind !== "end") {
    if (peek().kind === "newline") { take(); continue; }
    if (peek().value === "[") {
      take(); const type = word(); const attributes: Record<string, unknown> = {};
      while (peek().value !== "]") {
        const key = word().value; if(["__proto__","constructor","prototype"].includes(key))fail("E_IMPORT_SYNTAX","Reserved property key"); expect("="); if (Object.hasOwn(attributes, key)) fail("E_IMPORT_SYNTAX", `Duplicate header ${key}`); attributes[key] = value();
      }
      take(); current = { name: type.value, attributes, properties: {}, line: type.line }; sections.push(current);
    } else {
      if (!current) fail("E_IMPORT_SYNTAX", "Property before header");
      const key = word().value; if(["__proto__","constructor","prototype"].includes(key))fail("E_IMPORT_SYNTAX","Reserved property key"); expect("="); if (Object.hasOwn(current.properties, key)) fail("E_IMPORT_SYNTAX", `Duplicate property ${key}`); current.properties[key] = value();
    }
    if (peek().kind !== "newline" && peek().kind !== "end") fail("E_IMPORT_SYNTAX", `Unexpected trailing token at ${peek().line}`);
  }
  return sections;
}

