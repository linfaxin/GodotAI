/** Pinned Godot 4.6.1 audio shutdown repair, shared by source and glue builds. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {audioLifecycleFunctions,sampleLifecycleFunctions,workletLifecycleFunctions,anonymous} from './audio-lifecycle-v2.mjs';
import {audioLayouts} from './audio-lifecycle-layouts.mjs';

export const AUDIO_LIFECYCLE_PATCH='godotjs-audio-lifecycle-v2';
const fail=label=>{throw Error('E_AUDIO_PATCH_UNSUPPORTED: '+label);};
// Structural operations skip strings/comments. Input code is never evaluated.
function skip(code,i){
 const ch=code[i],next=code[i+1];
 if(ch==='/'&&next==='/'){const end=code.indexOf('\n',i+2);return end<0?code.length:end;}
 if(ch==='/'&&next==='*'){const end=code.indexOf('*/',i+2);if(end<0)fail('unterminated comment');return end+2;}
 if(ch==='"'||ch==="'"||ch==='`'){for(let k=i+1;k<code.length;k++){if(code[k]==='\\'){k++;continue;}if(code[k]===ch)return k+1;}fail('unterminated literal');}
 return i;
}
function closing(code,start){let depth=0;for(let i=start;i<code.length;i++){const end=skip(code,i);if(end!==i){i=end-1;continue;}if(code[i]==='{')depth++;else if(code[i]==='}'&&!--depth)return i;}fail('unbalanced braces');}
function canonical(code){
 const tokens=[];for(let i=0;i<code.length;){
  if(/\s/.test(code[i])){if((code[i]==='\n'||code[i]==='\r')&&['return','throw','break','continue','yield'].includes(tokens.at(-1)))tokens.push('<line-terminator>');i++;continue;}const end=skip(code,i);
  if(end!==i){if(code[i]!=='/'){const raw=code.slice(i,end);tokens.push(raw[0]==='`'?raw:'S:'+raw.slice(1,-1).replace(/\\"/g,'"').replace(/\\'/g,"'"));}else if(code.slice(i,end).includes('\n')&&['return','throw','break','continue','yield'].includes(tokens.at(-1)))tokens.push('<line-terminator>');i=end;continue;}
  const match=/^[\w$]+/.exec(code.slice(i));if(match){tokens.push(match[0]);i+=match[0].length;continue;}
  tokens.push(code[i]);i++;
 }
 return tokens.map((token,i)=>token.startsWith('S:')&&/^[\w$]+$/.test(token.slice(2))&&tokens[i+1]===':'?token.slice(2):token).join('|');
}
const digest=code=>createHash('sha256').update(canonical(code)).digest('hex');
function objectRange(code,name){
 const matches=[...code.matchAll(new RegExp('(?:const|var|let)\\s+_?'+name+'\\s*=\\s*\\{','g'))];if(matches.length!==1)fail(name+' declaration');
 let open=code.indexOf('{',matches[0].index),end=closing(code,open);const nested=new RegExp('\\$'+name+'\\s*:\\s*\\{').exec(code.slice(open,end+1));
 if(nested){open=code.indexOf('{',open+nested.index);end=closing(code,open);}return{open,end};
}
function classRange(code,name){const matches=[...code.matchAll(new RegExp('\\bclass\\s+'+name+'\\s*\\{','g'))];if(matches.length!==1)fail(name+' class');const open=code.indexOf('{',matches[0].index);return{open,end:closing(code,open)};}
function methodRange(code,range,name,classMode=false){
 const body=code.slice(range.open+1,range.end),regex=classMode?new RegExp('(?<![.\\w$])(?:async\\s+)?'+name+'\\s*\\([^)]*\\)\\s*\\{','g'):new RegExp('\\b'+name+'\\s*:\\s*(?:async\\s+)?function\\s*\\([^)]*\\)\\s*\\{','g');
 const matches=[...body.matchAll(regex)];if(matches.length!==1)fail(name+' method count '+matches.length);
 const start=range.open+1+matches[0].index,open=start+matches[0][0].lastIndexOf('{');return{start,open,end:closing(code,open)};
}
const targets={
 audio:['init','create_input','close_async','start_sample','set_sample_bus_count','add_sample_bus','move_sample_bus','set_sample_bus_send','set_sample_bus_volume_db','set_sample_bus_solo','set_sample_bus_mute'],
 sample:['constructor','create','connectPositionWorklet','getPositionWorklet','clear','start','restart','pause','setVolumes','getSampleNodeBus','_resetSourceStartTime','_syncPlaybackRate','_restart','_pause','_unpause','_addEndedListener'],
 worklet:['create','start','start_no_threads','get_node','close'],
};
function range(code,kind){return kind==='sample'?classRange(code,'SampleNode'):objectRange(code,kind==='audio'?'GodotAudio':'GodotAudioWorklet');}
function section(code,kind,name){const loc=methodRange(code,range(code,kind),name,kind==='sample');return{...loc,code:code.slice(loc.start,loc.end+1)};}
function replace(code,kind,name,make){const loc=section(code,kind,name),value=make(loc.code,loc);return code.slice(0,loc.start)+value+code.slice(loc.end+1);}
function full(fn,name,classMode=false){const value=anonymous(fn);return classMode?value.replace(/^(async\s+)?function/,'$1'+name):name+': '+value;}
function prepend(body,text){const pattern=/\)\s*\{/;const match=pattern.exec(body);if(!match)fail('method header');const start=match.index+match[0].lastIndexOf('{');return body.slice(0,start+1)+'\n'+text+'\n'+body.slice(start+1);}
function assignStatement(code,pattern,replacement){const match=pattern.exec(code);if(!match)fail('assignment '+pattern);let paren=0,brace=0,bracket=0;
 for(let i=match.index;i<code.length;i++){const end=skip(code,i);if(end!==i){i=end-1;continue;}const c=code[i];if(c==='(')paren++;if(c===')')paren--;if(c==='{')brace++;if(c==='}')brace--;if(c==='[')bracket++;if(c===']')bracket--;if(c===';'&&paren===0&&brace===0&&bracket===0)return code.slice(0,match.index)+replacement+code.slice(i+1);}
 fail('assignment terminator');}
