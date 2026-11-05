import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/editor/editor.all.js';
import { conf, language } from 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js';
import type { CompletionDTO, HoverDTO, TypeDiagnostic } from '../../scripts/jsb.react-browser/src/typecheck.js';

interface Options {
  changed(path: string, value: string): void;
  position(line: number, column: number): void;
  query(kind: 'completion' | 'hover', path: string, offset: number): Promise<unknown>;
  run(): void;
  toggleFiles(): void;
}

export function createCodeEditor(options: Options) {
  (globalThis as typeof globalThis & { MonacoEnvironment: { getWorker(): Worker } }).MonacoEnvironment = {
    getWorker: () => new Worker(new URL('./monaco-editor-worker.js', location.href), { type: 'module' }),
  };
  for (const id of ['typescript', 'javascript']) {
    monaco.languages.register({ id });
    monaco.languages.setLanguageConfiguration(id, conf);
    monaco.languages.setMonarchTokensProvider(id, language);
  }
  for (const id of ['json', 'godot-resource']) {
    monaco.languages.register({ id });
    monaco.languages.setMonarchTokensProvider(id, { tokenizer: { root: [
      [/"(?:[^"\\]|\\.)*"/, 'string'], [/\b(?:true|false|null)\b/, 'keyword'],
      [/-?\b\d+(?:\.\d+)?\b/, 'number'], [/\[[^\]\n]*\]/, 'type.identifier'], [/[{}[\]:=,]/, 'delimiter'],
    ] } });
  }
  monaco.editor.defineTheme('godotai-dark', { base: 'vs-dark', inherit: true, rules: [], colors: {
    'editor.background': '#1f1f1f', 'editorGutter.background': '#1f1f1f',
    'editorLineNumber.foreground': '#6e7681', 'editorLineNumber.activeForeground': '#cccccc',
    'editorWidget.background': '#252526', 'editorWidget.border': '#454545', 'focusBorder': '#0078d4',
  } });
  const instance = monaco.editor.create(document.getElementById('source')!, {
    model: null, theme: 'godotai-dark', automaticLayout: true, ariaLabel: '源代码',
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
    fontSize: 12, lineHeight: 22, tabSize: 2, insertSpaces: true,
    minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 9, bottom: 24 },
    lineNumbersMinChars: 3, glyphMargin: false, folding: true, wordWrap: 'off',
    bracketPairColorization: { enabled: true }, renderLineHighlight: 'line',
    // Avoid Monaco 0.55.1's rejected occurrence scheduler on rapid model disposal.
    occurrencesHighlight: 'off',
    fixedOverflowWidgets: true, stickyScroll: { enabled: false }, editContext: false,
    unicodeHighlight: { ambiguousCharacters: false },
  });
  const models = new Map<string, monaco.editor.ITextModel>();
  const views = new Map<string, monaco.editor.ICodeEditorViewState>();
  let suppress = false;
  const languageFor = (path: string) => /\.[cm]?tsx?$/.test(path) ? 'typescript' : /\.[cm]?jsx?$/.test(path) ? 'javascript' : path.endsWith('.json') ? 'json' : path.endsWith('.tres') ? 'godot-resource' : 'plaintext';
  const saveView = () => { const model = instance.getModel(), view = instance.saveViewState(); if (model && view) views.set(model.uri.path, view); };
  instance.onDidChangeModelContent(() => { const model = instance.getModel(); if (!suppress && model) options.changed(model.uri.path, model.getValue()); });
  instance.onDidChangeCursorPosition(event => options.position(event.position.lineNumber, event.position.column));
  instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, options.run);
  instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, options.toggleFiles);
  instance.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.Enter, options.run);
  instance.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyB, options.toggleFiles);
  for (const id of ['typescript', 'javascript']) {
    monaco.languages.registerCompletionItemProvider(id, {
      triggerCharacters: ['.', '<', '"', "'"],
      async provideCompletionItems(model, position, _context, token) {
        const version = model.getVersionId(), offset = model.getOffsetAt(position), word = model.getWordUntilPosition(position);
        try {
          const values = await options.query('completion', model.uri.path, offset) as CompletionDTO[];
          if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return { suggestions: [] };
          return { suggestions: values.map(value => ({ label: value.name, insertText: value.insertText ?? value.name, sortText: value.sortText,
            kind: value.kind === 'function' ? monaco.languages.CompletionItemKind.Function : value.kind === 'property' ? monaco.languages.CompletionItemKind.Property : monaco.languages.CompletionItemKind.Variable,
            range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          })) };
        } catch { return { suggestions: [] }; }
      },
    });
    monaco.languages.registerHoverProvider(id, { async provideHover(model, position, token) {
      const version = model.getVersionId();
      try {
        const value = await options.query('hover', model.uri.path, model.getOffsetAt(position)) as HoverDTO | null;
        if (!value || token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return null;
        const start = model.getPositionAt(value.start), end = model.getPositionAt(value.start + value.length);
        return { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), contents: [
          { value: '```typescript\n' + value.display.replace(/```/g, '') + '\n```' },
          // Documentation is untrusted package text, displayed as plain text.
          { value: value.documentation.replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&'), isTrusted: false, supportHtml: false },
        ] };
      } catch { return null; }
    } });
  }
  function dispose(path: string) { const model = models.get(path); if (instance.getModel() === model) instance.setModel(null); model?.dispose(); models.delete(path); views.delete(path); }
  return {
    instance,
    focus() { if (instance.getModel()) instance.focus(); },
    show(path: string, contents: string | number[]) {
      saveView();
      const binary = typeof contents !== 'string';
      document.getElementById('source')!.hidden = binary; document.getElementById('binary-file')!.hidden = !binary;
      if (binary) { instance.setModel(null); document.getElementById('binary-file')!.textContent = `${path}\n${contents.length.toLocaleString()} bytes · binary asset`; return; }
      let model = models.get(path);
      if (!model) { model = monaco.editor.createModel(contents, languageFor(path), monaco.Uri.from({ scheme: 'file', path })); models.set(path, model); }
      else if (model.getValue() !== contents) { suppress = true; try { model.pushEditOperations([], [{ range: model.getFullModelRange(), text: contents }], () => null); } finally { suppress = false; } }
      const same = instance.getModel() === model; instance.setModel(model);
      if (!same && views.has(path)) instance.restoreViewState(views.get(path)!);
      instance.layout(); const position = instance.getPosition(); if (position) options.position(position.lineNumber, position.column);
    },
    reveal(offset: number, length = 0) { const model = instance.getModel(); if (!model) return; const start = model.getPositionAt(offset), end = model.getPositionAt(offset + length); instance.setSelection(new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column)); instance.revealPositionInCenterIfOutsideViewport(start); instance.focus(); },
    rename(old: string, path: string) { saveView(); const view = views.get(old); dispose(old); if (view) views.set(path, view); },
    reconcile(paths: string[]) { for (const path of models.keys()) if (!paths.includes(path)) dispose(path); },
    reset() { for (const path of models.keys()) dispose(path); },
    diagnostics(values: TypeDiagnostic[]) {
      for (const [path, model] of models) monaco.editor.setModelMarkers(model, 'godotai', values.filter(value => value.file === path).map(value => {
        const start = model.getPositionAt(value.start ?? model.getOffsetAt({ lineNumber: value.line ?? 1, column: value.column ?? 1 }));
        const end = model.getPositionAt((value.start ?? model.getOffsetAt(start)) + Math.max(1, value.length ?? 1));
        return { message: value.message, code: String(value.code), severity: value.category === 'warning' ? monaco.MarkerSeverity.Warning : value.category === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Info,
          startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
      }));
    },
  };
}
