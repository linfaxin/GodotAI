declare module 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js' {
  import type { languages } from 'monaco-editor/esm/vs/editor/editor.api.js';
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}

declare module 'playground:builtins' {
  import type { BuiltInLibraries } from '../../scripts/jsb.react-browser/src/builtins.js';
  export const libraries: BuiltInLibraries;
}
declare module '*.txt' {
  const source: string;
  export default source;
}

