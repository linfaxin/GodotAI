import path from "node:path";
import { promises as fs } from "node:fs";
import {mkdirSync,writeFileSync,renameSync,rmSync} from "node:fs";
import { randomUUID } from "node:crypto";
import { canonicalJson, parseRuntimeManifest, validateActiveDescriptor, type ActiveDescriptorV1, type BuildState, type RuntimeManifestV1 } from "@godot-js/react/contracts";
import { atomicJson, command,exists, fromRes, readJson, sha256, toRes, within, verifySnapshot,type CommandRunner } from "./fs.js";
import { fail, type ProjectConfig } from "./types.js";

export interface Journal { schemaVersion: 1; state: BuildState; generation: string; pid: number; operationId: string; ownedArtifacts: string[]; previousActive?: ActiveDescriptorV1; error?: string; }
export const generatedRoot = (config: ProjectConfig) => within(config.projectRoot, config.generatedDir);
function trackedCommand(directory:string):CommandRunner{return async(executable,args,options)=>{
  const file=path.join(directory,`${randomUUID()}.json`);
  const saveChild=(value:unknown)=>{mkdirSync(directory,{recursive:true});const temporary=`${file}.tmp`;writeFileSync(temporary,JSON.stringify(value));renameSync(temporary,file);};
  return command(executable,args,{...options,lifecycle:{beforeSpawn(){saveChild({schemaVersion:1,state:"pending",executable,ownerPid:process.pid});},spawned(pid){saveChild({schemaVersion:1,state:"running",executable,pid,ownerPid:process.pid});},exited(){rmSync(file,{force:true});}}});
};}
async function assertChildrenClosed(directory:string):Promise<void>{
  if(!await exists(directory))return;
  for(const name of await fs.readdir(directory)){
    const child=await readJson<{state?:string;pid?:number}>(path.join(directory,name)).catch(()=>undefined);
    if(!child||child.state!=="running"||!Number.isSafeInteger(child.pid)||!child.pid||child.pid<1)fail("E_CHILD_UNCERTAIN",`An interrupted spawn cannot be proven closed: ${name}; inspect the importer before recovery`);
    if(processAlive(child.pid))fail("E_CHILD_ACTIVE",`Orphaned build child ${child.pid} is still alive; wait for it to exit before recovery`);
  }
}
export function processAlive(pid: number): boolean { if (!Number.isSafeInteger(pid) || pid <= 0) return true; try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
export async function activeRunLeases(config: ProjectConfig): Promise<string[]> {
  const dir = path.join(generatedRoot(config), "run-leases"); if (!await exists(dir)) return [];
  const busy: string[] = [];
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let marker: unknown; try { marker = JSON.parse(await fs.readFile(file, "utf8")); } catch { busy.push(name); continue; }
    if (!marker || typeof marker !== "object" || (marker as {schemaVersion?:number}).schemaVersion !== 1 || !Number.isSafeInteger((marker as { pid?: number }).pid) || typeof (marker as {rootId?:unknown}).rootId !== "string" || typeof (marker as {rootInstance?:unknown}).rootInstance !== "string" || !Number.isFinite((marker as {createdAtMs?:number}).createdAtMs)) { busy.push(name); continue; }
    if (processAlive((marker as { pid: number }).pid)) busy.push(name); else {
      try{await assertChildrenClosed(`${file}.children`);}catch{busy.push(name);continue;}
      await fs.rm(file, { force: true }); await fs.rm(`${file}.shutdown`, { force: true });await fs.rm(`${file}.children`,{recursive:true,force:true});
    }
  }
  return busy;
}
/** Portable reader lease, with active-generation revalidation closing the lock ABA window. */
export async function acquireRunLease(config: ProjectConfig, generation: string, rootId = "@godot-react/export") {
  const root = generatedRoot(config), lock = path.join(root, ".publish-lock"), rootInstance = `${rootId}:${randomUUID()}`;
  if (await exists(lock)) fail("E_BUILD_BUSY", "Cannot lease while publication is in progress");
  const file = path.join(root, "run-leases", `${process.pid}-${sha256(rootInstance)}.json`);
  await atomicJson(file, {schemaVersion:1,pid:process.pid,rootId,rootInstance,createdAtMs:Date.now()});
  const release = async () => { await assertChildrenClosed(`${file}.children`);await fs.rm(file, {force:true}); await fs.rm(`${file}.shutdown`, {force:true});await fs.rm(`${file}.children`,{recursive:true,force:true}); };
  try {
    const active = validateActiveDescriptor(await readJson(path.join(root, "active.json")));
    if (active.generation !== generation || await exists(lock)) fail("E_GENERATION_MISMATCH", "Generation changed while acquiring the reader lease");
    return { file, release,command:trackedCommand(`${file}.children`) };
  } catch (error) { await release(); throw error; }
}
export async function stopManagedApplications(config: ProjectConfig, timeoutMs=10_000): Promise<void> {
  const root = path.join(generatedRoot(config),"run-leases"), deadline=Date.now()+timeoutMs;
  let names=await activeRunLeases(config); if(!names.length)return;
  for(const name of names){
    const marker=await readJson<{rootId?:string}>(path.join(root,name)).catch(()=>undefined);
    if(!marker?.rootId||marker.rootId.startsWith("@godot-react/"))fail("E_RUN_ACTIVE",`Publication is blocked by an invalid or compiler reader lease: ${name}`);
    await atomicJson(path.join(root,`${name}.shutdown`),{schemaVersion:1,reason:"publisher",requestedAtMs:Date.now()});
  }
  while(names.length){if(Date.now()>=deadline)fail("E_RUN_ACTIVE",`Managed applications did not release their leases: ${names.join(", ")}`);await new Promise(resolve=>setTimeout(resolve,50));names=await activeRunLeases(config);}
}
export async function acquirePublisher(config: ProjectConfig, generation: string,waitMs=0,recovering=false): Promise<{ journal: Journal; command:CommandRunner;state(state: BuildState, paths?: string[]): Promise<void>; release(): Promise<void> }> {
  if(!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>60_000)fail("E_ARGUMENT","waitPublisherMs must be an integer between 0 and 60000");
  const root = generatedRoot(config), lock = path.join(root, ".publish-lock"), operationId = randomUUID(); await fs.mkdir(root, { recursive: true });
  const recovery=path.join(root,".recovery-lock");
  if(!recovering&&await exists(recovery))fail("E_BUILD_BUSY","Recovery owns .recovery-lock");
  const deadline=Date.now()+waitMs;
  for(;;){try{await fs.mkdir(lock);break;}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;const owner=await readJson<{pid?:number}>(path.join(lock,"owner.json")).catch(()=>undefined);if(!owner?.pid||!processAlive(owner.pid)||Date.now()>=deadline)fail("E_BUILD_BUSY","Publisher owns .publish-lock; dead or unowned publishers require recovery");await new Promise(resolve=>setTimeout(resolve,50));}}
  let released = false;
  const release = async () => { if (!released) { await assertChildrenClosed(path.join(lock,"children"));released = true; await fs.rm(lock, { recursive: true, force: true }); } };
  try {
    if(!recovering&&await exists(recovery))fail("E_BUILD_BUSY","Recovery acquired its fence before publication");
    await atomicJson(path.join(lock, "owner.json"), { schemaVersion: 1, operationId, pid: process.pid, createdAtMs: Date.now() });
    const leases = await activeRunLeases(config); if (leases.length) fail("E_RUN_ACTIVE", `Close managed applications before publishing: ${leases.join(", ")}`);
    let previousActive: ActiveDescriptorV1 | undefined;
    try { previousActive = validateActiveDescriptor(await readJson(path.join(root, "active.json"))); } catch { /* A first build has no active generation. */ }
    const journal: Journal = { schemaVersion: 1, state: "LOCKED", generation, pid: process.pid, operationId, ownedArtifacts: [], ...(previousActive ? { previousActive } : {}) };
    const save = () => atomicJson(path.join(root, "journal.json"), journal);
    await save();
    const childCommand=trackedCommand(path.join(lock,"children"));
    return { journal, command:childCommand,state: async (state, paths) => { journal.state = state; if (paths) journal.ownedArtifacts = [...new Set([...journal.ownedArtifacts, ...paths])]; await save(); }, release };
  } catch (error) { await release(); throw error; }
}

