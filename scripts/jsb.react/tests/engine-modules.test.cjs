const test=require('node:test');
const assert=require('node:assert/strict');
const pkg=require('../package.json');
const {ENGINE_SDK_MODULES,engineModuleDeclaration}=require('../engine-modules.cjs');
test('every public SDK subpath has an explicit runtime and declaration contract',()=>{
 for(const name of Object.keys(pkg.exports)){
  const specifier='@godot-js/react'+(name==='.'?'':name.slice(1));
  assert(ENGINE_SDK_MODULES[specifier],specifier);
  assert.equal(engineModuleDeclaration(specifier,'react'),ENGINE_SDK_MODULES[specifier].declaration);
 }
 assert.equal(engineModuleDeclaration('@godot-js/react','react'),'/engine-sdk/engine.d.ts');
 assert.equal(engineModuleDeclaration('unknown-module','react'),undefined);
});
