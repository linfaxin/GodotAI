import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseRuntimeManifest, validateActiveDescriptor } from "@godot-js/react/contracts";
import { acquireRunLease, activeRunLeases, generatedRoot, processAlive } from "./publication.js";
import { atomicJson, exists, fromRes, readJson, sha256 } from "./fs.js";
import { BuildError, fail, type CommandResult, type ProjectConfig } from "./types.js";

export interface PreviewDescriptor {
  schemaVersion:1; sessionId:string; ownerPid:number; entryId:string; generation:string;
  godot:string; headless:boolean; lease:string;
}
export interface ManagedPreview {
  descriptor:PreviewDescriptor;
  result:Promise<CommandResult>;
  stop():Promise<void>;
}
const directory = (config:ProjectConfig) => path.join(generatedRoot(config), "preview-sessions");

async function childPids(config:ProjectConfig, descriptor:PreviewDescriptor):Promise<Set<number>> {
  const children = path.join(generatedRoot(config), "run-leases", `${descriptor.lease}.children`);
  const pids = new Set<number>();
  for (const name of await fs.readdir(children).catch(() => [] as string[])) {
    const item = await readJson<{state?:string;pid?:number}>(path.join(children,name)).catch(() => undefined);
    if (item?.state === "running" && Number.isSafeInteger(item.pid)) pids.add(item.pid!);
  }
  return pids;
}

export async function readManagedPreviews(config:ProjectConfig):Promise<PreviewDescriptor[]> {
  const result:PreviewDescriptor[] = [];
  for (const name of await fs.readdir(directory(config)).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    const item = await readJson<PreviewDescriptor>(path.join(directory(config),name));
    if (item.schemaVersion !== 1 || !/^[a-zA-Z0-9_-]{1,96}$/.test(item.sessionId)
      || name !== `${item.sessionId}.json` || !Number.isSafeInteger(item.ownerPid) || item.ownerPid <= 0
      || !Object.hasOwn(config.entries,item.entryId) || item.godot !== config.godot || typeof item.headless !== "boolean"
      || typeof item.generation !== "string" || !/^\d+-[0-9a-f]{64}\.json$/.test(item.lease)) {
      fail("E_PREVIEW_SESSION","Invalid managed preview descriptor",name);
    }
    if (processAlive(item.ownerPid)) result.push(item);
  }
  return result;
}

/** A watcher can restart only previews whose Node supervisor and child are known. */
export async function assertManagedWatchApplications(config:ProjectConfig, previews:readonly PreviewDescriptor[]):Promise<void> {
  const children = new Map<PreviewDescriptor,Set<number>>();
  for (const preview of previews) children.set(preview,await childPids(config,preview));
  for (const name of await activeRunLeases(config)) {
    const marker = await readJson<{pid?:number;rootId?:string}>(path.join(generatedRoot(config),"run-leases",name)).catch(() => undefined);
    const known = previews.some(p => marker?.rootId === p.entryId
      && (name === p.lease && marker.pid === p.ownerPid || children.get(p)!.has(marker?.pid ?? -1)));
    if (!known) fail("E_RUN_ACTIVE",`Watch cannot restart an external application or compiler reader: ${name}`);
  }
}

/** Holds a reader lease from before spawn until the entire child process has exited. */
export async function startManagedPreview(config:ProjectConfig, generation:string, entryId:string,
  options:{headless?:boolean;sessionId?:string;shutdownTimeoutMs?:number;onOutput?:(text:string,stream:"stdout"|"stderr")=>void} = {}):Promise<ManagedPreview> {
  if (!config.godot) fail("E_GODOT_REQUIRED","Preview requires a Godot executable");
  const active = validateActiveDescriptor(await readJson(path.join(generatedRoot(config),"active.json")));
  const bytes = await fs.readFile(fromRes(config.projectRoot,active.manifestPath));
  if (active.generation !== generation || sha256(bytes) !== active.manifestSha256) fail("E_GENERATION_MISMATCH","Preview generation is no longer active");
  const manifest = parseRuntimeManifest(bytes.toString("utf8"),{expectedGeneration:generation,manifestUri:active.manifestPath});
  const entry = manifest.entries[entryId]; if (!entry) fail("E_ENTRY",`Unknown entry ${entryId}`);
  const sessionId = options.sessionId ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(sessionId)) fail("E_PREVIEW_SESSION","Invalid preview session identity");
  const lease = await acquireRunLease(config,generation,entryId);
  const file = path.join(directory(config),`${sessionId}.json`);
  const descriptor:PreviewDescriptor = {schemaVersion:1,sessionId,ownerPid:process.pid,entryId,generation,
    godot:config.godot,headless:options.headless ?? false,lease:path.basename(lease.file)};
  try { await atomicJson(file,descriptor); } catch (error) { await lease.release(); throw error; }
  const abort = new AbortController(); let finished = false, stopping = false, polling:Promise<void>|undefined;
  const relayShutdown = async () => {
    if (finished || !await exists(`${lease.file}.shutdown`)) return;
    const pids = await childPids(config,descriptor);
    for (const name of await activeRunLeases(config)) {
      if (name === descriptor.lease) continue;
      const marker = await readJson<{pid?:number;rootId?:string}>(path.join(generatedRoot(config),"run-leases",name)).catch(() => undefined);
      if (marker?.rootId === entryId && pids.has(marker.pid ?? -1))
        await atomicJson(path.join(generatedRoot(config),"run-leases",`${name}.shutdown`),{schemaVersion:1,reason:"preview-supervisor"});
    }
  };
  let relayError:unknown;
  const timer = setInterval(() => {
    if (!polling) polling = relayShutdown().catch(error => { relayError=error;abort.abort(); }).finally(() => { polling=undefined; });
  },50);
  const result = (async () => {
    try {
      const outcome = await lease.command(config.godot!,[...(descriptor.headless ? ["--headless"] : []),"--path",config.projectRoot,entry.scene],
        {cwd:config.projectRoot,timeoutMs:0,signal:abort.signal,onOutput:options.onOutput});
      if (relayError) throw relayError;
      return outcome;
    } catch (error) {
      if (stopping && error instanceof BuildError && error.code === "E_CANCELLED") {
        const output = error.details as {stdout?:string;stderr?:string}|undefined;
        return {code:0,stdout:output?.stdout ?? "",stderr:output?.stderr ?? ""};
      }
      throw error;
    } finally {
      finished=true;clearInterval(timer);await polling;
      try { await fs.rm(file,{force:true}); } finally { await lease.release(); }
    }
  })();
  // The owning caller still receives failures, without an unhandled rejection while starting other sessions.
  void result.catch(() => {});
  return {descriptor,result,stop:async () => {
    if (finished) { await result; return; }
    stopping=true;
    const deadline=setTimeout(() => abort.abort(),options.shutdownTimeoutMs ?? 5_000);
    try { await atomicJson(`${lease.file}.shutdown`,{schemaVersion:1,reason:"preview-stop"});await result; }
    finally { clearTimeout(deadline); }
  }};
}