export async function sealManifest(config: ProjectConfig, manifest: RuntimeManifestV1): Promise<{ active: ActiveDescriptorV1; manifestFile: string }> {
  const file = path.join(generatedRoot(config), "manifests", `${manifest.generation}.json`), uri = toRes(config.projectRoot, file);
  const bytes = `${canonicalJson(manifest)}\n`; parseRuntimeManifest(bytes, { manifestUri: uri });
  await fs.mkdir(path.dirname(file),{recursive:true});const handle=await fs.open(file,"wx");try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  return { manifestFile: file, active: { schemaVersion: 1, generation: manifest.generation, manifestPath: uri, manifestSha256: sha256(bytes), state: "READY" } };
}

export async function verifyArtifacts(config: ProjectConfig, manifest: RuntimeManifestV1): Promise<string[]> {
  const errors: string[] = [];
  for (const [uri, artifact] of Object.entries(manifest.artifacts)) {
    try { const bytes = await fs.readFile(fromRes(config.projectRoot, uri)); if (sha256(bytes) !== artifact.sha256) errors.push(`E_ARTIFACT_HASH: ${uri}`); }
    catch { errors.push(`E_ARTIFACT_MISSING: ${uri}`); }
  }
  for (const [id, resource] of Object.entries(manifest.resources)) {
    try { if (sha256(await fs.readFile(fromRes(config.projectRoot, resource.uri))) !== resource.sha256) errors.push(`E_RESOURCE_HASH: ${id}`); }
    catch { errors.push(`E_RESOURCE_MISSING: ${id}`); }
  }
  return errors;
}
export async function verifySourceRecord(config:ProjectConfig,manifest:RuntimeManifestV1):Promise<string[]>{
  const uri=Object.entries(manifest.artifacts).find(([,artifact])=>artifact.kind==="source-snapshot")?.[0];
  if(!uri)return ["E_SOURCE_SNAPSHOT: generation has no frozen source record"];
  try{
    const record=await readJson<{schemaVersion:number;hash:string;files:Record<string,string>}>(fromRes(config.projectRoot,uri));
    if(record.schemaVersion!==1||record.hash!==manifest.sourceSnapshotHash||sha256(canonicalJson(record.files))!==manifest.sourceSnapshotHash)return ["E_SOURCE_SNAPSHOT: manifest/source record differ"];
    await verifySnapshot(config.projectRoot,{root:config.projectRoot,hash:record.hash,hashes:record.files,generatedDir:config.generatedDir});return [];
  }catch(error){return [String(error)];}
}

