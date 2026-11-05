/** One canonical React/SDK instance per Godot realm, shared by both build targets. */
export const CANONICAL_IMPORTS: Readonly<Record<string, string>> = Object.freeze({
  react: 'React', 'react/jsx-runtime': 'jsxRuntime', 'react/jsx-dev-runtime': 'jsxDevRuntime',
  '@godot-js/react': 'sdk', '@godot-js/react/godot': 'godot',
  '@godot-js/react/native-interfaces': 'nativeInterfaces', scheduler: 'scheduler',
  '@godot-js/react/scheduler': 'scheduler', '@godot-js/react/contracts': 'contracts',
  '@godot-js/react/schema': 'schema', '@godot-js/react/ui': 'ui',
});
