'use strict';
// Build tools can read this contract before the TypeScript SDK has been built.
const ENGINE_SDK_MODULES = {
  'react': {exportName:'React',declaration:'/react/index.d.ts',scope:'shared'},
  'react/jsx-runtime': {exportName:'jsxRuntime',declaration:'/react/jsx-runtime.d.ts',scope:'shared'},
  'react/jsx-dev-runtime': {exportName:'jsxDevRuntime',declaration:'/react/jsx-dev-runtime.d.ts',scope:'shared'},
  '@godot-js/react': {exportName:'engineReact',declaration:'/engine-sdk/engine.d.ts',scope:'engine'},
  '@godot-js/react/engine': {exportName:'engineReact',declaration:'/engine-sdk/engine.d.ts',scope:'engine'},
  '@godot-js/react/legacy': {exportName:'legacy',declaration:'/sdk/legacy.d.ts',scope:'legacy'},
  '@godot-js/react/godot': {exportName:'godot',declaration:'/sdk/godot.d.ts',scope:'legacy'},
  '@godot-js/react/scheduler': {exportName:'scheduler',declaration:'/sdk/scheduler.d.ts',scope:'shared'},
  'scheduler': {exportName:'scheduler',declaration:'/sdk/scheduler.d.ts',scope:'shared'},
  '@godot-js/react/contracts': {exportName:'contracts',declaration:'/sdk/contracts/index.d.ts',scope:'shared'},
  '@godot-js/react/schema': {exportName:'schema',declaration:'/sdk/schema/index.d.ts',scope:'legacy'},
  '@godot-js/react/native-interfaces': {exportName:'nativeInterfaces',declaration:'/sdk/native-interfaces.d.ts',scope:'legacy'},
  '@godot-js/react/ui': {exportName:'ui',declaration:'/sdk/ui.d.ts',scope:'legacy'},
  '@godot-js/react/engine-modules': {exportName:'engineModules',declaration:'/sdk/contracts/engine-modules.d.ts',scope:'shared'},
  '@godot-js/react/testing': {exportName:'testing',declaration:'/sdk/testing.d.ts',scope:'testing'},
};
for(const entry of Object.values(ENGINE_SDK_MODULES))Object.freeze(entry);
Object.freeze(ENGINE_SDK_MODULES);
function engineModuleDeclaration(specifier,runtime){
 return ENGINE_SDK_MODULES[specifier]?.declaration;
}
module.exports={ENGINE_SDK_MODULES,engineModuleDeclaration};
