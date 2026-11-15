/** Legacy artifact shim map. Frozen default aliases remain readable; new NativePort
 * CLI sources must import /legacy explicitly. Engine projects use engineReact. */
export const CANONICAL_IMPORTS: Readonly<Record<string, string>> = Object.freeze({
  react: 'React', 'react/jsx-runtime': 'jsxRuntime', 'react/jsx-dev-runtime': 'jsxDevRuntime',
  '@godot-js/react': 'sdk', '@godot-js/react/legacy': 'sdk', '@godot-js/react/godot': 'godot',
  '@godot-js/react/native-interfaces': 'nativeInterfaces', scheduler: 'scheduler',
  '@godot-js/react/scheduler': 'scheduler', '@godot-js/react/contracts': 'contracts',
  '@godot-js/react/schema': 'schema', '@godot-js/react/ui': 'ui',
});
