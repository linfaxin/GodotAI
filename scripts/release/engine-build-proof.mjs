import {assertCommit,assertHash,canonical,digest} from './web-release-utils.mjs';
import {executionFromReport} from './execution-contract.mjs';

/** Validate recorded source/recipe evidence, rather than trusting a flag. */
export function isSourceCertified(report){
 if(report?.kind!=='godot-js-browser-engine-build'||report.status!=='built')return false;
 try{
  assertCommit(report.source?.commit,'GodotJS commit');assertHash(report.source?.snapshotHash,'GodotJS snapshot');
  assertCommit(report.godotSource?.commit,'Godot commit');assertHash(report.godotSource?.snapshotHash,'Godot snapshot');
  for(const source of [report.source,report.godotSource])if(digest(canonical(source.inputs))!==source.snapshotHash)return false;
  if(digest(canonical(report.recipe))!==report.recipeSha256)return false;
  executionFromReport(report);
  return Boolean(report.builder?.sha256&&report.toolchains?.emscripten&&report.versionEvidence?.sha256);
 }catch{return false;}
}
