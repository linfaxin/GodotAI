const assert = require('node:assert/strict');
const test = require('node:test');
const {createHash} = require('node:crypto');
const React = require('react');
const SDK = require('../dist');
const schema = require('../dist/schema');
const {MockNativePort} = require('../dist/testing');

test('media profile is explicit, hashed and leaves core and physics descriptors unchanged', () => {
  assert.equal(createHash('sha256').update(schema.schemaFingerprintInput('ui-media-v1')).digest('hex'), schema.UI_MEDIA_PROFILE_HASH);
  assert.equal(createHash('sha256').update(schema.schemaFingerprintInput('core-ui-v1')).digest('hex'), schema.CORE_PROFILE_HASH);
  assert.equal(schema.CORE_PROFILE_HASH, '2807c96de6bd7f87174263262ec5c9d1a8f473a1e5620175f2edf179cb58eae5');
  assert.equal(createHash('sha256').update(schema.schemaFingerprintInput('behavior-physics-v1')).digest('hex'), schema.BEHAVIOR_PHYSICS_PROFILE_HASH);
  for (const type of ['PanelContainer','MarginContainer','ScrollContainer','TextureRect','ProgressBar','Sprite2D']) {
    assert.equal(SDK[type], SDK.G[type]);
    assert.throws(() => schema.getHostSchema(type), /E_HOST_UNSUPPORTED/);
    assert.equal(schema.getHostSchema(type, 'ui-media-v1').nativeType, type);
  }
  assert.equal(schema.getProfileSchema('ui-media-v1').profile.features.lineEdit, false);
  assert.throws(() => schema.getHostSchema('CharacterBody2D', 'ui-media-v1'), /E_HOST_UNSUPPORTED/);
});
test('media codecs reject invalid ranges, foreign resources and instance resource bypass', () => {
  const context = {profileId:'ui-media-v1'};
  for (const type of ['Texture2D','ImageTexture','CompressedTexture2D']) {
    const value = schema.validateHostProps('TextureRect', {texture:SDK.asset('image', type)}, context);
    assert.equal(value.controlled.texture.type, type);
  }
  assert.throws(() => schema.validateHostProps('TextureRect', {texture:SDK.asset('shape','CircleShape2D')}, context), /E_PROPERTY_VALUE/);
  assert.throws(() => schema.validateHostProps('TextureRect', {texture:{kind:'asset',id:'x',type:'ImageTexture',scope:'instance'}}, context), /E_PROFILE_UNSUPPORTED/);
  for (const [type, props] of [['MarginContainer',{marginLeft:-1}], ['MarginContainer',{marginTop:1.5}], ['TextureRect',{stretchMode:7}], ['ScrollContainer',{verticalScrollMode:5}], ['ProgressBar',{value:101}], ['ProgressBar',{step:0.01}], ['ProgressBar',{maxValue:200}]]) assert.throws(() => schema.validateHostProps(type, props, context), /E_PROPERTY_VALUE/);
  assert.equal(schema.publicPropertyName('MarginContainer','theme_override_constants/margin_left','ui-media-v1'), 'marginLeft');
  assert.throws(() => schema.validateHostProps('MarginContainer',{marginLeft:4,engineOwned:['layout.margin.left']},context), /E_PROPERTY_OWNER_CONFLICT/);
  const props = schema.validateHostProps('TextureRect',{}, {...context,parentType:'MarginContainer'});
  assert(props.engineOwned.includes('layout.position')); assert(props.engineOwned.includes('layout.size'));
});
test('media controlled values restore initial baselines and suppress native setter echoes', () => {
  const port=new MockNativePort(),container=port.createContainer();
  const root=SDK.createRoot(port,container,{generation:'media',profileId:'ui-media-v1'});
  let change; const events=[];
  function App(){const [controlled,set]=React.useState(true);change=set;return React.createElement(SDK.PanelContainer,{name:'panel'},React.createElement(SDK.MarginContainer,{name:'margin',initial:{marginLeft:4},...(controlled?{marginLeft:8}:{})},React.createElement(SDK.ProgressBar,{name:'progress',initial:{value:20},...(controlled?{value:75.125}:{}),onValueChanged:value=>events.push(value)})));}
  const find=(parent,name)=>port.children(parent).find(key=>port.info(key).name===name);
  try {
    root.render(React.createElement(App));
    const panel=find(container,'panel'),margin=find(panel,'margin'),progress=find(margin,'progress');
    assert.equal(port.read(margin,'theme_override_constants/margin_left'),8);
    assert.equal(port.read(progress,'value'),75.125);
    assert.equal(port.read(progress,'step'),0);
    change(false);root.flush();root.pump();
    assert.equal(port.read(margin,'theme_override_constants/margin_left'),4);
    assert.equal(port.read(progress,'value'),20);
    assert.deepEqual(events,[]);
    port.emit(progress,'value_changed',33);root.pump();assert.deepEqual(events,[33]);
  } finally {root.shutdown();}
  assert.equal(port.liveCount(),1);
});
