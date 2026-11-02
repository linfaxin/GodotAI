import path from "node:path";
import {promises as fs} from "node:fs";
import {fail, type ProjectConfig} from "./types.js";

/** Read only the relevant INI settings; do not evaluate Variant constructors or user code. */
export async function assertProjectPolicy(config:ProjectConfig,setup=false):Promise<void>{
 const text=await fs.readFile(path.join(config.projectRoot,"project.godot"),"utf8");let section="";
 for(const raw of text.split(/\r?\n/)){
  const line=raw.trim();if(!line||line.startsWith(";"))continue;
  const header=/^\[([^\]]+)\](?:[ \t]*;.*)?$/.exec(line);if(header){section=header[1];continue;}
  if(line.startsWith("["))fail("E_PROJECT_CONFIG","Unsupported project setting section syntax");
  if(section==="autoload")fail("E_UNMANAGED_AUTOLOAD","Project autoloads create roots outside the React-owned tree; move business services into React providers");
  if(!setup&&section==="application"&&/^run\/main_scene\s*=/.test(line)){
   const value=line.slice(line.indexOf("=")+1).trim();let uri:unknown;
   try{uri=JSON.parse(value);}catch{fail("E_ROOT_SCENE","Main scene must be a generated React entry scene path");}
   if(typeof uri!=="string"||!Object.keys(config.entries).some(id=>uri===`res://${config.generatedDir}/scenes/${id}.tscn`))fail("E_ROOT_SCENE",`Unmanaged main scene ${String(uri)}; select a configured generated React entry`);
  }
 }
}
