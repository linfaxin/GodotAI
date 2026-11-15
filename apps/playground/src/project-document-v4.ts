/** Opt-in new project format. Existing project-model/storage remain schema 3;
 * reading this format does not write or migrate persisted legacy records. */
export {readProjectDocument,createEngineProjectDocument,writeProjectDocument,exportOriginalDocument} from '@godot-js/project-tools/project-document';
export type {EngineProjectDocument,ReadProjectDocument} from '@godot-js/project-tools/project-document';
export {newEngineProject,projectCompileRequest,projectStorageDocument} from './project-model';