export async function recoverProject(config: ProjectConfig, forceUnowned = false): Promise<void> {
  const root = generatedRoot(config), lock = path.join(root, ".publish-lock");
  const recovery=path.join(root,".recovery-lock");await fs.mkdir(root,{recursive:true});
  try{await fs.mkdir(recovery);}catch{fail("E_RECOVERY_BUSY","Another or interrupted recovery owns .recovery-lock; inspect its owner before removing that guard");}
  try{
  await atomicJson(path.join(recovery,"owner.json"),{schemaVersion:1,pid:process.pid,operationId:randomUUID()});
  if (await exists(lock)) {
    let owner: { pid?: number;operationId?:string } | undefined;
    try { owner = await readJson(path.join(lock, "owner.json")); } catch { if (!forceUnowned) fail("E_BUILD_BUSY", "Unowned publish lock requires explicit --force-unowned-lock recovery"); }
    if((!Number.isSafeInteger(owner?.pid)||!owner?.pid||owner.pid<1||typeof owner.operationId!=="string")&&!forceUnowned)fail("E_BUILD_BUSY","Malformed publish lock requires explicit --force-unowned-lock recovery");
    if (owner?.pid && processAlive(owner.pid)) fail("E_BUILD_BUSY", `Publisher ${owner.pid} is still alive`);
    await assertChildrenClosed(path.join(lock,"children"));
    await fs.rm(lock, { recursive: true, force: true });
  }
  const publication=await acquirePublisher(config,"recovery",0,true);
  try {
  const active = await readJson<ActiveDescriptorV1>(path.join(root, "active.json")).catch(() => undefined);
  if (active) {
    validateActiveDescriptor(active); const bytes = await fs.readFile(fromRes(config.projectRoot, active.manifestPath));
    if (sha256(bytes) !== active.manifestSha256) fail("E_MANIFEST_HASH", "Active manifest is not sealed");
    const manifest = parseRuntimeManifest(bytes.toString("utf8"), { manifestUri: active.manifestPath, expectedGeneration: active.generation });
    const errors = [...await verifyArtifacts(config, manifest),...await verifySourceRecord(config,manifest)];
    if (errors.length) fail("E_RECOVERY_REBUILD_REQUIRED", "Resource/artifact snapshot changed; rebuild rather than silently launching an old generation", errors);
  }
  await atomicJson(path.join(root, "journal.json"), { schemaVersion: 1, state: active ? "READY" : "FAILED", generation: active?.generation ?? "none", pid: process.pid, operationId: randomUUID(), ownedArtifacts: [], recovery: true });
  }catch(error){publication.journal.error=String(error);await publication.state("FAILED");throw error;}
  finally{await publication.release();}
  }finally{await fs.rm(recovery,{recursive:true,force:true});}
}

