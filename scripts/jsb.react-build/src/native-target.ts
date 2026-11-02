import path from "node:path";
import {promises as fs} from "node:fs";
import ts from "typescript";
import {NATIVE_BRIDGE_ABI,canonicalJson,type TargetCertification} from "@godot-js/react/contracts";
import {command,write,exists,sha256,type CommandRunner} from "./fs.js";
import {fail} from "./types.js";
export async function discoverNativeReport(godot:string,projectRoot:string,explicit?:string):Promise<{path:string;bytes:string;report:Record<string,unknown>;target:Partial<TargetCertification>}|undefined>{
 const binary=path.resolve(godot),candidates=explicit?[path.resolve(projectRoot,explicit)]:[path.join(path.dirname(binary),"react-native-build.json"),path.join(path.dirname(path.dirname(binary)),"react-native-build.json")];
 for(const candidate of candidates){
  if(!await exists(candidate)){if(explicit)fail("E_NATIVE_REPORT",`Missing native report ${candidate}`);continue;}
  const bytes=await fs.readFile(candidate,"utf8"),report=JSON.parse(bytes) as Record<string,unknown>;
  if(report.schemaVersion!==1||report.status!=="built"||typeof report.binarySha256!=="string")fail("E_NATIVE_REPORT",`Native report does not attest a completed build: ${candidate}`);
  if(sha256(await fs.readFile(binary))!==report.binarySha256)fail("E_NATIVE_REPORT",`Selected binary does not match native report: ${candidate}`);
  if(typeof report.sourceCommit!=="string"||!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(report.sourceCommit)||typeof report.sourceSnapshotHash!=="string"||!/^(?!0{64}$)[0-9a-f]{64}$/.test(report.sourceSnapshotHash)||!Array.isArray(report.flags))fail("E_NATIVE_REPORT",`Native report has an incomplete source tuple: ${candidate}`);
  const buildFlags:Record<string,string|number|boolean>={};for(const flag of report.flags){if(typeof flag!=="string")fail("E_NATIVE_REPORT","Invalid build flag");const equals=flag.indexOf("=");if(equals>0)buildFlags[flag.slice(0,equals)]=flag.slice(equals+1);}
  if(report.godotBuildRecipe){if(typeof report.godotBuildRecipeSha256!=="string"||sha256(JSON.stringify(report.godotBuildRecipe))!==report.godotBuildRecipeSha256)fail("E_NATIVE_REPORT","Missing or mismatched Godot build recipe digest");buildFlags.godot_build_recipe=String((report.godotBuildRecipe as {kind?:unknown}).kind);buildFlags.godot_build_recipe_sha256=report.godotBuildRecipeSha256;}
  const engine=report.engine==="qjs"?"quickjs":report.engine;
  if(!["quickjs","v8","jsc","web"].includes(String(engine)))fail("E_NATIVE_REPORT","Unknown engine in native report");
  return {path:candidate,bytes,report,target:{sourceCommit:report.sourceCommit,sourceDiffHash:report.sourceSnapshotHash,buildFlags,engine:engine as TargetCertification["engine"],platform:String(buildFlags.platform??process.platform),arch:String(buildFlags.arch??process.arch)}};
 }
 return undefined;
}
export function assertSourceCertified(target:TargetCertification):void{
 if(!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(target.sourceCommit)||!/^(?!0{64}$)[0-9a-f]{64}$/.test(target.sourceDiffHash)||!Object.keys(target.buildFlags).length||!/^(?!0{64}$)[0-9a-f]{64}$/.test(target.godotSchemaHash))fail("E_NATIVE_TARGET_UNCERTIFIED","Official export requires a source-certified native target: valid commit, source digest, build flags and schema digest");
}

/** Query the selected binary using only a trusted native Script in a minimal project. */
export async function discoverNativeTarget(godot:string,root:string,run:CommandRunner=command):Promise<Pick<TargetCertification,"engine"|"godotVersion">>{
 await write(path.join(root,"project.godot"),'config_version=5\n[application]\nconfig/name="Godot React binary descriptor"\n[GodotJS]\nruntime/debugger/debugger_port=0\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
 const source='declare const require:(id:string)=>any;const G=require("godot");export default class Descriptor extends G.Node{_ready(){try{const d=require("godot-jsb").internal.react?.descriptor;if(!d)throw Error("E_NATIVE_DESCRIPTOR");console.log("GODOT_REACT_NATIVE_DESCRIPTOR "+JSON.stringify(d));this.get_tree().quit(0);}catch(e){console.error("GODOT_REACT_NATIVE_DESCRIPTOR_FAILED",String(e));this.get_tree().quit(1);}}}';
 await write(path.join(root,"descriptor.ts"),source);
 await write(path.join(root,".godot/GodotJS/descriptor.js"),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
 await write(path.join(root,"descriptor.tscn"),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://descriptor.ts" id="1"]\n[node name="Descriptor" type="Node"]\nscript=ExtResource("1")\n');
 const result=await run(godot,["--headless","--path",root,"res://descriptor.tscn"],{cwd:root,timeoutMs:15_000});
 if(result.code!==0||/SCRIPT ERROR|Parse Error|^ERROR:|\[jsb\]\[Error\]/im.test(result.stdout+result.stderr))fail("E_NATIVE_DESCRIPTOR","Cannot query the selected Godot React binary",result);
 const line=result.stdout.split(/\r?\n/).find(line=>line.includes("GODOT_REACT_NATIVE_DESCRIPTOR "));
 if(!line)fail("E_NATIVE_DESCRIPTOR","Selected binary did not return its React bridge descriptor",result);
 const descriptor=JSON.parse(line.slice(line.indexOf("GODOT_REACT_NATIVE_DESCRIPTOR ")+"GODOT_REACT_NATIVE_DESCRIPTOR ".length)) as {engine?:unknown;godotVersion?:unknown;nativeBridgeAbi?:unknown};
 if(descriptor.nativeBridgeAbi!==NATIVE_BRIDGE_ABI||!["quickjs","v8","jsc","web"].includes(String(descriptor.engine))||typeof descriptor.godotVersion!=="string")fail("E_NATIVE_DESCRIPTOR","Selected binary has an incompatible React bridge descriptor",descriptor);
 return {engine:descriptor.engine as TargetCertification["engine"],godotVersion:descriptor.godotVersion};
}
