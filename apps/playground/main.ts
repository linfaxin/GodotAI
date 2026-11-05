import { PreviewRunner } from '../../scripts/jsb.react-browser/src/runner.js';
import { loadRuntimeRelease } from '../../scripts/jsb.react-browser/src/release.js';
import { canonicalPath } from '../../scripts/jsb.react-browser/src/snapshot.js';
import type { BrowserProjectConfig, RuntimeRelease, BuildArtifact } from '../../scripts/jsb.react-browser/src/contracts.js';
import type { TypeDiagnostic } from '../../scripts/jsb.react-browser/src/typecheck.js';
import { createExample } from './examples.js';
import { parseEditorProject, type EditorProject } from '../../scripts/jsb.react-browser/src/project-document.js';
import { createWorkbench } from './workbench.js';
import { createExplorer } from './explorer.js';
import { createCodeEditor } from './code-editor.js';
import { createFileMenu } from './file-menu.js';
import { useBuiltInDependencies, assertEditableFile } from './project-builtins.js';
import { BUILTIN_PACKAGES } from './builtin-catalog.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const editor = createCodeEditor({
  changed(path, value) { project.files[path] = value; changed(); },
  position(line, column) { $('position').textContent = `Ln ${line}, Col ${column}`; },
  query: languageQuery, run: () => { void run().catch(() => {}); }, toggleFiles: () => workbench.toggleFiles(),
});
type Project = EditorProject;
function example(name = 'starter'): Project { return useBuiltInDependencies(createExample(name)); }
let project = example(), revision = 1, release: RuntimeRelease, releaseUrl = '', runner: PreviewRunner | undefined;
let requestSerial = 0, initialized = false, latestCheck = 0, runSerial = 0, reconfiguring = 0, debounce: ReturnType<typeof setTimeout> | undefined;
let checkedRevision = -1, pendingCheck: { revision: number; promise: Promise<any> } | undefined;
let appConfig: { releaseUrl: string; expectedReleaseId?: string; expectedDescriptorSha256?: string; previewUrl: string; previewLoginUrl?: string; allowSameOriginPreview?: boolean };
const worker = new Worker('./compiler-worker.js', { type: 'module' });
const requests = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();
const state = { ready: false, revision, events: [] as any[], runs: [] as any[], diagnostics: [] as TypeDiagnostic[], errors: [] as string[], lastArtifact: undefined as BuildArtifact | undefined, release: undefined as RuntimeRelease | undefined };
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
function status(message: string) { $('status').textContent = message; }
function previewNotice(title: string, detail: string, kind: 'idle' | 'loading' | 'error' = 'idle') {
  const panel = $('preview-placeholder'); panel.hidden = false; panel.dataset.kind = kind;
  panel.querySelector('h1')!.textContent = title;
  panel.querySelector('p')!.textContent = detail.slice(0, 500);
  panel.querySelector('.hint')!.textContent = kind === 'error' ? '详细错误见下方控制台。修复后点击「运行」重试。' : kind === 'loading' ? '首次加载需要下载编译器与引擎，请稍候。' : '点击「运行」，或按 Ctrl / ⌘ + Enter';
  const login = $<HTMLAnchorElement>('preview-login');
  login.hidden = !(kind === 'error' && appConfig?.previewLoginUrl && /handshaking|loading-frame|\b401\b/.test(detail));
  if (!login.hidden) { login.href = appConfig.previewLoginUrl!; panel.querySelector('.hint')!.textContent = '独立预览站点可能需要登录。请在新标签页登录后，返回这里重新运行。'; }
}
const workbench = createWorkbench({ selectFile: path => selectFile(path), focusEditor: () => editor.focus(), toast });
const fileMenu = createFileMenu({ select: selectFile, rename: renameFile, remove: deleteFile, canDelete: path => path !== project.config.entry && Object.keys(project.files).length > 1, toast });
const explorer = createExplorer(path => { workbench.filePicked(); selectFile(path); editor.focus(); }, (path, x, y) => fileMenu.open(path, x, y));
let logCount = 0;
function log(message: string, level = 'log') {
  if (!logCount) $('logs').replaceChildren();
  const line = document.createElement('div'); line.className = 'log-line ' + level; line.textContent = message.slice(0, 4096); $('logs').append(line);
  if (++logCount > 1000) $('logs').firstElementChild?.remove();
  $('log-count').textContent = String(logCount); workbench.logAdded(level);
}
function rpc(kind: string, payload: object = {}): Promise<any> {
  return new Promise((resolve, reject) => { const id = ++requestSerial; requests.set(id, { resolve, reject }); worker.postMessage({ id, kind, ...payload }); });
}
const stageNames: Record<string, string> = { 'loading-runtime': '加载编译器与类型声明', resolving: '准备内置模块', checking: '检查 TypeScript', bundling: '编译项目', packing: '组装运行项目', 'loading-frame': '创建预览', handshaking: '连接预览', downloading: '校验引擎', preloading: '装载项目', initializing: '初始化引擎', starting: '启动场景', 'waiting-ready': '等待引擎', running: '运行中', stopping: '关闭预览', exited: '已停止' };
worker.onmessage = ({ data }) => {
  if (data.type === 'progress') { const detail = (stageNames[data.stage] ?? data.stage) + (data.total ? ` ${data.loaded}/${data.total}` : '…'); if (!initialized || $('run').hasAttribute('disabled')) status(detail); if (!initialized) previewNotice('正在准备运行环境', detail, 'loading'); return; }
  if (data.type === 'initialized') { state.release = data.release; return; }
  const pending = requests.get(data.id); if (!pending) return;
  requests.delete(data.id); data.ok ? pending.resolve(data.result) : pending.reject(Object.assign(Error(data.error?.message ?? 'Worker failed'), { diagnostics: data.error?.diagnostics }));
};
worker.onerror = event => { for (const pending of requests.values()) pending.reject(Error(event.message)); requests.clear(); status('编译器已停止'); state.errors.push(event.message); log(event.message, 'error'); };
const dbPromise = new Promise<IDBDatabase | undefined>(resolve => {
  if (!globalThis.indexedDB) { resolve(undefined); return; }
  const request = indexedDB.open('godotjs-playground-v1', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('projects');
  request.onsuccess = () => resolve(request.result); request.onerror = () => resolve(undefined);
});
async function save() { const db = await dbPromise; if (!db) return; const transaction = db.transaction('projects', 'readwrite'); transaction.objectStore('projects').put(structuredClone(project), 'current'); transaction.oncomplete = () => { $('saved').textContent = '已自动保存'; }; }
async function restore() {
  const db = await dbPromise; if (!db) return;
  await new Promise<void>(resolve => { const request = db.transaction('projects').objectStore('projects').get('current'); request.onsuccess = async () => { try { if (request.result?.config?.schemaVersion === 1) project = useBuiltInDependencies(await parseEditorProject(request.result)); } catch { toast('本地项目格式无效，已保留默认项目'); } finally { resolve(); } }; request.onerror = () => resolve(); });
}
function filesForWorker() { return Object.entries(project.files).map(([path, contents]) => [path, typeof contents === 'string' ? contents : new Uint8Array(contents)]); }
function renderDependencies() {
  const list = $('dependencies'); list.replaceChildren();
  for (const [name, version] of Object.entries(BUILTIN_PACKAGES)) {
    const item = document.createElement('div'); item.className = 'dependency-item'; item.title = '随站点提供，可直接 import，版本不可编辑';
    const label = document.createElement('span'); label.textContent = name; label.title = name;
    const value = document.createElement('code'); value.textContent = version; item.append(label, value); list.append(item);
  }
}
function projectPayload() { return { revision: String(revision), files: filesForWorker(), config: { ...project.config, dependencies: { ...BUILTIN_PACKAGES }, runtimeRelease: release.id } }; }
function changed() { state.revision = ++revision; $('saved').textContent = '正在保存'; void save(); clearTimeout(debounce); if (initialized) debounce = setTimeout(() => { void check().catch(() => {}); }, 1200); }
function renderFiles() {
  fileMenu.close(); editor.reconcile(Object.keys(project.files));
  explorer.render(Object.keys(project.files), project.selected);
  workbench.syncFiles(Object.keys(project.files), project.selected);
}
$<HTMLInputElement>('file-search').oninput = renderFiles;
function selectFile(path: string) {
  if (!Object.hasOwn(project.files, path)) return;
  project.selected = path; editor.show(path, project.files[path]); editor.diagnostics(state.diagnostics);
  renderFiles();
}
function renderProject() { renderDependencies(); $<HTMLSelectElement>('mode').value = project.config.mode; $<HTMLSelectElement>('profile').value = project.config.profileId; selectFile(Object.hasOwn(project.files, project.selected) ? project.selected : Object.keys(project.files)[0]); }
function diagnostics(items: TypeDiagnostic[], reveal = false) {
  editor.diagnostics(items);
  state.diagnostics = items; $('problem-count').textContent = String(items.length); $('diagnostics').replaceChildren();
  $('type-status').textContent = items.length ? `${items.length} 个问题` : '类型检查通过';
  if (!items.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '没有发现问题'; $('diagnostics').append(empty); }
  for (const item of items.slice(0, 100)) {
    const button = document.createElement('button'); button.className = 'diagnostic'; button.textContent = `${item.file?.replace(/^\//, '') ?? item.stage}${item.line ? ':' + item.line + ':' + (item.column ?? 1) : ''} · ${item.message}`;
    button.onclick = () => { if (item.file && item.file in project.files) { workbench.filePicked(); selectFile(item.file); const model = editor.instance.getModel(); if (model) editor.reveal(item.start ?? model.getOffsetAt({ lineNumber: item.line ?? 1, column: item.column ?? 1 }), item.length ?? 0); } };
    $('diagnostics').append(button);
  }
  if (reveal && items.length) workbench.showProblems();
}
async function check() {
  clearTimeout(debounce);
  if (!initialized) return;
  if (pendingCheck?.revision === revision) return pendingCheck.promise;
  const serial = ++latestCheck, rev = revision; $('type-status').textContent = '正在检查…';
  const promise = (async () => {
    try { const result = await rpc('check', projectPayload()); if (serial !== latestCheck || rev !== revision) return; checkedRevision = rev; delete project.lock; diagnostics(result.diagnostics); await save(); return result; }
    catch (error: any) { if (serial === latestCheck && rev === revision) { diagnostics(error.diagnostics ?? [{ stage: 'types', code: 'E_CHECK', category: 'error', message: String(error) }]); } throw error; }
  })();
  pendingCheck = { revision: rev, promise };
  try { return await promise; } finally { if (pendingCheck?.promise === promise) pendingCheck = undefined; }
}
async function languageQuery(kind: 'completion' | 'hover', file: string, offset: number): Promise<unknown> {
  if (!initialized || reconfiguring || $('run').hasAttribute('disabled')) return kind === 'completion' ? [] : null;
  const rev = revision;
  if (checkedRevision !== rev) await check();
  if (rev !== revision || file !== project.selected || checkedRevision !== rev) return kind === 'completion' ? [] : null;
  const result = await rpc(kind, { file, offset });
  return rev === revision && file === project.selected ? result : kind === 'completion' ? [] : null;
}
function engineRelease() {
  const preview = new URL(appConfig.previewUrl, location.href);
  const asset = (kind: string) => { const file = release.files.find(file => file.kind === kind); if (!file) throw Error(`Missing ${kind}`); const url = new URL(file.url ?? file.path, releaseUrl); if (url.origin === location.origin && preview.origin !== location.origin) { url.protocol = preview.protocol; url.host = preview.host; } return { url: url.href, sha256: file.sha256, ...(file.encoding ? { encoding: file.encoding, decodedSha256: file.decodedSha256, decodedBytes: file.decodedBytes } : {}) }; };
  return { releaseId: release.id, profile: project.config.profileId, releaseCertified: release.certified, engineJs: asset('engine-js'), engineWasm: asset('engine-wasm') };
}
function makeRunner() {
  if (runner) return runner;
  runner = new PreviewRunner({ container: $('preview'), previewUrl: new URL(appConfig.previewUrl, location.href).href, release: engineRelease() });
  runner.subscribe(event => {
    const identity = event.type === 'exit' ? event.report : event;
    const record = state.runs.find(run => run.runId === identity.runId) ?? [...state.runs].reverse().find(run => !run.runId && run.generation === identity.generation && run.buildKey === identity.buildKey);
    if (record) record.runId = identity.runId;
    state.events.push(event); if (state.events.length > 4000) state.events.shift();
    if (event.type === 'log') { log(event.text, event.level); record?.logs.push(event); }
    else if (event.type === 'state') { status(stageNames[event.state] ?? event.state); $('run-dot').style.background = event.state === 'running' ? 'var(--mint)' : '#b6a270'; if (event.state === 'running') $('preview-placeholder').hidden = true; else if (!['idle', 'exited', 'stopping'].includes(event.state)) previewNotice('正在启动 Godot 预览', stageNames[event.state] ?? event.state, 'loading'); }
    else if (event.type === 'exit') { if (record) record.exit = event.report; log(`Preview ${event.report.reason}${event.report.code === undefined ? '' : ' (' + event.report.code + ')'}`, event.report.reason === 'clean-exit' ? 'log' : 'warn'); $('stop').setAttribute('disabled', ''); if (!$('run').hasAttribute('disabled')) workbench.setReady(); if (!$('preview').querySelector('iframe')) previewNotice(event.report.reason === 'clean-exit' ? '预览已停止' : '预览启动或运行失败', event.report.detail ?? '可以修改项目后重新运行。', event.report.reason === 'clean-exit' ? 'idle' : 'error'); }
  });
  return runner;
}
async function runArtifact(artifact = state.lastArtifact, expectedSerial?: number) {
  if (reconfiguring) throw Error('E_PROJECT_CHANGING');
  if (!artifact) throw Error('E_NO_ARTIFACT');
  const serial = expectedSerial ?? ++runSerial;
  if (serial !== runSerial) throw new DOMException('Superseded', 'AbortError');
  workbench.runStarted();
  const active = makeRunner();
  state.runs.push({ generation: artifact.generation, buildKey: artifact.buildKey, logs: [] });
  previewNotice('正在启动 Godot 预览', '正在创建独立预览窗口…', 'loading');
  const result = await active.run(artifact);
  if (serial !== runSerial) throw new DOMException('Superseded', 'AbortError');
  $('preview-placeholder').hidden = true; $('stop').removeAttribute('disabled'); workbench.setReady(); return result;
}
async function run() {
  if (!initialized) throw Error('E_COMPILER_NOT_READY');
  if (reconfiguring) throw Error('E_PROJECT_CHANGING');
  clearTimeout(debounce); ++latestCheck; pendingCheck = undefined; checkedRevision = -1;
  const rev = revision, serial = ++runSerial, started = performance.now(); $('run').setAttribute('disabled', ''); workbench.setBuilding();
  try {
    const artifact: BuildArtifact = await rpc('build', projectPayload());
    if (serial !== runSerial) throw new DOMException('Superseded', 'AbortError');
    if (rev !== revision) throw Error('E_STALE_BUILD: project changed while building');
    state.lastArtifact = artifact; checkedRevision = rev; diagnostics([]); void save();
    $('build-info').textContent = `${Math.round(performance.now() - started)} ms · ${(artifact.pack.byteLength / 1024).toFixed(0)} KB`;
    const result = await runArtifact(artifact, serial); status('运行中'); return result;
  } catch (error: any) { if (serial !== runSerial) throw new DOMException('Superseded', 'AbortError'); state.errors.push(String(error)); if (error.diagnostics) diagnostics(error.diagnostics); status('运行失败 · 查看问题与控制台'); if (!$('preview').querySelector('iframe')) previewNotice('项目未能运行', String(error), 'error'); log(String(error), 'error'); if (error.diagnostics?.length) workbench.showProblems(); throw error; }
  finally { if (serial === runSerial) { $('run').removeAttribute('disabled'); workbench.setReady(); if (!$('preview').querySelector('iframe')) $('stop').setAttribute('disabled', ''); } }
}
async function stop() { ++runSerial; ++latestCheck; pendingCheck = undefined; checkedRevision = -1; worker.postMessage({ kind: 'cancel' }); clearTimeout(debounce); if (initialized && !reconfiguring) $('run').removeAttribute('disabled'); $('stop').setAttribute('disabled', ''); if (initialized) workbench.setReady(); status('已停止'); return runner?.stop(); }
async function reconfigure(apply: () => void) {
  ++reconfiguring; $('run').setAttribute('disabled', '');
  try { await stop(); await runner?.dispose(); runner = undefined; apply(); }
  finally { if (!--reconfiguring && initialized) $('run').removeAttribute('disabled'); }
}
async function setProject(value: Project) {
  const validated = useBuiltInDependencies(await parseEditorProject(value));
  await reconfigure(() => { workbench.resetTabs(); explorer.reset(); editor.reset(); project = validated; renderProject(); diagnostics([]); changed(); });
  if (initialized) await run().catch(() => {});
}
function download(name: string, value: unknown) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
document.addEventListener('keydown', event => { if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void run().catch(() => {}); } });
$('run').onclick = () => { void run().catch(() => {}); }; $('stop').onclick = () => { void stop(); }; $('check').onclick = () => { workbench.showProblems(); void check().catch(() => {}); };
$('clear-log').onclick = () => { $('logs').replaceChildren(); const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '控制台已清空'; $('logs').append(empty); logCount = 0; $('log-count').textContent = '0'; workbench.clearLogs(); };
let renameFrom: string | undefined;
$('new-file').onclick = () => { renameFrom = undefined; $('submit-file').textContent = '创建'; $('file-form').hidden = !$('file-form').hidden; const input = $<HTMLInputElement>('filename'); input.value = ''; input.focus(); };
$('file-form').onsubmit = event => { event.preventDefault(); try {
  const path = canonicalPath($<HTMLInputElement>('filename').value), old = renameFrom; assertEditableFile(path);
  if (path !== old && path in project.files) throw Error('文件已存在');
  project.files[path] = old ? project.files[old] : '';
  if (old && path !== old) {
    delete project.files[old]; if (project.config.entry === old) project.config.entry = path;
    for (const entry of Object.values(project.config.entries ?? {})) if (entry.module === old) entry.module = path;
    for (const asset of Object.values(project.config.assets ?? {})) if (asset.source === old) asset.source = path;
    workbench.renameFile(old, path);
    editor.rename(old, path);
  }
  renameFrom = undefined; selectFile(path); $('file-form').hidden = true; changed();
} catch (error) { toast(String(error)); } };
function renameFile(path: string) { selectFile(path); renameFrom = path; $('submit-file').textContent = '重命名'; $('file-form').hidden = false; const input = $<HTMLInputElement>('filename'); input.value = path; input.focus(); }
function deleteFile(path: string) { if (Object.keys(project.files).length < 2 || path === project.config.entry) { toast('入口文件不能删除'); return; } delete project.files[path]; selectFile(project.selected === path ? Object.keys(project.files)[0] : project.selected); changed(); }
$<HTMLSelectElement>('mode').onchange = async event => { const mode = (event.target as HTMLSelectElement).value as 'development' | 'production'; await reconfigure(() => { project.config.mode = mode; changed(); }); };
$<HTMLSelectElement>('profile').onchange = async event => { const profileId = (event.target as HTMLSelectElement).value; await reconfigure(() => { project.config.profileId = profileId; changed(); }); };
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-example]')) button.onclick = () => { $<HTMLDetailsElement>('examples-menu').open = false; void setProject(example(button.dataset.example)).catch(error => toast(String(error))); };
$('reset').onclick = () => { void setProject(example()).catch(error => toast(String(error))); };
$('export').onclick = () => download('godotjs-project.json', { schemaVersion: 1, runtimeRelease: release?.id, project });
$('share').onclick = async () => {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, project }));
    if (bytes.byteLength > 1024 * 1024) { toast('项目较大，请使用「导出项目」分享'); return; }
    const packed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const encoded = btoa(Array.from(packed, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (encoded.length > 24000) { toast('项目较大，请使用「导出项目」分享'); return; }
    const url = new URL(location.href); url.hash = 'project=' + encoded; history.replaceState(null, '', url.href);
    try { await navigator.clipboard.writeText(url.href); toast('分享链接已复制'); } catch { toast('分享链接已生成，可复制地址栏'); }
  } catch (error) { toast(String(error)); }
};
$<HTMLInputElement>('import').onchange = async event => { const input = event.target as HTMLInputElement; try { const file = input.files?.[0]; if (!file) return; if (file.size > 24 * 1024 * 1024) throw Error('项目文件过大'); const document = JSON.parse(await file.text()); if (document.schemaVersion !== 1 || !document.project) throw Error('无效项目文件'); await setProject(document.project); toast('项目已导入'); } catch (error) { toast(String(error)); } finally { input.value = ''; } };
$<HTMLInputElement>('asset-import').onchange = async event => {
  const input = event.target as HTMLInputElement;
  try {
    for (const file of input.files ?? []) {
      if (file.size > 8 * 1024 * 1024) throw Error('资源大于 8 MB');
      const path = canonicalPath('/assets/' + file.name); assertEditableFile(path); const bytes = new Uint8Array(await file.arrayBuffer());
      const id = file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]/gi, '_');
      let type = 'Texture2D';
      if (/\.tres$/i.test(file.name)) {
        type = new TextDecoder().decode(bytes.subarray(0, 1024)).match(/^\s*\[gd_resource\s+type="([A-Za-z0-9]+)"/)?.[1] ?? '';
        if (!['Resource', 'CanvasItemMaterial', 'CircleShape2D', 'RectangleShape2D', 'CapsuleShape2D'].includes(type)) throw Error('不支持此资源类型');
      }
      project.files[path] = Array.from(bytes); project.config.assets ??= {}; project.config.assets[id] = { source: path, type };
      toast(`资源 ${id} 已加入，使用 asset('${id}', '${type}') 引用`);
    }
  } catch (error) { toast(String(error)); }
  finally { input.value = ''; renderFiles(); changed(); }
};
(window as any).playground = Object.assign(state, { editor: editor.instance, run, runArtifact, stop, check, setFile(path: string, source: string) { path = canonicalPath(path); assertEditableFile(path); project.files[path] = source; if (path === project.selected) selectFile(path); renderFiles(); changed(); }, loadExample: (name: string) => setProject(example(name)), exportProject: () => structuredClone(project), importProject: setProject, setPreviewUrl: (url: string) => reconfigure(() => { appConfig.previewUrl = url; }) });
await restore(); renderProject();
const sharedProject = location.hash.startsWith('#project=');
if (sharedProject) {
  try {
    const value = location.hash.slice(9).replace(/-/g, '+').replace(/_/g, '/');
    if (value.length > 24000) throw Error('分享链接过大');
    const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > 1024 * 1024) throw Error('分享项目过大'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    const expanded = await new Blob(chunks.map(chunk => chunk.slice().buffer)).text();
    const document = JSON.parse(expanded); if (document.schemaVersion !== 1) throw Error('无效分享格式');
    await setProject(document.project); toast('分享项目已载入，检查后点击运行');
  } catch (error) { toast(String(error)); }
}
try {
  appConfig = await (await fetch('./app-config.json')).json();
  releaseUrl = new URL(appConfig.releaseUrl, location.href).href;
  const loaded = await loadRuntimeRelease(releaseUrl, { expectedId: appConfig.expectedReleaseId, expectedDescriptorSha256: appConfig.expectedDescriptorSha256 }); release = loaded.release; state.release = release;
  $('runtime-name').textContent = `Godot ${release.engine.godotVersion.split('.').slice(0, 3).join('.')}`;
  $('runtime-meta').textContent = `${release.engine.engineTarget} · single thread`;
  $<HTMLSelectElement>('profile').replaceChildren(...Object.keys(release.profiles).map(id => { const option = document.createElement('option'); option.value = option.textContent = id; return option; }));
  $<HTMLSelectElement>('profile').value = project.config.profileId;
  const validationScope = (release.certification as { scope?: { browser?: string } } | undefined)?.scope?.browser;
  $('release-info').textContent = `Runtime ${release.id.slice(0, 10)}`; $('release-info').title = release.certified ? '已验证' + (validationScope ? ' · ' + validationScope : '') : '开发验证版本';
  await rpc('init', { releaseUrl, expectedId: release.id, expectedDescriptorSha256: appConfig.expectedDescriptorSha256 }); initialized = state.ready = true;
  $('run').removeAttribute('disabled'); workbench.setReady(); status('就绪'); if (sharedProject) { previewNotice('分享项目已就绪', '检查代码后点击「运行」启动场景。'); void check().catch(() => {}); }
  else { void run().catch(() => {}); }
} catch (error) { status('运行环境加载失败'); previewNotice('运行环境加载失败', String(error), 'error'); $('preview-placeholder').querySelector('.hint')!.textContent = '请刷新页面重新加载运行环境。详细原因见下方控制台。'; log(String(error), 'error'); state.errors.push(String(error)); }
