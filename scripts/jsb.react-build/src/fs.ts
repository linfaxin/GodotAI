import { createHash, randomUUID } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertCanonicalResPath, canonicalJson } from "@godot-js/react/contracts";
import { BuildError,fail, type CommandResult } from "./types.js";

export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const generationId = (): string => `${Date.now().toString(36)}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
export const slash = (value: string): string => value.replaceAll(path.sep, "/");
export async function resolveExecutable(name:string,cwd:string):Promise<string>{
 const candidates=path.isAbsolute(name)?[name]:name.includes("/")||name.includes("\\")?[path.resolve(cwd,name)]:(process.env.PATH??"").split(path.delimiter).flatMap(directory=>[path.join(directory,name),...(process.platform==="win32"?[path.join(directory,`${name}.exe`)]:[])]);
 for(const candidate of candidates)try{await fs.access(candidate,fsConstants.X_OK);return await fs.realpath(candidate);}catch{}
 return fail("E_GODOT_NOT_FOUND",`Cannot resolve executable ${name}`);
}
export function fromRes(root: string, uri: string): string { assertCanonicalResPath(uri); return within(root, uri.slice(6)); }
export function toRes(root: string, filename: string): string {
  const relative = slash(path.relative(root, filename));
  const uri = `res://${relative}`; assertCanonicalResPath(uri); return uri;
}
export function within(root: string, relative: string): string {
  if (relative.includes("\0") || path.isAbsolute(relative)) fail("E_PATH", `Expected project-relative path: ${relative}`);
  const result = path.resolve(root, relative), rel = path.relative(path.resolve(root), result);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail("E_PATH", `Path escapes project: ${relative}`);
  return result;
}
export async function exists(filename: string): Promise<boolean> { try { await fs.access(filename); return true; } catch { return false; } }
export async function readJson<T = unknown>(filename: string): Promise<T> {
  try { return JSON.parse(await fs.readFile(filename, "utf8")) as T; }
  catch (error) { fail("E_JSON", `Cannot read ${filename}`, String(error)); }
}
export async function write(filename: string, contents: string | Uint8Array): Promise<void> { await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, contents); }
export async function atomicJson(filename: string, value: unknown): Promise<void> {
  const temp = `${filename}.${randomUUID()}.tmp`; await write(temp, `${canonicalJson(value)}\n`);
  try { const handle = await fs.open(temp, "r+"); await handle.sync(); await handle.close(); await fs.rename(temp, filename); }
  finally { await fs.rm(temp, { force: true }); }
}
export async function listFiles(root: string, excluded: (relative: string) => boolean = () => false): Promise<string[]> {
  const result: string[] = [], folded = new Map<string, string>();
  async function visit(dir: string): Promise<void> {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name), relative = slash(path.relative(root, file));
      if (excluded(relative)) continue;
      if (entry.isSymbolicLink()) fail("E_SYMLINK", `Project source symlinks are not snapshot inputs: ${relative}`);
      const old = folded.get(relative.toLowerCase()); if (old && old !== relative) fail("E_CASE_COLLISION", `${old} and ${relative}`);
      folded.set(relative.toLowerCase(), relative);
      if (entry.isDirectory()) await visit(file); else if (entry.isFile()) result.push(file);
    }
  }
  await visit(root); return result;
}
export interface Snapshot { root: string; hashes: Record<string, string>; hash: string; generatedDir?:string; }
export const projectInputExcluded=(rel:string,generatedDir="generated/react")=>[".git","node_modules",".godot",generatedDir,"dist","output"].some(p=>rel===p||rel.startsWith(`${p}/`))||/\.pck(?:\.\d+\.tmp)?$/.test(rel);
export async function snapshotProject(projectRoot: string, snapshotRoot: string, generatedDir: string): Promise<Snapshot> {
  const exclude = (rel: string) => projectInputExcluded(rel,generatedDir);
  const files = await listFiles(projectRoot, exclude), hashes: Record<string, string> = {};
  for (const file of files) {
    const rel = slash(path.relative(projectRoot, file)), bytes = await fs.readFile(file);
    hashes[rel] = sha256(bytes); await write(path.join(snapshotRoot, rel), bytes);
  }
  return { root: snapshotRoot, hashes, hash: sha256(canonicalJson(hashes)),generatedDir };
}
export async function verifySnapshot(projectRoot: string, snapshot: Snapshot): Promise<void> {
  for (const [rel, hash] of Object.entries(snapshot.hashes)) {
    try { if (sha256(await fs.readFile(within(projectRoot, rel))) !== hash) fail("E_SOURCE_CHANGED", `Input changed while building: ${rel}`); }
    catch (error) { if (error instanceof Error && error.message.startsWith("E_SOURCE_CHANGED")) throw error; fail("E_SOURCE_CHANGED", `Input removed while building: ${rel}`); }
  }
  const generated=snapshot.generatedDir??"generated/react";
  const files=await listFiles(projectRoot,rel=>projectInputExcluded(rel,generated));
  for(const file of files){const relative=slash(path.relative(projectRoot,file));if(!(relative in snapshot.hashes)&&!relative.endsWith(".uid")&&!relative.endsWith(".import"))fail("E_SOURCE_CHANGED",`Input added while building: ${relative}`);}
}
export async function copyTree(source: string, target: string): Promise<void> {
  for (const file of await listFiles(source)) { const relative = path.relative(source, file); await fs.mkdir(path.dirname(path.join(target, relative)), { recursive: true }); await fs.copyFile(file, path.join(target, relative), fsConstants.COPYFILE_FICLONE); }
}
export interface CommandOptions { cwd:string;timeoutMs?:number;env?:NodeJS.ProcessEnv;maxOutputBytes?:number;killGraceMs?:number;signal?:AbortSignal;onOutput?:(text:string,stream:"stdout"|"stderr")=>void;lifecycle?:{beforeSpawn():void;spawned(pid:number):void;exited():void} }
export type CommandRunner=typeof command;
export async function command(executable: string, args: string[], options: CommandOptions ): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if(options.signal?.aborted){reject(new BuildError("E_CANCELLED",executable));return;}
    options.lifecycle?.beforeSpawn();
    const child = spawn(executable, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", failure: Error | undefined, bytes = 0, forceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error:Error) => { if(failure)return;failure=error;child.kill("SIGTERM");forceTimer=setTimeout(()=>child.kill("SIGKILL"),options.killGraceMs??1000); };
    const receive = (chunk:Buffer,isError:boolean) => { if(failure)return;bytes+=chunk.length;if(bytes>(options.maxOutputBytes??32*1024*1024)){stop(new BuildError("E_OUTPUT_LIMIT",executable));return;}if(isError)stderr+=chunk;else stdout+=chunk;try{options.onOutput?.(chunk.toString(),isError?"stderr":"stdout");}catch(error){stop(error instanceof Error?error:new Error(String(error)));} };
    child.stdout.on("data", chunk => receive(chunk,false)); child.stderr.on("data", chunk => receive(chunk,true));
    const timer = options.timeoutMs === 0 ? undefined : setTimeout(() => stop(new BuildError("E_TIMEOUT",executable)), options.timeoutMs ?? 120000);
    const abort = () => stop(new BuildError("E_CANCELLED",executable));
    options.signal?.addEventListener("abort",abort,{once:true});
    if(options.signal?.aborted)abort();
    const clear = () => {clearTimeout(timer);clearTimeout(forceTimer);options.signal?.removeEventListener("abort",abort);};
    const exited=()=>{try{options.lifecycle?.exited();}catch(error){failure??=error instanceof Error?error:new Error(String(error));}};
    child.once("error", error => { clear(); exited();reject(error); });
    child.once("close", code => { clear(); exited();if (failure) reject(failure instanceof BuildError?new BuildError(failure.code,executable,{stdout,stderr}):failure); else resolve({ code: code ?? 1, stdout, stderr }); });
    if(child.pid)try{options.lifecycle?.spawned(child.pid);}catch(error){stop(error instanceof Error?error:new Error(String(error)));}
  });
}
