const test=require('node:test'),assert=require('node:assert/strict');
const {validateHostProps,getHostSchema,canonicalFields}=require('../dist/schema');
const context={profileId:'showcase-v1'};
test('AnimatedSprite3D shares native display properties and independent appearance animation',()=>{
 const sprite=getHostSchema('Sprite3D','showcase-v1'),animated=getHostSchema('AnimatedSprite3D','showcase-v1');for(const name of ['modulate','billboard','shaded','doubleSided','noDepthTest','fixedSize'])assert.deepEqual(animated.properties[name],sprite.properties[name]);assert.ok(animated.commands.startAppearanceTween);assert.throws(()=>validateHostProps('AnimatedSprite3D',{modulate:{r:1,g:1,b:1,a:1},engineOwned:['appearance']},context),/E_PROPERTY_OWNER_CONFLICT/);
});
test('Parallax protects native position and bounds repeat cost and automatic scroll ownership',()=>{
 for(const props of [{position:{x:1,y:0}},{initial:{position:{x:1,y:0}}},{autoscroll:{x:1,y:0},scrollOffset:{x:0,y:0}},{repeatTimes:17},{repeatSize:{x:-1,y:0}},{scale:{x:0,y:1}},{limitBegin:{x:10,y:0},limitEnd:{x:0,y:0}}])assert.throws(()=>validateHostProps('Parallax2D',props,context),/E_PROPERTY_(?:VALUE|OWNER_CONFLICT)/);
 assert.doesNotThrow(()=>validateHostProps('Parallax2D',{autoscroll:{x:20,y:0},initial:{scrollOffset:{x:4,y:0}},repeatSize:{x:64,y:0}},context));assert.ok(!getHostSchema('Parallax2D','showcase-v1').commands.setPosition);
});
test('text editing separates selection effects from text writes and leaves indices to bounded native validation',()=>{
 const schema=getHostSchema('LineEdit','showcase-v1');assert.deepEqual(schema.commands.select.effects,['text.selection']);assert.deepEqual(schema.commands.insertTextAtCaret.effects,['text','text.selection']);assert.equal(schema.commands.getCaretColumn.result,'integer');assert.equal(schema.commands.getSelectedText.result,'string');assert.deepEqual(canonicalFields('LineEdit',['text.selection'],undefined,'showcase-v1'),['text.selection']);assert.throws(()=>validateHostProps('LineEdit',{caretBlinkInterval:0},context),/E_PROPERTY_VALUE/);
});
test('GPU ratios and draw order and textured progress margins reject unsupported bounds',()=>{
 for(const [type,props]of [['GPUParticles2D',{amountRatio:1.01}],['GPUParticles3D',{interpToEnd:-1}],['GPUParticles2D',{drawOrder:3}],['TextureProgressBar',{stretchMarginLeft:.5}],['CanvasLayer',{followViewportScale:0}]])assert.throws(()=>validateHostProps(type,props,context),/E_PROPERTY_VALUE/);
});
