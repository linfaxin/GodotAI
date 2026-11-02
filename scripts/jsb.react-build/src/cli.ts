#!/usr/bin/env node
import { buildProject, checkProject, loadConfig, doctorProject, setupProject, previewProject, exportProject, recoverProject, collectOldGenerations, watchProject, BuildError, type BuildOptions } from "./index.js";

const args = process.argv.slice(2), operation = args.shift() ?? "help", flags = new Map<string, string | true>();
for (let i = 0; i < args.length; i++) { const key = args[i]; if (!key.startsWith("--")) throw Error(`Unexpected argument ${key}`); const value = args[i + 1]; flags.set(key.slice(2), value && !value.startsWith("--") ? (i++, value) : true); }
const string = (key: string) => typeof flags.get(key) === "string" ? flags.get(key) as string : undefined;
const options: BuildOptions = { projectRoot: string("project") ?? string("path"), config: string("config"), godot: string("godot"),waitPublisherMs:Number(string("wait-publisher-ms")??0), ...(flags.has("production") ? { mode: "production" } : {}) };
const emit = (value: unknown) => console.log(JSON.stringify(value));
async function cancellable<T>(run:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 const controller=new AbortController(),cancel=()=>controller.abort();
 process.once("SIGTERM",cancel);process.once("SIGINT",cancel);
 try{return await run(controller.signal);}
 finally{process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel);}
}
try {
  switch (operation) {
    case "setup": emit(await setupProject(options)); break;
    case "check": emit(await checkProject(options)); break;
    case "build": emit(await buildProject(options)); break;
    case "doctor": { const result = await doctorProject(options); emit(result); if (!result.ok) process.exitCode = 1; break; }
    case "watch": await cancellable(signal=>watchProject({...options,entry:string("entry"),headless:flags.has("headless"),skipInitial:flags.has("skip-initial"),signal,onEvent:emit})); break;
    case "preview": { const result = await cancellable(signal=>previewProject({ ...options, entry: string("entry"), verify: flags.has("verify"), headless:flags.has("headless"),signal })); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.code; break; }
    case "export": { const output = string("output"); if (!output) throw new BuildError("E_ARGUMENT", "export requires --output <file.pck>"); emit(await exportProject({ ...options, output, preset: string("preset"), entry: string("entry") })); break; }
    case "recover": await recoverProject(await loadConfig(options), flags.has("force-unowned-lock")); emit({ ok: true }); break;
    case "gc": emit({ removed: await collectOldGenerations(await loadConfig(options), Number(string("keep") ?? 2)) }); break;
    case "help": console.log("godot-react setup|check|build|watch|doctor|preview|export|recover|gc [--project DIR] [--config FILE] [--godot BIN]\nwatch: --skip-initial [--entry ID --headless]; preview: --entry ID --verify; export: --output FILE [--preset NAME] [--entry ID]"); break;
    default: throw new BuildError("E_ARGUMENT", `Unknown command ${operation}`);
  }
} catch (error) { console.error(JSON.stringify({ ok: false, code: error instanceof BuildError ? error.code : "E_BUILD", error: String(error), ...(error instanceof BuildError && error.details ? { details: error.details } : {}) })); process.exitCode = 1; }
