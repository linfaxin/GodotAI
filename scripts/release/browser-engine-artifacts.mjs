import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {canonical,digest} from './web-release-utils.mjs';
import {engineBuildArgs,getEngineProfile,validateEngineProfile} from './engine-profiles.mjs';
import {isSourceCertified} from './engine-build-proof.mjs';

/** The namespace covers all resolved build switches. Scheduling alone does not
 * change it; ThinLTO's link parallelism is a real recorded linker argument. */
export function browserEnginePaths({repository,profile='full-engine-v1',target='template_debug',lto='none',moduleMode='baseline',jobs=4}){
 const args=engineBuildArgs({profile,target,lto,moduleMode,jobs});
 const configurationId=digest(canonical({version:1,args:args.filter(value=>!/^\-j\d+$/.test(value))}));
 const parts=[profile,target,moduleMode,lto,configurationId.slice(0,16)];
 const artifactDirectory=path.resolve(repository,'work/playground',...parts);
 return {configurationId,artifactDirectory,reportPath:path.join(artifactDirectory,'engine-report.json'),templatePath:path.join(artifactDirectory,'engine-template.zip'),buildDirectory:path.resolve(repository,'../work/godotjs-web',...parts)};
}
async function exists(filename){try{await access(filename);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
export function browserEngineVariant(report){
 const args=report?.requestedArgs??report?.recipe?.args??[];
 const lto=report?.resolvedBuildOptions?.lto??args.find(value=>value.startsWith('lto='))?.slice(4);
 const enabled=report?.resolvedBuildOptions?.modules_enabled_by_default;
 const modules=typeof enabled==='boolean'?enabled:args.includes('modules_enabled_by_default=no')?false:args.includes('modules_enabled_by_default=yes')?true:undefined;
 const jobs=args.find(value=>/^-j\d+$/.test(value));
 return {lto,moduleMode:modules===undefined?undefined:modules?'baseline':'explicit',jobs:jobs?Number(jobs.slice(2)):undefined};
}

/** Ordinary builds require a matching certified report. Local unproven input
 * is an explicit development choice and cannot receive a site acceptance seal. */
export async function resolvePlaygroundEngine(configuration){
 const {repository,development=false}=configuration;
 if(configuration.templatePath&&!path.isAbsolute(configuration.templatePath))throw Error('E_PLAYGROUND_ENGINE_REPORT: template override must be absolute');
 let reportPath=configuration.reportPath&&path.resolve(configuration.reportPath);
 if(!reportPath&&configuration.templatePath){
  const adjacent=path.join(path.dirname(configuration.templatePath),'engine-report.json');if(await exists(adjacent))reportPath=adjacent;
 }
 let reportBytes=reportPath?await readFile(reportPath):undefined,report=reportBytes?JSON.parse(reportBytes):undefined;
 const variant=browserEngineVariant(report);
 const selected={profile:configuration.profile??report?.runtimeProfile??'full-engine-v1',target:configuration.target??report?.engineTarget??'template_debug',lto:configuration.lto??variant.lto??'none',moduleMode:configuration.moduleMode??variant.moduleMode??'baseline',jobs:configuration.jobs??variant.jobs??4};
 getEngineProfile(selected.profile);
 const defaults=browserEnginePaths({...selected,repository});
 if(!reportPath&&!configuration.templatePath&&await exists(defaults.reportPath)){
  // A default namespace is itself a configuration selection. A misplaced
  // report must not silently switch it to another recipe.
  reportPath=defaults.reportPath;reportBytes=await readFile(reportPath);report=JSON.parse(reportBytes);
 }
 if(!reportPath&&!development)throw Error('E_PLAYGROUND_SOURCE: Missing engine build report; build the selected profile/target/module-mode/LTO first, pass --engine-report, or use --development for an uncertified local template');
 if(report&&(report.kind!=='godot-js-browser-engine-build'||!['built',...(development?['existing-development']:[])].includes(report.status)||report.runtimeProfile!==selected.profile||report.engineTarget!==selected.target))throw Error('E_PLAYGROUND_ENGINE_REPORT: profile, target or build status mismatch');
 if(!development&&(!report?.sourceCertified||!isSourceCertified(report)))throw Error('E_PLAYGROUND_SOURCE: A source-certified engine report is required; use --development only for an uncertified local template');
 const actual=browserEngineVariant(report);
 for(const key of ['lto','moduleMode'])if(actual[key]!==undefined&&actual[key]!==selected[key])throw Error('E_PLAYGROUND_ENGINE_REPORT: '+key+' differs from the requested configuration');
 if(selected.lto==='thin'&&actual.jobs!==undefined&&actual.jobs!==Number(selected.jobs))throw Error('E_PLAYGROUND_ENGINE_REPORT: ThinLTO link jobs differ from the requested configuration');
 if(report?.modules)validateEngineProfile(selected.profile,{modules:report.modules,features:report.resolvedFeatures?{...report.resolvedBuildOptions,...report.resolvedFeatures}:undefined});
 const template=configuration.templatePath?path.resolve(configuration.templatePath):report?.template?.path?path.resolve(path.dirname(reportPath),report.template.path):defaults.templatePath;
 const templateBytes=await readFile(template),templateHash=digest(templateBytes);
 if(report&&(!report.template||report.template.sha256!==templateHash||(report.template.bytes!==undefined&&report.template.bytes!==templateBytes.length)))throw Error('E_PLAYGROUND_ENGINE_REPORT: template bytes differ from the report');
 return {configuration:selected,defaults,reportPath,report,reportSha256:reportBytes?digest(reportBytes):undefined,template,templateHash,sourceCertified:Boolean(!development&&report?.sourceCertified&&isSourceCertified(report))};
}