function appendObject(code,kind,values){const loc=range(code,kind);const body=code.slice(loc.open+1,loc.end).trimEnd().replace(/,$/,'');return code.slice(0,loc.open+1)+body+',\n'+Object.entries(values).map(([name,fn])=>full(fn,name)).join(',\n')+',\n'+code.slice(loc.end);}
function apply(code){
 for(const kind of Object.keys(targets))for(const name of targets[kind]){
  const allowed=audioLayouts.before[kind+'.'+name]??[];
  if(!allowed.includes(digest(section(code,kind,name).code)))fail('unknown '+kind+'.'+name+' layout');
 }
 for(const name of targets.sample){
  if(Object.hasOwn(sampleLifecycleFunctions,name))continue;
  code=replace(code,'sample',name,body=>{
   body=body.replace(/GodotAudio\.ctx/g,'this._lifecycleContext');
   if(name==='constructor'){
    body=prepend(body,'this._lifecycleSession = GodotAudio.lifecycle; this._lifecycleContext = GodotAudio.ctx;');
    const pattern=/\.catch\(\s*(?:\(\s*err\s*\)|err)\s*=>\s*\{/;if(!pattern.test(body))fail('sample position catch');
    body=body.replace(pattern,match=>match+'\nif (!this._lifecycleAlive()) return;');
   }else if(name==='create')body=prepend(body,'if (!GodotAudio.lifecycle_active(GodotAudio.lifecycle)) return null;');
   else{
    body=prepend(body,'if (!this._lifecycleAlive() || !this._source) return;');
    if(name==='_addEndedListener'){
     const pattern=/if\s*\(self\.isPaused\)/;if(!pattern.test(body))fail('sample ended callback');body=body.replace(pattern,'if (self.isPaused || !self._lifecycleAlive())');
    }
   }
   return body;
  });
 }
 for(const [name,fn]of Object.entries(sampleLifecycleFunctions)){
  if(name==='_lifecycleAlive'){const loc=range(code,'sample');code=code.slice(0,loc.end)+'\n'+full(fn,name,true)+'\n'+code.slice(loc.end);}
  else code=replace(code,'sample',name,()=>full(fn,name,true));
 }
 code=replace(code,'audio','init',body=>{
  const context=/GodotAudio\.ctx\s*=\s*ctx\s*;/;if(!context.test(body))fail('audio context assignment');
  body=body.replace(context,match=>match+`\nGodotAudio.lifecycle_patch_id = '${AUDIO_LIFECYCLE_PATCH}';\nGodotAudio.lifecycle_sequence = (GodotAudio.lifecycle_sequence || 0) + 1;\nconst lifecycle = {context: ctx, generation: GodotAudio.lifecycle_sequence, retiring: false, closed: false, closePromise: null};\nGodotAudio.lifecycle = lifecycle;`);
  body=body.replace(/ctx\.onstatechange\s*=\s*function\s*\(\)\s*\{/,match=>match+'\nif (!GodotAudio.lifecycle_active(lifecycle)) return;');
  body=body.replace(/GodotAudio\.interval\s*=\s*setInterval\(function\s*\(\)\s*\{/,match=>match+'\nif (!GodotAudio.lifecycle_active(lifecycle)) return;');
  body=body.replace(/GodotAudio\.ctx\.(baseLatency|outputLatency)/g,'ctx.$1');
  return assignStatement(body,/GodotAudio\.audioPositionWorkletPromise\s*=/,'GodotAudio.audioPositionWorkletPromise = ctx.audioWorklet.addModule(path).catch(function (error) { if (!GodotAudio.lifecycle_active(lifecycle)) return; throw error; });');
 });
 code=replace(code,'audio','create_input',body=>{
  body=prepend(body,'const lifecycle = GodotAudio.lifecycle;\nif (!GodotAudio.lifecycle_active(lifecycle)) return 1;');
  body=body.replace(/function\s+gotMediaInput\s*\(stream\)\s*\{/,match=>match+'\nif (!GodotAudio.lifecycle_active(lifecycle)) { for (const track of stream.getTracks()) track.stop(); return; }');
  return body.replace(/GodotAudio\.ctx\.createMediaStreamSource/g,'lifecycle.context.createMediaStreamSource');
 });
 code=replace(code,'audio','close_async',()=>full(audioLifecycleFunctions.close_async,'close_async'));
 for(const name of targets.audio.filter(name=>!['init','create_input','close_async'].includes(name)))code=replace(code,'audio',name,body=>prepend(body,'if (!GodotAudio.lifecycle_active(GodotAudio.lifecycle)) return;'));
 code=appendObject(code,'audio',{lifecycle_active:audioLifecycleFunctions.lifecycle_active,lifecycle_disconnect:audioLifecycleFunctions.lifecycle_disconnect});
 for(const [name,fn]of Object.entries(workletLifecycleFunctions))if(name!=='lifecycle_active')code=replace(code,'worklet',name,()=>full(fn,name));
 code=replace(code,'worklet','start_no_threads',body=>{
  body=prepend(body,'const session = GodotAudioWorklet.session; const pending = GodotAudioWorklet.promise;\nif (!pending || !GodotAudioWorklet.lifecycle_active(session)) return;');
  body=body.replace(/GodotAudioWorklet\.ring_buffer\s*=\s*new RingBuffer\(\)\s*;/,'const ring = new RingBuffer(); session.ring = ring; GodotAudioWorklet.ring_buffer = ring;');
  body=body.replace(/GodotAudioWorklet\.promise\.then\(function\s*\(\)\s*\{\s*const node\s*=\s*GodotAudioWorklet\.worklet\s*;/,'pending.then(function (node) {\nif (!node || !GodotAudioWorklet.lifecycle_active(session)) return;');
  body=body.replace(/if\s*\(!node\s*\|\|\s*!GodotAudio\.ctx\s*\|\|\s*GodotAudioWorklet\.closing\)\s*return\s*;/,'');
  body=body.replace(/GodotAudio\.ctx\.destination/g,'session.context.destination');
  body=body.replace(/if\s*\(!GodotAudioWorklet\.worklet\)/,'if (!GodotAudioWorklet.lifecycle_active(session))');
  body=body.replace(/GodotAudioWorklet\.ring_buffer\.(consumed|receive)/g,'ring.$1').replace(/GodotAudioWorklet\.worklet\.port/g,'node.port');
  const last=body.lastIndexOf('});');if(last<0)fail('start_no_threads continuation');body=body.slice(0,last)+'}, function () { /* create() reports active load errors. */ });'+body.slice(last+3);
  return body;
 });
 return appendObject(code,'worklet',{lifecycle_active:workletLifecycleFunctions.lifecycle_active});
}
function fingerprints(code,after=false){const out={};for(const kind of Object.keys(targets))for(const name of [...targets[kind],...(after&&kind==='audio'?['lifecycle_active','lifecycle_disconnect']:after&&kind==='sample'?['_lifecycleAlive']:after&&kind==='worklet'?['lifecycle_active']:[])])out[kind+'.'+name]=digest(section(code,kind,name).code);return out;}
function verify(code){for(const [name,hash]of Object.entries(fingerprints(code,true)))if(!(audioLayouts.after[name]??[]).includes(hash))fail('modified '+name+' v2 patch');}
export function patchAudioLifecycle(code){
 if(code.includes(AUDIO_LIFECYCLE_PATCH)){verify(code);return{code,changed:false,patchId:AUDIO_LIFECYCLE_PATCH};}
 const patched=apply(code);verify(patched);return{code:patched,changed:true,patchId:AUDIO_LIFECYCLE_PATCH};
}
export function audioLifecycleFingerprints(code,after=false){return fingerprints(code,after);}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const input=process.argv[2];if(!input)throw Error('Usage: node patch-web-audio-lifecycle.mjs <godot.js | library_godot_audio.js> [output]');
 const before=await readFile(input,'utf8'),result=patchAudioLifecycle(before);await writeFile(process.argv[3]??input,result.code);
 console.log(JSON.stringify({patchId:result.patchId,changed:result.changed,beforeSha256:createHash('sha256').update(before).digest('hex'),afterSha256:createHash('sha256').update(result.code).digest('hex')}));
}
