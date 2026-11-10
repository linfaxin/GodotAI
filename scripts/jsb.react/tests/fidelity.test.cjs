const test=require('node:test'),assert=require('node:assert/strict');
const {getHostSchema,validateHostProps,validateValue,canonicalFields}=require('../dist/schema');
const context={profileId:'showcase-v1'};
test('Control clipping, direction, stretch ratio and layout signals inherit to every Control host',()=>{
 for(const type of ['Control','Button','Label','ColorRect','ScrollContainer','TextureButton','HBoxContainer']){const s=getHostSchema(type,'showcase-v1');assert.equal(s.properties.clipContents.defaultValue,type==='ScrollContainer');assert.equal(s.signals.onResized.echo,'suppress');assert.equal(s.signals.onMinimumSizeChanged.nativeName,'minimum_size_changed');assert.doesNotThrow(()=>validateHostProps(type,{layoutDirection:4,clipContents:true,sizeFlagsStretchRatio:2},context));}
 for(const props of [{layoutDirection:5},{layoutDirection:.5},{sizeFlagsStretchRatio:0},{sizeFlagsStretchRatio:1025}])assert.throws(()=>validateHostProps('Control',props,context),/E_PROPERTY_VALUE/);
 assert.throws(()=>validateHostProps('Control',{clipContents:true},{profileId:'core-ui-v1'}),/E_/);
});
test('animation sections are process playback writes with typed query and change events',()=>{
 const s=getHostSchema('AnimationPlayer','showcase-v1');assert.deepEqual(s.commands.playSection.effects,['playback']);assert.equal(s.commands.playSection.phase,'process');assert.equal(s.commands.playSection.arguments.length,6);assert.equal(s.commands.playSectionBackwards.arguments.length,4);assert.deepEqual(s.commands.resetSection.effects,['playback']);assert.equal(s.commands.hasSection.result,'boolean');assert.equal(s.signals.onCurrentAnimationChanged.parameters[0],'stringName');
});
test('camera alignment shares smoothing ownership and depth projection is read-only',()=>{
 const c=getHostSchema('Camera2D','showcase-v1'),c3=getHostSchema('Camera3D','showcase-v1');assert.deepEqual(c.commands.align.effects,['cameraSmoothing']);assert.equal(c.commands.getScreenCenterPosition.result,'vector2');assert.equal(c3.commands.projectPosition.result,'vector3');assert.deepEqual(c3.commands.projectPosition.effects,[]);assert.throws(()=>validateHostProps('Camera2D',{anchorMode:2},context),/E_PROPERTY_VALUE/);
});
test('CPU particle parameter pairs reject inversion and preserve Curve/Gradient resource types',()=>{
 for(const d of [2,3]){const t='CPUParticles'+d+'D',s=getHostSchema(t,'showcase-v1');assert.deepEqual(s.properties.radialAccelCurve.resourceTypes,['Curve']);assert.deepEqual(s.properties.colorInitialRamp.resourceTypes,['Gradient']);for(const key of ['angle','radialAccel','tangentialAccel','orbitVelocity','hueVariation'])assert.throws(()=>validateHostProps(t,{[key+'Min']:1,[key+'Max']:-1},context),/E_PROPERTY_VALUE/);assert.throws(()=>validateHostProps(t,{hueVariationMax:2},context),/E_PROPERTY_VALUE/);}
});
test('navigation search budget cannot disable the native polygon bound',()=>{
 for(const d of [2,3]){const t='NavigationAgent'+d+'D',s=getHostSchema(t,'showcase-v1');assert.equal(s.commands.isTargetReached.phase,'physics');for(const props of [{pathSearchMaxPolygons:0},{pathSearchMaxPolygons:4097},{pathSearchMaxDistance:-1},{pathReturnMaxRadius:Infinity}])assert.throws(()=>validateHostProps(t,props,context),/E_PROPERTY_VALUE/);}
});
test('vertex color arrays are bounded immutable snapshots with polygon cardinality checks',()=>{
 const input=[{r:1,g:0,b:0,a:1}],value=validateValue('colorArray',input);assert.ok(Object.isFrozen(value)&&Object.isFrozen(value[0]));input[0].r=0;assert.equal(value[0].r,1);assert.throws(()=>validateValue('colorArray',Array(257).fill(value[0])),/E_PROPERTY_VALUE/);assert.throws(()=>validateValue('colorArray',[{r:NaN,g:0,b:0,a:1}]),/E_PROPERTY_VALUE/);assert.throws(()=>validateHostProps('Polygon2D',{vertexColors:value},context),/E_PROPERTY_VALUE/);assert.throws(()=>validateHostProps('Line2D',{roundPrecision:65},context),/E_PROPERTY_VALUE/);assert.throws(()=>validateHostProps('Polygon2D',{textureScale:{x:0,y:1}},context),/E_PROPERTY_VALUE/);
});
test('generated gradients and bitmap masks remain distinct resource capabilities',()=>{
 assert.doesNotThrow(()=>validateValue('shaderValue',{kind:'asset',id:'generated',type:'GradientTexture2D'}));assert.ok(getHostSchema('TextureRect','showcase-v1').properties.texture.resourceTypes.includes('GradientTexture2D'));assert.deepEqual(getHostSchema('TextureButton','showcase-v1').properties.textureClickMask.resourceTypes,['BitMap']);assert.throws(()=>validateHostProps('TextureButton',{textureClickMask:{kind:'asset',id:'wrong',type:'Texture2D'}},context),/E_PROPERTY_VALUE/);
});
