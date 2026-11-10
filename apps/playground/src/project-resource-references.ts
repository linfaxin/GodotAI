type Files=Record<string,string|number[]>;
interface Token {start:number;end:number;text:string;value?:string;kind:'string'|'word'|'punct'}
function absolute(from:string,path:string):string|undefined {
 if(path.startsWith('res://'))path='/'+path.slice(6);
 else if(path.startsWith('/')||path.includes(':'))return undefined;
 else path=from.slice(0,from.lastIndexOf('/')+1)+path;
 const parts:string[]=[];
 for(const part of path.split('/')){if(part==='..'){if(!parts.length)return undefined;parts.pop();}else if(part&&part!=='.')parts.push(part);}
 return '/'+parts.join('/');
}
function relative(from:string,to:string):string {
 const left=from.split('/').slice(0,-1),right=to.split('/');
 while(left.length&&right.length&&left[0]===right[0]){left.shift();right.shift();}
 return [...left.map(()=>'..'),...right].join('/');
}
function unescape(value:string):string {
 const escapes:Record<string,string>={'n':'\n','r':'\r','t':'\t','b':'\b','f':'\f','v':'\v','a':'\x07','e':'\x1b','"':'"',"'":"'",'\\':'\\','/':'/','\n':''};
 return value.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g,(_match,key:string)=>{
  if(key[0]==='u'||key[0]==='U')return String.fromCodePoint(parseInt(key.slice(1),16));
  if(!Object.hasOwn(escapes,key))throw Error('资源字符串转义无效，无法安全重命名');
  return escapes[key];
 });
}
/** Lex literals/comments before interpreting dependency positions; never scan inside text. */
function tokens(text:string,mode:'config'|'gd'|'shader'):Token[] {
 const result:Token[]=[];let index=0;
 while(index<text.length){
  const start=index,ch=text[index],next=text[index+1];
  if(/\s/.test(ch)){index++;continue;}
  if(mode!=='shader'&&(ch==='#'||mode==='config'&&ch===';')||mode==='shader'&&ch==='/'&&next==='/'){
   const end=text.indexOf('\n',index);index=end<0?text.length:end;continue;
  }
  if(mode==='shader'&&ch==='/'&&next==='*'){
   const end=text.indexOf('*/',index+2);if(end<0)throw Error('资源注释未闭合，无法安全重命名');index=end+2;continue;
  }
  const raw=mode==='gd'&&ch==='r'&&(next==='"'||next==="'");
  if(ch==='"'||mode==='gd'&&ch==="'"||raw){
   if(raw)index++;
   const quote=text[index],delimiter=mode==='gd'&&text.slice(index,index+3)===quote.repeat(3)?quote.repeat(3):quote;
   index+=delimiter.length;const content=index;let closed=false;
   while(index<text.length){
    if(!raw&&text[index]==='\\'){index+=2;continue;}
    if(text.startsWith(delimiter,index)){closed=true;break;}index++;
   }
   if(!closed)throw Error('资源字符串未闭合，无法安全重命名');
   const value=raw?text.slice(content,index):unescape(text.slice(content,index));index+=delimiter.length;
   result.push({start,end:index,text:text.slice(start,index),value,kind:'string'});continue;
  }
  if(/[a-zA-Z0-9_./-]/.test(ch)){
   index++;while(index<text.length&&/[a-zA-Z0-9_./-]/.test(text[index]))index++;
   result.push({start,end:index,text:text.slice(start,index),kind:'word'});continue;
  }
  index++;result.push({start,end:index,text:ch,kind:'punct'});
 }
 return result;
}

export function rewriteResourceReferences(text:string,from:string,to:string,moves:ReadonlyMap<string,string>,files:Files):string {
 const mode=/\.gd$/i.test(from)?'gd':/\.(?:gdshader|gdshaderinc)$/i.test(from)?'shader':'config';
 const list=tokens(text,mode),edits:{start:number;end:number;text:string}[]=[];
 let section='',header='',assignment='';
 for(let index=0;index<list.length;index++){
  const item=list[index],previous=list[index-1],before=list[index-2];
  const linePrefix=text.slice(text.lastIndexOf('\n',item.start-1)+1,item.start);
  if(mode==='config'){
   if(item.text==='['&&/^\s*$/.test(linePrefix)&&list[index+1]?.kind==='word'){header=list[index+1].text;section=header;assignment='';}
   else if(item.text===']')header='';
   else if(item.kind==='word'&&/^\s*$/.test(linePrefix)&&list[index+1]?.text==='=')assignment=item.text;
  }
  if(item.kind!=='string')continue;
  let dependency=false,autoload=false;
  if(mode==='gd'){
   dependency=previous?.text==='extends'||previous?.text==='('&&['load','preload','ResourceLoader.load'].includes(before?.text??'');
  }else if(mode==='shader')dependency=/^\s*#\s*include\s*$/.test(linePrefix);
  else if(header==='ext_resource'&&previous?.text==='='&&before?.text==='path')dependency=true;
  else if(/\.godot$/i.test(from)){
   dependency=section==='application'&&assignment==='run/main_scene'||section==='autoload'&&!!assignment;
   autoload=section==='autoload';
  }else if(/\.(?:import|remap)$/i.test(from))dependency=section==='remap'&&/^path(?:\.|$)/.test(assignment)||section==='deps'&&['source_file','dest_files'].includes(assignment);
  else if(from.endsWith('/.godot/global_script_class_cache.cfg'))dependency=previous?.text===':'&&before?.kind==='string'&&['path','icon'].includes(before.value!);
  if(!dependency){
   if(mode==='gd'){
    const path=absolute(from,item.value!);
    if(path&&moves.has(path))throw Error('GDScript 中存在尚不能安全更新的路径引用：'+from);
   }
   continue;
  }
  const value=item.value!,prefix=autoload&&value.startsWith('*')?'*':'',path=value.slice(prefix.length);
  const split=path.indexOf('::'),base=split<0?path:path.slice(0,split),suffix=split<0?'':path.slice(split);
  const resolved=absolute(from,base);if(!resolved)continue;
  const next=moves.get(resolved)??resolved;if(next===resolved&&(from===to||path.startsWith('res://')))continue;
  if(!path.startsWith('res://')&&!Object.hasOwn(files,resolved))continue;
  edits.push({start:item.start,end:item.end,text:JSON.stringify(prefix+(path.startsWith('res://')?'res:/'+next:relative(to,next))+suffix)});
 }
 let result=text;
 for(const edit of edits.reverse())result=result.slice(0,edit.start)+edit.text+result.slice(edit.end);
 return result;
}