/** Collect only immutable generation files owned by a sealed compiler manifest. */
export async function collectOldGenerations(config: ProjectConfig, keep = 2): Promise<string[]> {
  if(!Number.isSafeInteger(keep)||keep<1)fail("E_ARGUMENT","GC keep must be a positive integer");
  const active = validateActiveDescriptor(await readJson(path.join(generatedRoot(config), "active.json")));
  const publication = await acquirePublisher(config, active.generation);
  try { const result = await collectOwnedGenerations(config,keep); await publication.state("READY"); return result; }
  catch(error){publication.journal.error=String(error);await publication.state("FAILED");throw error;}
  finally{await publication.release();}
}
async function collectOwnedGenerations(config: ProjectConfig, keep: number): Promise<string[]> {
  if ((await activeRunLeases(config)).length) fail("E_RUN_ACTIVE", "Cannot collect while instances are alive");
  const root = generatedRoot(config), active = validateActiveDescriptor(await readJson(path.join(root, "active.json")));
  const dir = path.join(root, "manifests"), records: Array<{ file: string; manifest: RuntimeManifestV1; time: number }> = [];
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name); try { records.push({ file, manifest: parseRuntimeManifest(await fs.readFile(file, "utf8")), time: (await fs.stat(file)).mtimeMs }); } catch { /* Unknown or invalid files are never compiler-owned GC targets. */ }
  }
  records.sort((a, b) => b.time - a.time);
  const retained = new Set([active.generation, ...records.slice(0, Math.max(1, keep)).map(r => r.manifest.generation)]), removed: string[] = [];
  for (const record of records) if (!retained.has(record.manifest.generation)) {
    const prefixes = [`res://.godot/GodotJS/react-build/${record.manifest.generation}/`,`res://${config.generatedDir}/interfaces/${record.manifest.generation}/`,`res://.godot/GodotJS/${config.generatedDir}/interfaces/${record.manifest.generation}/`,`res://${config.generatedDir}/resources/${record.manifest.generation}/`];
    for (const [uri, artifact] of Object.entries(record.manifest.artifacts)) {
      if (artifact.owner !== "compiler" || !prefixes.some(prefix=>uri.startsWith(prefix))) continue;
      const file = fromRes(config.projectRoot, uri); if (!await exists(file)) continue;
      if (sha256(await fs.readFile(file)) !== artifact.sha256) fail("E_ARTIFACT_MODIFIED", `Refusing to remove changed file ${uri}`);
      await fs.rm(file); removed.push(uri);
    }
    await fs.rm(record.file); removed.push(toRes(config.projectRoot, record.file));
  }
  return removed;
}
