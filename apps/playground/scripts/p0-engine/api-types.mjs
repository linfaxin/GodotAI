// P0 consumer of actual Web IR. This is a proof of the generator input boundary,
// not a replacement for the production GodotJS declaration generator.
import ts from 'typescript';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createEvidenceReceipt,REQUIRED_SOURCE_PATHS} from './evidence-utils.mjs';

const scalarNames=new Map([['Nil','unknown'],['bool','boolean'],['int','number | bigint'],['float','number'],['String','string'],['StringName','string']]);
const identifier=value=>/^[A-Za-z_$][\w$]*$/.test(value);
const key=value=>JSON.stringify(value);
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
export function generateDeclarations(ir){
 if(!ir.instrumentation||!ir.builtins?.length||!ir.utilities?.length)throw Error('Full target IR is required; class-name inventories are insufficient');
 const classes=new Map(ir.classes.map(c=>[c.name,c]));
 const builtins=new Map(ir.builtins.map(c=>[Number(c.type),c]));
 const unknownReferences=new Set(),excludedClassHints=new Set(),skipped=[],coverage={classes:0,builtins:0,properties:0,methods:0,signals:0,utilities:0};
 const nativePublic=new Map(ir.classes.map(c=>[c.name,c.publicName??c.name]));
 const nativeName=name=>nativePublic.get(name)??name;
 const primitiveType=(info,isReturn=false)=>{
  const index=Number(info?.type??0),builtin=builtins.get(index);
  if(index===0)return isReturn&&!(Number(info?.usage??0)&131072)?'void':'unknown';
  if(!builtin){unknownReferences.add('Variant type '+index);return 'unknown';}
  if(builtin.name==='Object'){
   const cls=info?.class_name;
   if(cls&&classes.has(cls))return nativeName(cls);
   if(cls){
    const candidates=String(cls).split(',').map(v=>v.trim()),included=[];
    for(const candidate of candidates){
     if(candidate.startsWith('-')){excludedClassHints.add(candidate.slice(1));continue;}
     if(classes.has(candidate))included.push(nativeName(candidate));else unknownReferences.add('class '+candidate);
    }
    if(included.length)return included.join(' | ');
   }
   return nativeName('Object');
  }
  return scalarNames.get(builtin.name)??builtin.publicName??builtin.name;
 };
 const publicName=info=>info.publicName??info.name;
 const argumentsOf=method=>{
  const args=method.args??[],optional=args.length-(method.default_args?.length??0);
  const list=args.map((arg,i)=>'arg'+i+(i>=optional?'?':'')+': '+primitiveType(arg));
  if(Number(method.flags)&16)list.push('...rest: unknown[]');
  return list.join(', ');
 };
 const signalType=signal=>'Signal<('+argumentsOf(signal)+') => void>';
 const methodLine=(method,staticPrefix='')=>`${staticPrefix}[${key(publicName(method))}](${argumentsOf(method)}): ${primitiveType(method.return,true)};`;
 const lines=['// Generated exclusively from a target Web API IR.', 'declare module "godot" {'];
 // These augmentations are explicitly JS binding features, not Variant metadata.
 lines.push('export class Callable<F extends (...args: any[]) => any = (...args: any[]) => any> {',
  'static create<F extends (...args: any[]) => any>(callback: F): Callable<F>;',
  'call(...args: Parameters<F>): ReturnType<F>;',
  '}',
  'export class Signal<F extends (...args: any[]) => any = (...args: any[]) => any> {',
  'connect(callback: Callable<F>, flags?: number): number;',
  'disconnect(callback: Callable<F>): void;',
  'emit(...args: Parameters<F>): void;',
  '}');
 for(const builtin of ir.builtins){
  const name=builtin.publicName??builtin.name;
  if(scalarNames.has(builtin.name)||builtin.name==='Object'||['Callable','Signal'].includes(builtin.name))continue;
  if(!identifier(name)){skipped.push({kind:'builtin-name',name});continue;}
  lines.push(`export class ${name} {`);coverage.builtins++;
  for(const constructor of builtin.constructors??[])lines.push(`constructor(${argumentsOf(constructor)});`);
  for(const property of builtin.properties??[]){lines.push(`[${key(publicName(property))}]: ${primitiveType(property)};`);coverage.properties++;}
  for(const method of builtin.methods??[]){
   if(['constructor','prototype'].includes(publicName(method))){skipped.push({kind:'builtin-method',class:name,name:method.name});continue;}
   lines.push(methodLine(method,Number(method.flags)&32?'static ':''));coverage.methods++;
  }
  lines.push('}');
 }
 for(const cls of ir.classes){
  const name=cls.publicName??cls.name;
  if(!identifier(name)){skipped.push({kind:'class-name',name});continue;}
  const parent=cls.parent&&classes.has(cls.parent)?` extends ${nativeName(cls.parent)}`:'';
  lines.push(`export ${cls.constructible?'':'abstract '}class ${name}${parent} {`);coverage.classes++;
  const accessors=new Set(),getterAccessors=new Set(),setterAccessors=new Set(),properties=new Set();
  for(const property of cls.properties??[]){
   if(Number(property.usage??0)&(64|128|256))continue;
   if(property.jsBinding?.kind==='methods'){skipped.push({kind:'binding-method-only-property',class:cls.name,name:property.name,reason:property.jsBinding.reason});continue;}
   const propertyName=publicName(property);properties.add(propertyName);
   if(property.getter){accessors.add(property.getter);getterAccessors.add(property.getter);}
   if(property.setter){accessors.add(property.setter);setterAccessors.add(property.setter);}
   lines.push(`${property.getter&&!property.setter?'readonly ':''}[${key(propertyName)}]: ${primitiveType(property)};`);coverage.properties++;
  }
  for(const signal of cls.signals??[]){
   if(properties.has(publicName(signal)))continue;
   lines.push(`readonly [${key(publicName(signal))}]: ${signalType(signal)};`);coverage.signals++;
  }
  for(const method of cls.methods??[]){
   const indexedAccessor=(getterAccessors.has(method.name)&&(method.args?.length??0)>0)||(setterAccessors.has(method.name)&&(method.args?.length??0)>1);
   if((accessors.has(method.name)&&!indexedAccessor)||['constructor','prototype'].includes(publicName(method))){skipped.push({kind:'property-accessor-or-reserved',class:cls.name,name:method.name});continue;}
   lines.push(methodLine(method,Number(method.flags)&32?'static ':''));coverage.methods++;
  }
  lines.push('}');
 }
 for(const method of ir.utilities){
  if(!identifier(publicName(method))||['typeof','delete','new','in','instanceof'].includes(publicName(method))){skipped.push({kind:'utility-keyword',name:method.name});continue;}
  lines.push(`export function ${publicName(method)}(${argumentsOf(method)}): ${primitiveType(method.return,true)};`);coverage.utilities++;
 }
 lines.push('}');
 return{declarations:lines.join('\n')+'\n',coverage,unknownReferences:[...unknownReferences].sort(),excludedClassHints:[...excludedClassHints].sort(),skipped,
  augmentations:['Callable.create(F) generic','Callable.call Parameters/ReturnType','Signal generic callback signature'],
  limitations:['P0 only: no production enum namespaces, singleton exports or GodotJS container proxy/iterator augmentation',
   'P0 only: inspector excluded-class hints are reported, not enforced as structural TypeScript exclusions',
   'P0 only: typed-container hints and all metadata precision are reported for production implementation',
   'P0 usage checks use skipLibCheck=true; this does not certify every declaration inheritance/override relationship',
   'Builtin numeric defaults retain typed text; P0 does not reconstruct arbitrary default Variant values']};
}

