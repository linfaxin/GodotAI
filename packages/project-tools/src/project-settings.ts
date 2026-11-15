/** Text project settings follow ConfigFile: later assignments/sections win. */
const heading = /^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/;

export function decodeProjectText(value: string | readonly number[] | Uint8Array | undefined): string | undefined {
 if (value === undefined || typeof value === 'string') return value;
 if (!(value instanceof Uint8Array) && !value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw Error('project.godot must contain UTF-8 bytes');
 try { return new TextDecoder('utf-8', {fatal:true}).decode(Uint8Array.from(value)); }
 catch { throw Error('project.godot must contain valid UTF-8 text'); }
}

function finalSettings(text: string, section: string): Map<string,string> {
 let current = '';const values=new Map<string,string>();
 for (const line of text.split(/\r?\n/)) {
  const match = heading.exec(line);
  if (match) { current = match[1]; continue; }
  const equals = line.indexOf('=');
  if (current === section && equals >= 0) values.set(line.slice(0,equals).trim(),line.slice(equals+1));
 }
 return values;
}
function finalSetting(text:string,section:string,key:string):string|undefined{return finalSettings(text,section).get(key);}
function quotedString(raw:string|undefined):string|undefined{
 const quoted=/^\s*("(?:[^"\\]|\\.)*")\s*(?:[;#].*)?$/.exec(raw??'');
 if(quoted){try{return JSON.parse(quoted[1]);}catch{/* Invalid final values do not revive earlier assignments. */}}
 return undefined;
}

export function readProjectBooleanSetting(text: string, section: string, key: string): boolean | undefined {
 const match = /^\s*(true|false)\s*(?:[;#].*)?$/.exec(finalSetting(text, section, key) ?? '');
 return match ? match[1] === 'true' : undefined;
}

export function readProjectStringSetting(text: string, section: string, key: string): string | undefined {
 return quotedString(finalSetting(text,section,key));
}
/** Read string-valued entries only from the named ConfigFile section. */
export function readProjectStringSettings(text:string,section:string):Readonly<Record<string,string>>{
 return Object.freeze(Object.fromEntries([...finalSettings(text,section)].flatMap(([key,raw])=>{const value=quotedString(raw);return value===undefined?[]:[[key,value]];})));
}

/** Update every occurrence, including repeated sections, preserving other settings. */
export function writeProjectStringSetting(text: string, section: string, key: string, value: string): string {
 const newline = text.includes('\r\n') ? '\r\n' : '\n';
 const lines = text.split(/\r?\n/), entry = key + '=' + JSON.stringify(value);
 let current = '', insertion = -1, found = false;
 for (let index = 0; index < lines.length; index++) {
  const match = heading.exec(lines[index]);
  if (match) { current = match[1]; if (current === section) insertion = index + 1; continue; }
  if (current !== section) continue;
  insertion = index + 1;
  const equals = lines[index].indexOf('=');
  if (equals >= 0 && lines[index].slice(0, equals).trim() === key) { lines[index] = entry; found = true; }
 }
 if (found) return lines.join(newline);
 if (insertion < 0) return text.replace(/\s*$/, '') + newline + newline + '[' + section + ']' + newline + entry + newline;
 lines.splice(insertion, 0, entry);
 return lines.join(newline);
}
