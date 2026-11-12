export type EngineProfileId='full-engine-v1'|'engine-2d-v1';
export interface EngineProfile {readonly id:EngineProfileId;readonly label:string;readonly runtimeFamily:'native';readonly audio:boolean;readonly modules:readonly string[];readonly requiredModules:readonly string[];readonly allowedModules:readonly string[];readonly disabledModules:readonly string[];readonly forbiddenModules:readonly string[];readonly features:Readonly<Record<string,boolean>>;readonly requiredClasses:readonly string[];readonly forbiddenClasses:readonly string[];readonly demoIds:readonly string[];}
export const FULL_ENGINE_PROFILE:'full-engine-v1';
export const ENGINE_2D_PROFILE:'engine-2d-v1';
export const FULL_WEB_MODULE_BASELINE:readonly string[];
export const ENGINE_2D_MODULE_BASELINE:readonly string[];
export const ENGINE_PROFILES:Readonly<Record<EngineProfileId,EngineProfile>>;
export function isEngineProfile(id:unknown):id is EngineProfileId;
export function getEngineProfile(id?:string):EngineProfile;
export function engineBuildArgs(configuration?:{profile?:string;target?:string;jobs?:number|string;lto?:string;moduleMode?:string}):string[];
export function validateEngineProfile(profileId:string,observations:{modules:string[];features?:Record<string,boolean>;classes?:Array<string|{nativeName?:string;name?:string}>;forBuild?:boolean}):EngineProfile;
