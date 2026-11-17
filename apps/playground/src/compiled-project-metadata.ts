import {parseImportReceipt,type ImportReceipt} from '@godot-js/project-tools/import-receipts';
import {canonicalJson} from '@godot-js/project-tools/hash';
import type {EditorProject} from './project-model';

/** Persist audited conversion evidence without applying generated files to the
 * source document or changing the retained original migration input. */
export function applyCompiledImportReceipts(project:EditorProject,manifest:Readonly<Record<string,unknown>>):boolean {
 const legacy=manifest.artifactReceipt as {imports?:unknown}|undefined;
 const value=Object.hasOwn(manifest,'importReceipts')?manifest.importReceipts:legacy?.imports;
 if(value===undefined)return false;
 if(!Array.isArray(value))throw Error('E_COMPILE_RECEIPT: Import receipts must be an array');
 const parsed=value.map(parseImportReceipt),seen=new Set<string>();
 for(const receipt of parsed){const key=receipt.resource.toLowerCase();if(seen.has(key))throw Error('E_COMPILE_RECEIPT: Duplicate resource receipt');seen.add(key);}
 if(!project.engineDocument)return false;
 const base=project.engineDocument.baseDocument,previous=base.importReceipts;
 if(previous!==undefined&&!Array.isArray(previous))throw Error('E_COMPILE_RECEIPT: Stored import receipts must be an array');
 const merged=new Map<string,ImportReceipt>((previous??[]).map(value=>{const receipt=parseImportReceipt(value);return [receipt.resource,receipt];}));
 for(const receipt of parsed)merged.set(receipt.resource,receipt);
 const next=[...merged.values()];if(canonicalJson(next)===canonicalJson(previous??[]))return false;
 base.importReceipts=next;return true;
}
