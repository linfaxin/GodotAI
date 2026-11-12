const G=require('godot'),J=require('godot-jsb'),config=require('res://text-config.js');
const names=J.internal.names,type=n=>G[names.get_class(n)],call=(o,n,...a)=>o[names.get_member(n)](...a);
const get=(o,n)=>call(o,'get',n),set=(o,n,v)=>call(o,'set',n,v),make=n=>new(type(n))(),v2=(x,y)=>new(type('Vector2'))(x,y);
const check=(v,m)=>{if(!v)throw Error(m);},marker='GODOTJS_BASIC_TEXT';
exports.default=class BasicText extends type('Node2D'){
 _ready(){
  this.frames=0;this.checks={};this.observations={};
  try{
   const server=call(type('TextServerManager'),'get_primary_interface');
   this.observations.textServer={name:call(server,'get_name'),features:Number(call(server,'get_features')),bidi:call(server,'has_feature',2),shaping:call(server,'has_feature',8)};
   if(config.expectFallback){check(/Fallback/.test(this.observations.textServer.name),'Fallback must be the actual primary text interface');check(!this.observations.textServer.bidi&&!this.observations.textServer.shaping,'Advanced shaping/BiDi must be absent');}
   this.checks.primaryTextInterface=true;
   this.font=make('FontFile');set(this.font,'data',call(type('FileAccess'),'get_file_as_bytes','res://text-font.otf'));
   for(const character of '中文测试，开始输入第一行！Hello123')check(call(this.font,'has_char',character.codePointAt(0)),'Missing test glyph '+character);
   this.checks.fontCoverage=true;
   const control=(name,x,y,w,h)=>{const n=make(name);set(n,'position',v2(x,y));set(n,'size',v2(w,h));call(n,'add_theme_font_override','font',this.font);call(n,'add_theme_font_size_override','font_size',20);call(this,'add_child',n);return n;};
   this.label=control('Label',12,8,580,32);set(this.label,'text','中文测试，Hello 123！');
   this.rich=control('RichTextLabel',12,45,580,34);call(this.rich,'add_theme_font_override','normal_font',this.font);call(this.rich,'add_theme_font_override','bold_font',this.font);call(this.rich,'add_theme_font_size_override','normal_font_size',20);set(this.rich,'bbcode_enabled',true);set(this.rich,'text','[b]中文[/b] [color=yellow]Hello 123[/color]');
   this.cjkLabel=control('Label',430,190,190,32);set(this.cjkLabel,'text','中文测试');
   this.cjkRich=control('RichTextLabel',430,235,190,34);call(this.cjkRich,'add_theme_font_override','normal_font',this.font);call(this.cjkRich,'add_theme_font_override','bold_font',this.font);call(this.cjkRich,'add_theme_font_size_override','normal_font_size',20);set(this.cjkRich,'bbcode_enabled',true);set(this.cjkRich,'text','[b]中文[/b]');
   this.wrap=control('Label',12,85,260,90);set(this.wrap,'autowrap_mode',3);set(this.wrap,'text','中文测试，Hello 123！中文测试，Hello 123！');
   this.line=control('LineEdit',12,190,400,36);set(this.line,'text','开始');
   this.edit=control('TextEdit',12,240,400,100);set(this.edit,'text','中文第一行\nHello 123');
   this.button=control('Button',450,375,170,38);set(this.button,'text','Finish');
   this.pressed=type('Callable').create(()=>{this.textFinishRequested=true;});call(this.button,'connect','pressed',this.pressed);
  }catch(error){this.fail(error);}
 }
 state(){return {line:get(this.line,'text'),lineCaret:get(this.line,'caret_column'),lineSelection:call(this.line,'get_selected_text'),lineFocused:call(this.line,'has_focus'),edit:get(this.edit,'text'),editCaretLine:call(this.edit,'get_caret_line'),editCaretColumn:call(this.edit,'get_caret_column'),editSelection:call(this.edit,'get_selected_text'),editFocused:call(this.edit,'has_focus')};}
 _process(){
  if(this.done)return;
  if(this.finishing){if(++this.cleanupFrames>=10)this.exit();return;}
  if(this.textFinishRequested){this.finish();return;}
  try{
   if(++this.frames===45){
    const image=call(call(call(this,'get_viewport'),'get_texture'),'get_image');
    const count=node=>{const {x:x0,y:y0}=get(node,'position'),{x:w,y:h}=get(node,'size');check(x0>=0&&y0>=0&&x0+w<=call(image,'get_width')&&y0+h<=call(image,'get_height'),'Text probe must remain inside the viewport');let n=0;for(let y=y0;y<y0+h;y+=2)for(let x=x0;x<x0+w;x+=2){const c=call(image,'get_pixel',x,y);if(c.r>.5&&c.g>.5)n++;}return n;};
    this.observations.renderedPixels={label:count(this.label),rich:count(this.rich),cjkLabel:count(this.cjkLabel),cjkRich:count(this.cjkRich)};
    check(this.observations.renderedPixels.label>20&&this.observations.renderedPixels.rich>20,'Mixed plain and rich text must render actual pixels');
    check(this.observations.renderedPixels.cjkLabel>20&&this.observations.renderedPixels.cjkRich>20,'Pure Chinese plain and rich text must render actual pixels');this.checks.nativeTextPixels=true;this.checks.cjkTextPixels=true;
    check(get(this.cjkLabel,'text')==='中文测试'&&call(this.cjkRich,'get_parsed_text')==='中文','CJK probes must contain only Chinese glyphs');
    check(call(this.rich,'get_parsed_text')==='中文 Hello 123','Rich-text markup must preserve its content');this.checks.richText=true;
    this.observations.wrapLines=call(this.wrap,'get_line_count');check(this.observations.wrapLines>=2&&this.observations.wrapLines<=5,'Mixed Chinese/Latin word wrap');this.checks.mixedWordWrap=true;
    const wrapBottom=get(this.wrap,'position').y+Math.max(get(this.wrap,'size').y,call(this.wrap,'get_minimum_size').y),lineTop=get(this.line,'position').y;
    this.observations.layout={wrapBottom,lineTop};check(lineTop>=wrapBottom+8,'Wrapped text must not overlap the input field');this.checks.noTextOverlap=true;
    check(call(this.edit,'get_line_count')===2,'Initial multiline text');this.checks.multiline=true;
    this.textProbeReady=true;console.log(marker+'_READY');
   }
   if(this.textProbeReady&&this.frames%2===0){const state=JSON.stringify(this.state());if(state!==this.lastState){this.lastState=state;console.log(marker+'_STATE '+state);}}
  }catch(error){this.fail(error);}
 }
 finish(){
  if(this.done||this.finishing)return;
  try{
   const state=this.state();check(state.line==='中文123','Browser composition must update native LineEdit');check(state.lineCaret===5,'LineEdit Unicode caret');
   check(state.edit==='输入中文\nHello','Browser composition/newline must update native TextEdit');check(state.editCaretLine===1&&state.editCaretColumn===5,'TextEdit caret position');
   this.checks.browserTextInput=true;this.checks.unicodeCarets=true;this.observations.finalState=state;
   call(this.button,'disconnect','pressed',this.pressed);
   while(call(this,'get_child_count'))call(call(this,'get_child',0),'free');
   check(call(this,'get_child_count')===0,'Native text nodes released');this.checks.nativeCleanup=true;
   for(const key of ['font','label','rich','cjkLabel','cjkRich','wrap','line','edit','button','pressed'])this[key]=null;
   this.finishing=true;this.cleanupFrames=0;
  }catch(error){this.fail(error);}
 }
 fail(error){this.error=String(error.stack||error);this.exit();}
 exit(){if(this.done)return;this.done=true;console.log(marker+' '+JSON.stringify({status:this.error?'failed':'passed',checks:this.checks,observations:this.observations,error:this.error}));call(call(this,'get_tree'),'quit',this.error?1:0);}
};
