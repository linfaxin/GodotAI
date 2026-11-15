import ts from 'typescript';
import {moduleRequireOffsets} from './script-bindings.js';
import {moduleCandidates,projectModulePath} from './project-modules.js';

export interface ScriptRenamePlan {
 oldPath:string;newPath:string;
 sources:Record<string,string>;
 changes:Record<string,string>;
}
const script=/\.(?:[cm]?[jt]sx?)$/i;
function normalize(path:string):string {
 const parts:string[]=[];
 for(const part of path.split('/')){if(part==='..')parts.pop();else if(part&&part!=='.')parts.push(part);}
 return '/'+parts.join('/');
}
function relative(from:string,to:string):string {
 const left=from.split('/').slice(0,-1),right=to.split('/');
 while(left.length&&right.length&&left[0]===right[0]){left.shift();right.shift();}
 const value=[...left.map(()=>'..'),...right].join('/');return value.startsWith('.')?value:'./'+value;
}
/** Runs in a compiler worker/Node adapter, keeping TypeScript out of the editor bundle. */
export function prepareScriptRename(files:Readonly<Record<string,string|readonly number[]>>,oldPath:string,newPath:string):ScriptRenamePlan {
 for(const path of [oldPath,newPath])if(!path.startsWith('/')||path!==normalize(path)||/[\\:\x00-\x1f]/.test(path))throw Error('E_RENAME_PATH: '+path);
 const sources:Record<string,string>={},changes:Record<string,string>={};
 for(const [path,value]of Object.entries(files))if(typeof value==='string'&&script.test(path))sources[path]=value;
 for(const [path,text]of Object.entries(sources)){
  const ast=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
  const requires=moduleRequireOffsets(ast);
  const errors=(ast as ts.SourceFile&{parseDiagnostics?:readonly ts.Diagnostic[]}).parseDiagnostics;
  if(errors?.length)throw Error('E_RENAME_SYNTAX: '+path+': '+ts.flattenDiagnosticMessageText(errors[0].messageText,'\n'));
  const nextPath=path===oldPath?newPath:path,edits:{start:number;end:number;text:string}[]=[];
  const movedDirectory=path.slice(0,path.lastIndexOf('/'))!==nextPath.slice(0,nextPath.lastIndexOf('/'));
  for(const reference of ast.referencedFiles){
   const value=reference.fileName;
   const target=projectModulePath(value.startsWith('.')||value.startsWith('/')||value.startsWith('res://')?value:'./'+value,path);
   if(target===oldPath||path!==nextPath)throw Error('E_RENAME_UNSUPPORTED_REFERENCE: '+path+' 的 reference path 尚不支持自动更新');
  }
  const moduleLiterals=new Set<ts.Node>();
  const rewrite=(literal:ts.StringLiteralLike)=>{
   moduleLiterals.add(literal);
   const value=literal.text;if(!value.startsWith('.')&&!value.startsWith('res://')&&!value.startsWith('/'))return;
   const base=projectModulePath(value,path);if(!base)return;
   const target=moduleCandidates(base).find(candidate=>Object.hasOwn(files,candidate));if(!target)return;
   const nextTarget=target===oldPath?newPath:target;
   if(nextPath===path&&nextTarget===target)return;
   const extension=/\.(?:[cm]?[jt]sx?|json)$/i.exec(value)?.[0];
   let destination=nextTarget;
   if(extension){
    if(/\.[cm]?[jt]sx?$/i.test(extension)&&script.test(destination))destination=destination.replace(/\.[cm]?[jt]sx?$/i,extension);
   }else {
    destination=destination.replace(/(?:\.d)?\.[cm]?[jt]sx?$/i,'').replace(/\.json$/i,'');
    if(target!==base&&target.startsWith(base+'/index.')&&destination.endsWith('/index'))destination=destination.slice(0,-6);
   }
   const next=value.startsWith('res://')?'res:/'+destination:value.startsWith('/')?destination:relative(nextPath,destination);
   if(next!==value)edits.push({start:literal.getStart(ast),end:literal.getEnd(),text:JSON.stringify(next)});
  };
  const visit=(node:ts.Node)=>{
   if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier))rewrite(node.moduleSpecifier);
   else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)&&node.moduleReference.expression&&ts.isStringLiteralLike(node.moduleReference.expression))rewrite(node.moduleReference.expression);
   else if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||requires.has(node.getStart(ast)))&&node.arguments[0]&&ts.isStringLiteralLike(node.arguments[0]))rewrite(node.arguments[0]);
   if(ts.isStringLiteralLike(node)&&!moduleLiterals.has(node)){
    const value=node.text,base=projectModulePath(value,path);
    if(base&&(base===oldPath||movedDirectory&&value.startsWith('.')&&Object.hasOwn(files,base)))throw Error('E_RENAME_UNSUPPORTED_REFERENCE: '+path+' 中存在尚不能安全更新的路径引用');
   }
   ts.forEachChild(node,visit);
  };
  visit(ast);let rewritten=text;
  for(const edit of edits.sort((a,b)=>b.start-a.start))rewritten=rewritten.slice(0,edit.start)+edit.text+rewritten.slice(edit.end);
  if(rewritten!==text)changes[path]=rewritten;
 }
 return {oldPath,newPath,sources,changes};
}
