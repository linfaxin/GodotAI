const test=require('node:test'),assert=require('node:assert/strict');const {getHostSchema,validateHostProps,validateValue,canonicalFields}=require('../dist/schema');const context={profileId:'showcase-v1'};
test('map readback uses bounded immutable integer coordinates and rectangles',()=>{
 const tile=getHostSchema('TileMapLayer','showcase-v1'),grid=getHostSchema('GridMap','showcase-v1');assert.equal(tile.commands.getUsedRect.result,'rect2i');assert.equal(grid.commands.getUsedCells.result,'vector3iArray');const result=validateValue('rect2i',{position:{x:-3,y:2},size:{x:4,y:5}});assert.ok(Object.isFrozen(result.position));assert.throws(()=>validateValue('rect2i',{position:{x:0,y:0},size:{x:-1,y:1}}),/E_PROPERTY_VALUE/);assert.throws(()=>validateValue('vector3iArray',[{x:1,y:.5,z:2}]),/E_PROPERTY_VALUE/);assert.throws(()=>validateValue('vector3iArray',Array(65537).fill({x:0,y:0,z:0})),/E_PROPERTY_VALUE/);
});
test('Label reveal ratio commands and visible character state have a single ownership group',()=>{
 const label=getHostSchema('Label','showcase-v1');assert.deepEqual(label.commands.setVisibleRatio.effects,['textReveal']);assert.deepEqual(canonicalFields('Label',['visibleCharacters'],undefined,'showcase-v1'),['textReveal']);assert.throws(()=>validateHostProps('Label',{visibleCharacters:3,engineOwned:['textReveal']},context),/E_PROPERTY_OWNER_CONFLICT/);for(const props of [{visibleCharacters:-2},{visibleCharactersBehavior:5},{fontOutlineSize:65},{shadowOffsetX:257}])assert.throws(()=>validateHostProps('Label',props,context),/E_PROPERTY_VALUE/);
});
test('path ratio shares progress ownership and path transform remains intrinsic',()=>{
 for(const d of [2,3]){const type='PathFollow'+d+'D',s=getHostSchema(type,'showcase-v1');assert.deepEqual(s.commands.setProgressRatio.effects,['progress']);assert.throws(()=>validateHostProps(type,{position:d===2?{x:0,y:0}:{x:0,y:0,z:0}},context),/E_PROPERTY_OWNER_CONFLICT/);assert.throws(()=>validateHostProps(type,{hOffset:10001},context),/E_PROPERTY_VALUE/);}
});
test('light and GridMap masks reject fractional bits and invalid render modes',()=>{
 for(const [type,props]of [['ColorRect',{lightMask:0x100000}],['PointLight2D',{itemCullMask:.5}],['DirectionalLight2D',{blendMode:3}],['LightOccluder2D',{occluderLightMask:-1}],['GridMap',{collisionMask:0x100000000}],['GridMap',{cellScale:0}]])assert.throws(()=>validateHostProps(type,props,context),/E_PROPERTY_VALUE/);assert.ok(!getHostSchema('DirectionalLight2D','showcase-v1').properties.texture);
});
