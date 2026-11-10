import ts from 'typescript';

/** Identify the CommonJS require binding without confusing local variables,
 * parameters, imports or hoisted declarations with the module loader. */
export function moduleRequireOffsets(source:ts.SourceFile):ReadonlySet<number> {
 // Keep the emitter's bound tree intact: the small no-lib program is solely
 // for lexical symbol lookup and never reads project dependencies or the host.
 // TS programs normalize URI-like res:// paths differently from SourceFile.
 // Scope lookup needs no module resolution, so use one ordinary virtual path.
 const file=ts.createSourceFile('/__require_analysis'+(source.languageVariant===ts.LanguageVariant.JSX?'.tsx':'.ts'),source.text,ts.ScriptTarget.Latest,true);
 const matches=(name:string)=>name===file.fileName;
 const host:ts.CompilerHost={
  getSourceFile:name=>matches(name)?file:undefined,getDefaultLibFileName:()=>'',writeFile:()=>{},
  getCurrentDirectory:()=>'',getDirectories:()=>[],getCanonicalFileName:name=>name,useCaseSensitiveFileNames:()=>true,
  getNewLine:()=>'\n',fileExists:matches,readFile:name=>matches(name)?file.text:undefined,
 };
 const program=ts.createProgram([file.fileName],{noLib:true,noResolve:true,target:ts.ScriptTarget.Latest},host),checker=program.getTypeChecker();
 const offsets=new Set<number>();
 const visit=(node:ts.Node)=>{
  if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='require'){
   const symbol=checker.getSymbolAtLocation(node.expression);
   const shadowed=symbol?.declarations?.some(declaration=>!declaration.getSourceFile().isDeclarationFile
    &&!(ts.getCombinedModifierFlags(declaration as ts.Declaration)&ts.ModifierFlags.Ambient)
    &&!(ts.isFunctionDeclaration(declaration)&&!declaration.body));
   if(!shadowed)offsets.add(node.getStart(file));
  }
  ts.forEachChild(node,visit);
 };
 visit(file);return offsets;
}
