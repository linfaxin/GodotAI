import path from "node:path";
import {promises as fs} from "node:fs";
import ts from "typescript";
import {ENGINE_NATIVE_ABI,canonicalJson,type TargetCertification} from "@godot-js/react/contracts";
import {command,write,exists,sha256,type CommandRunner} from "./fs.js";
import {fail} from "./types.js";
const closureFields=["nativeInputSchemaVersion","dependencyManifest","dependencyManifestSha256","toolchain","toolchainSha256"] as const;
const digest=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==="object"&&!Array.isArray(value);
function dependencyCertification(report:Record<string,unknown>,flags:Record<string,string|number|boolean>):void{
 if(!closureFields.some(field=>Object.hasOwn(report,field))){flags.native_dependency_certification="legacy-unattested";return;}
 const reject=(message:string):never=>fail("E_NATIVE_REPORT",message);
 if(report.nativeInputSchemaVersion!==3||!object(report.dependencyManifest)||!object(report.toolchain)||!digest(report.dependencyManifestSha256)||!digest(report.toolchainSha256))reject("Incomplete native dependency/toolchain certification");
 const dependencies=report.dependencyManifest as Record<string,any>,toolchain=report.toolchain as Record<string,any>;
 if(sha256(canonicalJson(dependencies))!==report.dependencyManifestSha256||sha256(canonicalJson(toolchain))!==report.toolchainSha256)reject("Native dependency/toolchain digest mismatch");
 if(dependencies.schemaVersion!==1||dependencies.kind!=="godotjs-native-dependency-inputs"||!object(dependencies.target)||!object(dependencies.dependencies)||!object(dependencies.files))reject("Unknown native dependency manifest");
 const engine=report.engine==="quickjs"?"qjs":report.engine;
 if(!["qjs","v8"].includes(String(engine))||dependencies.target.engine!==engine||dependencies.target.platform!==flags.platform||dependencies.target.arch!==flags.arch)reject("Native dependency target mismatch");
 for(const [file,value]of Object.entries(dependencies.files) as [string,any][]){
  if(!/^(?:v8|lws)\//.test(file)||file.includes("\\")||file.split("/").some(part=>!part||part==="."||part==="..")||!object(value)||!digest(value.sha256)||!Number.isSafeInteger(value.bytes)||value.bytes<0||!["header","library"].includes(value.role))reject("Invalid native dependency input "+file);
 }
 const requireInput=(file:string,role:string)=>{const value=dependencies.files[file];if(!value||value.role!==role||value.bytes===0)reject("Missing native dependency input "+file);};
 if(engine==="qjs"){
  if(Object.keys(dependencies.dependencies).length||Object.keys(dependencies.files).length)reject("QuickJS report unexpectedly claims external V8/LWS dependencies");
 }else{
  const platform=String(flags.platform)==="linuxbsd"?"linux":String(flags.platform),arch=String(flags.arch);
  const supported:Record<string,string[]>={linux:["x86_64","arm64"],windows:["x86_64","arm64"],macos:["x86_64","arm64"],android:["x86_64","arm64","arm32"],ios:["x86_64","arm64","arm32"]};
  if(!supported[platform]?.includes(arch))reject("Unsupported external dependency target");
  const vd=platform==="windows"?"_":".",ld=platform==="ios"||platform==="macos"&&arch==="x86_64"?".":"_";
  const expected:Record<string,{include:string;library:string}>={v8:{include:`v8/include`,library:`v8/${platform}${vd}${arch}${vd}release/${platform==="windows"?"v8_monolith.lib":"libv8_monolith.a"}`},
   ...(platform!=="ios"||arch==="arm64"?{lws:{include:`lws/${platform}${ld}${arch}${ld}release/include`,library:`lws/${platform}${ld}${arch}${ld}release/${platform==="windows"?"websockets_static.lib":"libwebsockets.a"}`}}:{})};
  if(Object.keys(dependencies.dependencies).sort().join(",")!==Object.keys(expected).sort().join(","))reject("Incomplete selected external dependencies");
  for(const [name,paths]of Object.entries(expected)){
   const value=dependencies.dependencies[name];
   if(!object(value)||typeof value.declaredVersion!=="string"||!value.declaredVersion||typeof value.headerVersion!=="string"||!value.headerVersion||!Array.isArray(value.includeRoots)||!Array.isArray(value.libraries)||canonicalJson(value.includeRoots)!==canonicalJson([paths.include])||canonicalJson(value.libraries)!==canonicalJson([paths.library]))reject("Incomplete native dependency recipe "+name);
   requireInput(paths.library,"library");
   for(const header of name==="v8"?["v8.h","v8-version.h"]:["libwebsockets.h","lws_config.h"])requireInput(paths.include+"/"+header,"header");
  }
 }
 if(toolchain.schemaVersion!==1||toolchain.kind!=="godotjs-native-toolchain"||!object(toolchain.tools)||!object(toolchain.producer)||typeof toolchain.producer.node!=="string"||!digest(toolchain.producer.nodeExecutableSha256))reject("Unknown native toolchain manifest");
 for(const role of ["cc","cxx","link","backendLinker","ar","scons","python"]){const value=toolchain.tools[role];if(!object(value)||typeof value.command!=="string"||!value.command||typeof value.executablePath!=="string"||!value.executablePath||typeof value.version!=="string"||!value.version||!digest(value.executableSha256))reject("Missing selected native toolchain identity "+role);}
 if(flags.CC!==toolchain.tools.cc.command||flags.CXX!==toolchain.tools.cxx.command||flags.LINK!==toolchain.tools.link.command)reject("Native flags do not select the attested compiler/link drivers");
 if(!object(report.inputs)||!Object.keys(report.inputs).length||Object.values(report.inputs).some(value=>!digest(value))||!object(report.nativeIntegration)||!digest(report.godotBuildRecipeSha256))reject("Native v3 source tuple is incomplete");
 const proofs=Object.fromEntries(Object.entries(report.nativeIntegration as Record<string,unknown>).filter(([key])=>key.endsWith("Patch")));
 const expectedSource=sha256(canonicalJson({kind:"godotjs-native-source-inputs-v3",inputs:report.inputs,proofs,recipeSha256:report.godotBuildRecipeSha256,dependencyManifestSha256:report.dependencyManifestSha256,toolchainSha256:report.toolchainSha256}));
 if(expectedSource!==report.sourceSnapshotHash)reject("Native source identity does not bind its dependency/toolchain manifests");
 flags.native_input_schema=3;flags.native_dependency_certification="complete";flags.native_dependency_manifest_sha256=report.dependencyManifestSha256 as string;flags.native_toolchain_sha256=report.toolchainSha256 as string;
}
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
  try{dependencyCertification(report,buildFlags);}catch(error){if(error&&typeof error==="object"&&"code"in error&&error.code==="E_NATIVE_REPORT")throw error;fail("E_NATIVE_REPORT","Malformed native dependency/toolchain certification",error);}
  const engine=report.engine==="qjs"?"quickjs":report.engine;
  if(!["quickjs","v8","jsc","web"].includes(String(engine)))fail("E_NATIVE_REPORT","Unknown engine in native report");
  return {path:candidate,bytes,report,target:{sourceCommit:report.sourceCommit,sourceDiffHash:report.sourceSnapshotHash,buildFlags,engine:engine as TargetCertification["engine"],platform:String(buildFlags.platform??process.platform),arch:String(buildFlags.arch??process.arch)}};
 }
 return undefined;
}
/** Legacy source reports remain usable, but never establish dependency closure. */
export function assertNativeDependencyCertified(target:Pick<TargetCertification,"buildFlags">):void{
 if(target.buildFlags.native_input_schema!==3||target.buildFlags.native_dependency_certification!=="complete"||!digest(target.buildFlags.native_dependency_manifest_sha256)||!digest(target.buildFlags.native_toolchain_sha256))fail("E_NATIVE_DEPENDENCIES_UNCERTIFIED","A complete native dependency/toolchain manifest is required");
}
export function assertSourceCertified(target:TargetCertification):void{
 if(!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(target.sourceCommit)||!/^(?!0{64}$)[0-9a-f]{64}$/.test(target.sourceDiffHash)||!Object.keys(target.buildFlags).length||!/^(?!0{64}$)[0-9a-f]{64}$/.test(target.godotSchemaHash))fail("E_NATIVE_TARGET_UNCERTIFIED","Official export requires a source-certified native target: valid commit, source digest, build flags and schema digest");
 if(target.buildFlags.native_input_schema!==undefined||target.buildFlags.native_dependency_certification==="complete")assertNativeDependencyCertified(target);
}

