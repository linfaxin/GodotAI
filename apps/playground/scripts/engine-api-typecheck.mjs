import ts from 'typescript';

/** Check exactly the supplied declaration snapshot against actual target names.
 * No generated-file mutation, native/editor types, DOM, Node globals or skipped
 * library diagnostics are involved. This is used by the release assembler. */
export function verifyEngineTypes(api, declarationFiles) {
 const cls=name=>api.classes.find(c=>c.nativeName===name)?.publicName??api.builtins.find(c=>c.nativeName===name)?.publicName??name;
 const method=(type,name)=>api.classes.find(c=>c.nativeName===type)?.methods.find(m=>m.nativeName===name)?.publicName??api.builtins.find(c=>c.nativeName===type)?.methods.find(m=>m.nativeName===name)?.publicName??name;
 const property=(type,name)=>api.classes.find(c=>c.nativeName===type)?.properties.find(m=>m.nativeName===name)?.publicName??name;
 const signal=api.classes.find(c=>c.nativeName==='Node')?.signals.find(s=>s.nativeName==='child_entered_tree')?.publicName;
 const owner=api.classes.find(c=>c.nativeName==='Node');
 const mode=owner?.enums.find(e=>e.nativeName==='ProcessMode');
 const modeValue=owner?.constants.find(c=>c.nativeName==='PROCESS_MODE_INHERIT');
 const intEnum=api.globalConstants.find(c=>c.nativeName==='TYPE_INT');
 if(!signal||!mode||!modeValue||!intEnum)throw Error('E_ENGINE_TYPES_TARGET: standard Node/Variant metadata is required');
 const typeInt=(intEnum.enumPublicName??'Variant.Type')+'.'+(intEnum.enumValueName??intEnum.publicName);
 const vector=api.builtins.find(m=>m.nativeName==='Vector2'),string=api.builtins.find(m=>m.nativeName==='String'),bytes=api.builtins.find(m=>m.nativeName==='PackedByteArray');
 const source=`import * as G from "godot";
import {createClassBinder} from "godot.annotations";
import {internal} from "godot-jsb";
import lib = require("godot.lib.api");
const bind=createClassBinder();
@bind()
export default class Main extends G.${cls('Node2D')} {
 @bind.export(G.${typeInt}) accessor count:number=1;
 @bind.export.range_int(0,10,1) accessor range:number=1;
 @bind.export(G.${typeInt},{${api.bindingNaming==='camel'?'hintString':'hint_string'}:"0,10,1"}) accessor manual:number=1;
 _ready(){
  const base:G.${cls('Node')}=this;
  base.${method('Node','add_child')}(new G.${cls('Node2D')}());
  this.${method('Node2D','translate')}(new G.${cls('Vector2')}(1,2));
  ${api.builtins.find(m=>m.nativeName==='Vector2')?.bindingOperators?.some(m=>m.publicName==='ADD')?`const sum:G.${cls('Vector2')}=G.${cls('Vector2')}.ADD(new G.${cls('Vector2')}(),new G.${cls('Vector2')}());`:''}
  ${vector?.bindingExtras?.getIndexed?`const component:number=new G.${cls('Vector2')}().${vector.bindingExtras.getIndexed}(0);`:''}
  ${string?.bindingKind==='utility'?`const length:number|bigint=G.${string.publicName}.length_("abc");`:''}
  ${bytes?.bindingExtras?.toArrayBuffer?`const buffer:ArrayBuffer=new G.${bytes.publicName}().${bytes.bindingExtras.toArrayBuffer}();`:''}
  this.${property('Node','process_mode')}=G.${cls('Node')}.${mode.publicName}.${modeValue.publicName};
  const timer=new G.${cls('Timer')}();const seconds:number=timer.${property('Timer','time_left')};
  this.${signal}.connect(G.${cls('Callable')}.create((child:G.${cls('Node')})=>{}));
  const signalResult:Promise<G.${cls('Node')}>=this.${signal}.${api.bindingNaming==='camel'?'asPromise':'as_promise'}();
  const array=new G.${cls('Array')}<string>();array.${method('Array','push_back')}("value");const text:string=array.${method('Array','get')}(0);
  const dictionary=new G.${cls('Dictionary')}<string,number>();dictionary.${method('Dictionary','set')}("one",1);const maybe:number|null=dictionary.${method('Dictionary','get')}("one");
  const record:number=dictionary.proxy().one;const raw:G.${cls('Dictionary')}<string,number>=dictionary.proxy()[G.ProxyTarget];
  const packed=new G.${cls('PackedInt64Array')}();packed.${method('PackedInt64Array','push_back')}(9007199254740993n);const integer:number|bigint=packed.${method('PackedInt64Array','get')}(0);
  const singleton:boolean=G.${api.singletons.find(s=>s.nativeName==='Engine').publicName}.${method('Engine','has_singleton')}("Engine");
  ${api.utilities.some(m=>m.nativeName==='print')?`G.${api.utilities.find(m=>m.nativeName==='print').publicName}("vararg",1,true);`:''}
  const primitive:null=lib.proxy.key_only_proxy(null);
  internal.get_engine_api();console.log(seconds,text,maybe,integer,singleton,primitive,record,raw);
 }
}
`;
 const negativeSources={
  wrongArgument:`new G.${cls('Node2D')}().${method('Node2D','translate')}("bad");`,
  readonly:`new G.${cls('Timer')}().${property('Timer','time_left')}=2;`,
  wrongSignal:`new G.${cls('Node')}().${signal}.connect(G.${cls('Callable')}.create((node:string)=>{}));`,
  typedArray:`new G.${cls('Array')}<string>().${method('Array','push_back')}(123);`,
  typedDictionary:`new G.${cls('Dictionary')}<string,number>().${method('Dictionary','set')}("key","bad");`,
  wrongEnum:`new G.${cls('Node')}().${property('Node','process_mode')}=99999;`,
  wrongBuiltin:`new G.${cls('Vector2')}("bad",2);`,
  wrongInheritance:`const node:G.${cls('Node2D')}=new G.${cls('Node')}();`,
  methodOnlyProperty:`new G.${cls('Node')}().name="expando";`,
  requiredParameter:`new G.${cls('Node')}().${method('Node','add_child')}();`,
  ...(api.builtins.find(m=>m.nativeName==='Vector2')?.bindingOperators?.some(m=>m.publicName==='ADD')?{wrongOperator:`G.${cls('Vector2')}.ADD("bad",new G.${cls('Vector2')}());`}:{}),
  ...(vector?.bindingExtras?.getIndexed?{wrongIndex:`new G.${cls('Vector2')}().${vector.bindingExtras.getIndexed}(1n);`}:{}),
  ...(string?.bindingKind==='utility'?{wrongStringUtility:`G.${string.publicName}.length_(123);`}:{}),
 };
 const positive='/__engine_types__/positive.ts';
 const virtual=new Map(Object.entries(declarationFiles));virtual.set(positive,source);
 const negatives={};for(const [name,value]of Object.entries(negativeSources)){const file='/__engine_types__/'+name+'.ts';virtual.set(file,'import * as G from "godot";\n'+value);negatives[name]=file;}
 const options={strict:true,skipLibCheck:false,noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,lib:['lib.es2022.d.ts'],types:[]};
 const host=ts.createCompilerHost(options),baseGet=host.getSourceFile,baseRead=host.readFile,baseExists=host.fileExists;
 host.getSourceFile=(name,languageVersion,...rest)=>virtual.has(name)?ts.createSourceFile(name,virtual.get(name),languageVersion,true):baseGet(name,languageVersion,...rest);
 host.readFile=name=>virtual.get(name)??baseRead(name);host.fileExists=name=>virtual.has(name)||baseExists(name);
 const program=ts.createProgram([...virtual.keys()],options,host),all=ts.getPreEmitDiagnostics(program);
 const format=value=>({file:value.file?.fileName,line:value.file&&value.start!==undefined?value.file.getLineAndCharacterOfPosition(value.start).line+1:undefined,code:value.code,message:ts.flattenDiagnosticMessageText(value.messageText,'\n')});
 const declarationDiagnostics=all.filter(d=>!d.file||d.file.fileName.endsWith('.d.ts')).map(format);
 const positiveDiagnostics=all.filter(d=>d.file?.fileName===positive).map(format);
 const negativeDiagnostics=Object.fromEntries(Object.entries(negatives).map(([name,file])=>[name,all.filter(d=>d.file?.fileName===file).map(format)]));
 const checks={declarations:declarationDiagnostics.length===0,positive:positiveDiagnostics.length===0,...Object.fromEntries(Object.entries(negativeDiagnostics).map(([name,list])=>[name,list.length>0]))};
 return{status:Object.values(checks).every(Boolean)?'passed':'failed',compiler:{version:ts.version,strict:true,skipLibCheck:false,target:'ES2022',lib:['ES2022'],types:[]},checks,declarationDiagnostics,positiveDiagnostics,negativeDiagnostics};
}
