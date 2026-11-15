import ts from 'typescript';
import {moduleRequireOffsets} from '@godot-js/project-tools/script-bindings';
import {projectScript,projectDeclaration} from '@godot-js/project-tools/project-modules';

const extension=(name:string)=>name==='react'||name.startsWith('react/')||name==='@godot-js/react'||name.startsWith('@godot-js/react/');
const relevant=(name:string)=>extension(name)||name==='@playground/api';

/** Every packed script can be loaded by a scene or ResourceLoader. Inspect its
 * runtime module edges after TS type erasure, never words in JSON or comments.
 * This analysis emits no artifact; the shared project pipeline owns the build. */
export function projectRuntimeDependencies(files:Readonly<Record<string,string|readonly number[]>>) {
 const modules=new Set<string>();
 let demoTypes=false;
 for(const [filename,text]of Object.entries(files)){
  if(typeof text!=='string'||!projectScript.test(filename))continue;
  const source=ts.createSourceFile(filename,text,ts.ScriptTarget.ES2022,true);
  let candidate=false;
  const inspect=(node:ts.Node):void=>{
   if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier)&&relevant(node.moduleSpecifier.text))candidate=true;
   if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier)&&node.moduleSpecifier.text==='@playground/api')demoTypes=true;
   if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteralLike(node.argument.literal)&&node.argument.literal.text==='@playground/api')demoTypes=true;
   if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)&&node.moduleReference.expression&&ts.isStringLiteralLike(node.moduleReference.expression)&&relevant(node.moduleReference.expression.text))candidate=true;
   if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require')&&node.arguments[0]&&ts.isStringLiteralLike(node.arguments[0])&&relevant(node.arguments[0].text))candidate=true;
   ts.forEachChild(node,inspect);
  };
  inspect(source);if(!candidate||projectDeclaration.test(filename))continue;
  const output=ts.transpileModule(text,{fileName:filename.replace(/\.(?:mjs|mts)$/i,'.ts'),compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
  const runtime=ts.createSourceFile(filename+'.js',output,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS),requires=moduleRequireOffsets(runtime);
  const collect=(node:ts.Node):void=>{
   if(ts.isCallExpression(node)&&requires.has(node.getStart(runtime))&&node.arguments.length===1&&ts.isStringLiteralLike(node.arguments[0])&&relevant(node.arguments[0].text))modules.add(node.arguments[0].text);
   ts.forEachChild(node,collect);
  };
  collect(runtime);
 }
 const demo=modules.has('@playground/api');
 return {react:demo||[...modules].some(extension),demo,demoTypes,modules};
}
