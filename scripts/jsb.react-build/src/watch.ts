import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildProject } from "./compiler.js";
import { loadConfig } from "./config.js";
import { doctorProject } from "./doctor.js";
import { listFiles, projectInputExcluded, readJson, sha256 } from "./fs.js";
import { activeRunLeases, generatedRoot } from "./publication.js";
import { assertManagedWatchApplications, readManagedPreviews, startManagedPreview, type ManagedPreview, type PreviewDescriptor } from "./preview.js";
import { BuildError, fail, type BuildOptions } from "./types.js";

export interface WatchOptions extends BuildOptions {
  entry?:string;headless?:boolean;skipInitial?:boolean;signal?:AbortSignal;pollMs?:number;
  onEvent?:(event:Record<string,unknown>)=>void;
}
export async function watchProject(options:WatchOptions = {}):Promise<void> {
  if(options.signal?.aborted)return;
  let config = await loadConfig(options), last = "";
  if (options.entry && !Object.hasOwn(config.entries,options.entry)) fail("E_ENTRY",`Unknown entry ${options.entry}`);
  const emit = options.onEvent ?? (event => console.log(JSON.stringify(event)));
  const owned = new Map<string,ManagedPreview>(), pending = new Map<string,Pick<PreviewDescriptor,"sessionId"|"entryId"|"headless">>();
  const fingerprint = async () => {
    const files = await listFiles(config.projectRoot,rel => projectInputExcluded(rel,config.generatedDir) || rel.endsWith(".uid") || rel.endsWith(".import"));
    return sha256((await Promise.all(files.map(async f => `${f}:${sha256(await fs.readFile(f))}`))).join("\n"));
  };
  const resume = async (generation:string) => {
    for (const [id,preview] of pending) {
      if (options.signal?.aborted) return;
      const session = await startManagedPreview(config,generation,preview.entryId,{...preview,onOutput:(text,stream)=>emit({event:"preview-output",entryId:preview.entryId,generation,sessionId:id,stream,text})});
      owned.set(id,session);pending.delete(id);
      emit({event:"preview-started",entryId:preview.entryId,generation,sessionId:id});
      void session.result.then(result => emit({event:"preview-exited",entryId:preview.entryId,generation,code:result.code,stdout:result.stdout,stderr:result.stderr}),
        error => emit({event:"preview-error",entryId:preview.entryId,error:String(error)}))
        .finally(() => { if (owned.get(id) === session) owned.delete(id); });
    }
  };
  const build = async (reuse=false):Promise<boolean> => {
    try {
      config = await loadConfig(options);
      if (reuse) {
        const current = await doctorProject(options);
        if (current.ok) { emit({event:"built",generation:current.generation,reused:true});await resume(current.generation!);return true; }
      }
      const previews = await readManagedPreviews(config);
      await assertManagedWatchApplications(config,previews);
      for (const preview of previews) pending.set(preview.sessionId,preview);
      const result = await buildProject(options);
      emit({event:"built",...result});await resume(result.generation);return true;
    } catch (error) {
      emit({event:"error",error:String(error)});
      return !(error instanceof BuildError && ["E_BUILD_BUSY","E_SOURCE_CHANGED","E_RUN_ACTIVE"].includes(error.code));
    }
  };
  if (options.entry && !(await readManagedPreviews(config)).some(preview=>preview.entryId===options.entry)) {
    const sessionId=`watch-${randomUUID()}`;pending.set(sessionId,{sessionId,entryId:options.entry,headless:options.headless ?? false});
  }
  try {
    last=await fingerprint();
    if (!options.skipInitial) { if (!await build()) last=""; }
    else if (pending.size) {
      const current = await doctorProject(options);
      if (!current.ok) fail("E_BUILD_NOT_READY","--skip-initial requires an existing READY generation",current);
      await resume(current.generation!);
    }
    emit({event:'watching'});
    while (!options.signal?.aborted) {
      await new Promise<void>(resolve => {
        const done=() => {clearTimeout(timer);options.signal?.removeEventListener("abort",done);resolve();};
        const timer=setTimeout(done,options.pollMs ?? 350);options.signal?.addEventListener("abort",done,{once:true});
        if(options.signal?.aborted)done();
      });
      if (options.signal?.aborted) break;
      let exporting=false;
      for (const name of await activeRunLeases(config)) {
        const lease=await readJson<{rootId?:string}>(path.join(generatedRoot(config),"run-leases",name)).catch(() => undefined);
        if(lease?.rootId?.startsWith("@godot-react/"))exporting=true;
      }
      if(exporting)continue;
      const next=await fingerprint();if(next!==last && await build(true))last=next;
    }
  } finally {
    const closed=await Promise.allSettled([...owned.values()].map(session => session.stop()));
    const failure=closed.find(result => result.status === "rejected");
    if(failure?.status === "rejected")throw failure.reason;
  }
}
