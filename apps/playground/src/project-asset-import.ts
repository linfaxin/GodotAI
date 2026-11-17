import {addProjectFiles,filePath,parseProject,type EditorProject} from './project-model.ts';
import {parseResourceImports,type ResourceImportRequest} from '@godot-js/project-tools/resource-converters';

/** New Schema 4 binary assets opt into explicit production recipes. Existing
 * recipes/import sidecars retain their native type and producer semantics. */
export function importProjectAssets(project:EditorProject,entries:[string,string|number[]][]):void {
 const staged=parseProject(project);addProjectFiles(staged,entries);
 if(staged.engineDocument){
  const document=staged.engineDocument.baseDocument,recipes=structuredClone((document.resourceImports??[]) as ResourceImportRequest[]);
  const existing=new Set(parseResourceImports(recipes).map(recipe=>recipe.resource.toLowerCase()));
  for(const [name,bytes]of entries){
   const path=filePath(name),resource='res://'+path.slice(1);
   if(typeof bytes==='string'||existing.has(resource.toLowerCase())||Object.hasOwn(staged.files,path+'.import')||Object.hasOwn(staged.files,path+'.remap'))continue;
   const extension=/\.([^.\/]+)$/.exec(path)?.[1].toLowerCase(),converter=extension==='png'?'godotjs/png-ctex':extension==='jpg'||extension==='jpeg'?'godotjs/jpeg-ctex':extension==='wav'?'godotjs/wav-pcm':undefined;
   if(!converter)continue;
   recipes.push({resource,converter,...(extension==='wav'?{}:{parameters:{mipmaps:false}})});existing.add(resource.toLowerCase());
  }
  if(recipes.length)document.resourceImports=recipes;
 }
 // Validate the complete file/recipe update before publishing either part.
 const checked=parseProject(staged);project.files=checked.files;if(checked.engineDocument)project.engineDocument=checked.engineDocument;
}
