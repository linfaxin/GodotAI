/** Map native module stack positions without depending on a browser or Node.
 * The caller supplies the existing project source maps through FileAccess. */
export function mapEngineStack(stack:string,readMap:(file:string)=>string|undefined):string {
  const cache=new Map<string,any>();
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return stack.replace(/(res:\/\/[^\s()@]+\.(?:js|cjs|mjs)):(\d+):(\d+)/g,(original,file:string,lineText:string,columnText:string)=>{
    try{
      let map=cache.get(file);
      if(map===undefined){const raw=readMap(file+'.map');map=raw&&raw.length<=8*1024*1024?JSON.parse(raw):null;cache.set(file,map);}
      if(map?.version!==3||typeof map.mappings!=='string'||!Array.isArray(map.sources))return original;
      const targetLine=Number(lineText)-1,targetColumn=Number(columnText)-1;
      if(targetLine<0||targetColumn<0)return original;
      let source=0,sourceLine=0,sourceColumn=0,selected:{source:number;line:number;column:number}|undefined;
      const rows=map.mappings.split(';');
      for(let row=0;row<=targetLine&&row<rows.length;row++){
        let generated=0;
        for(const segment of rows[row].split(',')){
          if(!segment)continue;
          const values:number[]=[];let value=0,bits=0;
          for(const character of segment){const digit=alphabet.indexOf(character);if(digit<0||bits>30)throw Error('Invalid VLQ');value+=(digit&31)*2**bits;if(digit&32)bits+=5;else{values.push(value&1?-Math.floor(value/2):Math.floor(value/2));value=0;bits=0;}}
          if(bits||!(values.length===1||values.length===4||values.length===5))throw Error('Invalid segment');
          generated+=values[0];
          if(values.length>=4){source+=values[1];sourceLine+=values[2];sourceColumn+=values[3];}
          if(row===targetLine&&generated<=targetColumn)selected=values.length>=4?{source,line:sourceLine,column:sourceColumn}:undefined;
        }
      }
      if(!selected||targetLine>=rows.length||selected.line<0||selected.column<0)return original;
      const name=map.sources[selected.source];if(typeof name!=='string')return original;
      const uri=name.startsWith('res://')?name:(typeof map.sourceRoot==='string'?map.sourceRoot:'')+name;
      return uri+':'+(selected.line+1)+':'+(selected.column+1);
    }catch{return original;}
  });
}