export async function checkApiTypes(ir,{outputDirectory='work/playground/p0'}={}){
 const evidenceReceipt=process.env.P0_REQUIRE_EVIDENCE==='1'?await createEvidenceReceipt(REQUIRED_SOURCE_PATHS.types):undefined;
 const result=generateDeclarations(ir),camel=ir.bindingNaming==='camel',output=path.resolve(outputDirectory);
 await mkdir(output,{recursive:true});
 const member=(nativeClass,original)=>ir.classes.find(c=>c.name===nativeClass)?.methods.find(m=>m.name===original)?.publicName??original;
 const prop=(nativeClass,original)=>ir.classes.find(c=>c.name===nativeClass)?.properties.find(m=>m.name===original)?.publicName??original;
 const cls=name=>ir.classes.find(c=>c.name===name)?.publicName??name;
 const translate=member('Node2D','translate'),addChild=member('Node','add_child'),timeLeft=prop('Timer','time_left');
 const signal=ir.classes.find(c=>c.name==='Node')?.signals.find(m=>m.name==='child_entered_tree')?.publicName??'child_entered_tree';
 const samples={
  positive:`import * as G from "godot"; const node=new G.${cls('Node2D')}();const base:G.${cls('Node')}=node;base.${addChild}(new G.${cls('Node2D')}());node.${translate}(new G.Vector2(1,2));const timer=new G.${cls('Timer')}();const seconds:number=timer.${timeLeft};node.${signal}.connect(G.Callable.create((child:G.${cls('Node')})=>{}));`,
  wrongArgument:`import * as G from "godot";new G.${cls('Node2D')}().${translate}("not a vector");`,
  wrongInheritance:`import * as G from "godot";const node:G.${cls('Node2D')}=new G.${cls('Node')}();`,
  readonlyProperty:`import * as G from "godot";new G.${cls('Timer')}().${timeLeft}=3;`,
  wrongSignal:`import * as G from "godot";new G.${cls('Node')}().${signal}.connect(G.Callable.create((child:string)=>{}));`,
  wrongBuiltin:`import * as G from "godot";new G.Vector2("bad",2);`,
 };
 const declaration=path.join(output,`api-types-${ir.bindingNaming}.d.ts`);await writeFile(declaration,result.declarations);
 const options={strict:true,skipLibCheck:true,noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,types:[]};
 const diagnostics={},samplePaths={};
 for(const [name,source]of Object.entries(samples)){
  const file=path.join(output,`api-types-${ir.bindingNaming}-${name}.ts`);await writeFile(file,source+'\n');
  samplePaths[name]=file;
 }
 const program=ts.createProgram([declaration,...Object.values(samplePaths)],options),allDiagnostics=ts.getPreEmitDiagnostics(program);
 for(const [name,file]of Object.entries(samplePaths))diagnostics[name]=allDiagnostics.filter(d=>!d.file||d.file.fileName===file).map(d=>({code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}));
 const declarationSyntax=program.getSyntacticDiagnostics(program.getSourceFile(declaration)).map(d=>({code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}));
 const checks={declarationSyntax:declarationSyntax.length===0,positive:diagnostics.positive.length===0,...Object.fromEntries(Object.entries(diagnostics).filter(([name])=>name!=='positive').map(([name,errors])=>[name,errors.length>0]))};
 const report={status:Object.values(checks).every(Boolean)?'passed':'failed',...(evidenceReceipt?{evidenceReceipt}:{}),naming:ir.bindingNaming,checkerOptions:{strict:true,skipLibCheck:true,noEmit:true},checks,diagnostics,declarationSyntax,coverage:result.coverage,unknownReferences:result.unknownReferences,excludedClassHints:result.excludedClassHints,skipped:result.skipped,augmentations:result.augmentations,limitations:result.limitations,
  irSha256:createHash('sha256').update(canonical(ir)).digest('hex'),declarationsSha256:createHash('sha256').update(result.declarations).digest('hex')};
 await writeFile(path.join(output,`api-types-${ir.bindingNaming}-report.json`),JSON.stringify(report,null,2));
 return report;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const input=process.argv[2]??'work/playground/p0/api-snake-api-ir.json';
 const report=await checkApiTypes(JSON.parse(await readFile(input,'utf8')));
 console.log(JSON.stringify(report,null,2));if(report.status!=='passed')process.exitCode=1;
}
