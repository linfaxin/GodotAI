import {packProject} from '@godot-js/react-browser/pck';
import {prepareEngineProject,type EngineProjectOptions,type EngineProjectManifest,type EngineProjectDiagnostic} from '@godot-js/react-build/core';

export {prepareEngineProject,EngineProjectBuildError} from '@godot-js/react-build/core';
export type {EngineProjectOptions,EngineProjectManifest,EngineProjectDiagnostic,PreparedEngineProject} from '@godot-js/react-build/core';

export interface EngineProjectResult {
 pack:Uint8Array;manifest:EngineProjectManifest;diagnostics:EngineProjectDiagnostic[];
 index:Readonly<Record<string,{offset:number;size:number}>>;
}

/** Browser adapter: shared preparation followed by the existing PCK writer. */
export async function compileEngineProject(options:EngineProjectOptions):Promise<EngineProjectResult> {
 const prepared=prepareEngineProject(options);
 const {pack,index}=packProject(prepared.files,{maxBytes:options.maxBytes??256*1024*1024,maxFiles:options.maxFiles??10000});
 return {pack,index,manifest:prepared.manifest,diagnostics:prepared.diagnostics};
}
