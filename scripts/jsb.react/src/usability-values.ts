import {ERROR_CODES,invariant} from './contracts';
/** Closed, resource-free markup. Images use registered texture commands instead of paths. */
export function validateRichText(text:string,bbcode:boolean):void {
 invariant(Array.from(text).length<=128000,ERROR_CODES.VALUE,'Rich text exceeds 128000 characters');
 if(!bbcode)return;
 const stack:string[]=[];let count=0,cells=0,previous=0;
 for(const match of text.matchAll(/\[([^\]]*)\]/g)) {
  if(stack.at(-1)==='table')invariant(!text.slice(previous,match.index).trim(),ERROR_CODES.VALUE,'Table text must be inside a cell');previous=match.index!+match[0].length;
  invariant(++count<=4096,ERROR_CODES.VALUE,'Rich text tag budget exceeded');
  const tag=match[1]!;
  if(tag==='lb'||tag==='rb'||tag==='br'){invariant(stack.at(-1)!=='table',ERROR_CODES.VALUE,'Only cells may be direct table children');continue;}
  if(tag.startsWith('/')){invariant(stack.pop()===tag.slice(1),ERROR_CODES.VALUE,'Unbalanced rich text tags');continue;}
  const [name,...parts]=tag.split('='),value=parts.join('=');
  invariant(['b','i','u','s','code','center','left','right','fill','color','bgcolor','font_size','url','table','cell','ul','ol','indent','hint'].includes(name!),ERROR_CODES.VALUE,'Unsupported rich text tag');
  if(name==='table'){invariant(!stack.includes('table')&&/^\d{1,2}$/.test(value)&&Number(value)>=1&&Number(value)<=16,ERROR_CODES.VALUE,'Expected a non-nested table with 1..16 columns');}
  else if(name==='cell'){invariant(parts.length===0&&stack.at(-1)==='table'&&++cells<=1024,ERROR_CODES.VALUE,'Cell must be inside a table (up to 1024 cells)');}
  else if(name==='color'||name==='bgcolor')invariant(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value),ERROR_CODES.VALUE,'Expected hexadecimal rich text color');
  else if(name==='font_size')invariant(/^\d{1,3}$/.test(value)&&Number(value)>=1&&Number(value)<=256,ERROR_CODES.VALUE,'Invalid rich text font size');
  else if(name==='url'||name==='hint')invariant(value.length>0&&value.length<=256&&!/[\[\]\x00-\x1f]/.test(value),ERROR_CODES.VALUE,'Invalid rich text metadata');
  else invariant(parts.length===0,ERROR_CODES.VALUE,'Unexpected rich text tag arguments');
  if(stack.at(-1)==='table')invariant(name==='cell',ERROR_CODES.VALUE,'Only cells may be direct table children');
  stack.push(name!);invariant(stack.length<=32,ERROR_CODES.VALUE,'Rich text nesting exceeds 32');
 }
 invariant(stack.length===0,ERROR_CODES.VALUE,'Unclosed rich text tags');
}
export function normalizeRangeValue(value:number,min:number,max:number,step:number,page=0,rounded=false,allowGreater=false,allowLesser=false):number {
 if(step>0)value=Number((Math.floor(Number(((value-min)/step).toPrecision(14))+.5)*step+min).toPrecision(14));
 if(rounded)value=Math.sign(value)*Math.floor(Math.abs(value)+.5);
 if(!allowGreater)value=Math.min(value,max-page);
 if(!allowLesser)value=Math.max(value,min);
 return Object.is(value,-0)?0:value;
}
