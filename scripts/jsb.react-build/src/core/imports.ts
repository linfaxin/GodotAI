/** One canonical renderer and singleton module registry for CLI generations. */
export const CANONICAL_IMPORTS: Readonly<Record<string, string>> = Object.freeze({
  react: 'React', 'react/jsx-runtime': 'jsxRuntime', 'react/jsx-dev-runtime': 'jsxDevRuntime',
  '@godot-js/react': 'engineReact', '@godot-js/react/engine': 'engineReact',
  '@godot-js/react/engine-components': 'engineComponents',
  '@godot-js/react/engine-native-interfaces': 'engineNativeInterfaces',
  scheduler: 'scheduler', '@godot-js/react/scheduler': 'scheduler',
  '@godot-js/react/contracts': 'contracts', '@godot-js/react/schema': 'schema',
});

/** Explicit read adapter for historical component documents. The source stays
 * untouched and every alias resolves to the current direct renderer facade. */
export const HISTORICAL_REACT_MODULE_ADAPTER = Object.freeze({
 id:'godotjs-historical-react-modules/1',
 apply(input:{moduleDeclarations:Readonly<Record<string,string>>;runtimeModules?:Readonly<Record<string,Uint8Array>>;runtimeImports?:Iterable<string>}) {
  const root='@godot-js/react',facade='@godot-js/react/engine-components';
  const fail=(code:string,message:string):never=>{throw Object.assign(Error(code+': '+message),{code});};
  for(const name of input.runtimeImports??[])if(['@godot-js/react/legacy','@godot-js/react/godot','@godot-js/react/ui','@godot-js/react/native-interfaces'].includes(name))
   fail('E_HISTORICAL_REACT_IMPORT',name+' uses a retained runtime protocol; migrate component helpers to /engine-components and endpoints to /engine-native-interfaces. The original source has been retained.');
  if(!input.moduleDeclarations[facade]||input.runtimeModules&&!input.runtimeModules[facade])fail('E_HISTORICAL_REACT_SDK','The matched SDK must provide the current engine-components facade');
  return {moduleDeclarations:{...input.moduleDeclarations,[root]:input.moduleDeclarations[facade]},
   ...(input.runtimeModules?{runtimeModules:{...input.runtimeModules,[root]:input.runtimeModules[facade]!}}:{})};
 },
});