/** Query the selected binary using only a trusted native Script in a minimal project. */
export async function discoverNativeTarget(godot:string,root:string,run:CommandRunner=command):Promise<Pick<TargetCertification,"engine"|"godotVersion">>{
 await write(path.join(root,"project.godot"),'config_version=5\n[application]\nconfig/name="Godot engine binary descriptor"\n[GodotJS]\nruntime/debugger/debugger_port=0\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
 const source='declare const require:(id:string)=>any;const G=require("godot");export default class Descriptor extends G.Node{_ready(){try{const d=require("godot-jsb").internal.engine_descriptor;if(!d)throw Error("E_NATIVE_DESCRIPTOR");console.log("GODOT_REACT_NATIVE_DESCRIPTOR "+JSON.stringify(d));this.get_tree().quit(0);}catch(e){console.error("GODOT_REACT_NATIVE_DESCRIPTOR_FAILED",String(e));this.get_tree().quit(1);}}}';
 await write(path.join(root,"descriptor.ts"),source);
 await write(path.join(root,".godot/GodotJS/descriptor.js"),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
 await write(path.join(root,"descriptor.tscn"),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://descriptor.ts" id="1"]\n[node name="Descriptor" type="Node"]\nscript=ExtResource("1")\n');
 const result=await run(godot,["--headless","--path",root,"res://descriptor.tscn"],{cwd:root,timeoutMs:15_000});
 if(result.code!==0||/SCRIPT ERROR|Parse Error|^ERROR:|\[jsb\]\[Error\]/im.test(result.stdout+result.stderr))fail("E_NATIVE_DESCRIPTOR","Cannot query the selected Godot engine binary",result);
 const line=result.stdout.split(/\r?\n/).find(line=>line.includes("GODOT_REACT_NATIVE_DESCRIPTOR "));
 if(!line)fail("E_NATIVE_DESCRIPTOR","Selected binary did not return its engine runtime descriptor",result);
 const descriptor=JSON.parse(line.slice(line.indexOf("GODOT_REACT_NATIVE_DESCRIPTOR ")+"GODOT_REACT_NATIVE_DESCRIPTOR ".length)) as {engine?:unknown;godotVersion?:unknown;nativeBridgeAbi?:unknown;nativeRuntimeAbi?:unknown};
 if(descriptor.nativeRuntimeAbi!==1||descriptor.nativeBridgeAbi!==ENGINE_NATIVE_ABI||!["quickjs","v8","jsc","web"].includes(String(descriptor.engine))||typeof descriptor.godotVersion!=="string")fail("E_NATIVE_DESCRIPTOR","Selected binary has an incompatible engine runtime descriptor",descriptor);
 return {engine:descriptor.engine as TargetCertification["engine"],godotVersion:descriptor.godotVersion};
}
