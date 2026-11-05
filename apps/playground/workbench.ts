import { fileIcon, icon } from './file-icons.js';
type DockTab = 'problems' | 'console';
interface Preferences { sidebar: boolean; ratio: number; dockHeight: number; collapsed: boolean; tab: DockTab; }
const preferenceKey = 'godotjs-workbench-v1';
const defaults: Preferences = { sidebar: true, ratio: 52, dockHeight: 178, collapsed: false, tab: 'console' };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function createWorkbench(options: { selectFile(path: string): void; focusEditor(): void; toast(message: string): void }) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  let saved: Partial<Preferences> = {};
  try { saved = JSON.parse(localStorage.getItem(preferenceKey) ?? '{}') ?? {}; } catch {}
  const prefs: Preferences = {
    sidebar: typeof saved.sidebar === 'boolean' ? saved.sidebar : defaults.sidebar,
    ratio: typeof saved.ratio === 'number' && Number.isFinite(saved.ratio) ? clamp(saved.ratio, 28, 72) : defaults.ratio,
    dockHeight: typeof saved.dockHeight === 'number' && Number.isFinite(saved.dockHeight) ? clamp(saved.dockHeight, 120, 340) : defaults.dockHeight,
    collapsed: typeof saved.collapsed === 'boolean' ? saved.collapsed : defaults.collapsed,
    tab: saved.tab === 'problems' ? 'problems' : 'console',
  };
  const mobile = matchMedia('(max-width: 900px)');
  const stacked = () => mobile.matches && !(innerWidth >= 620 && innerHeight < 560);
  let compact = innerHeight < 560;
  if (compact) prefs.collapsed = true;
  let focused = false, autoscroll = true, tabs: string[] = [], files: string[] = [], selected = '';
  const persist = () => { try { localStorage.setItem(preferenceKey, JSON.stringify(prefs)); } catch {} };
  function syncSidebar() {
    const open = !focused && (mobile.matches ? document.body.classList.contains('sidebar-open') : prefs.sidebar);
    $('open-files').setAttribute('aria-expanded', String(open));
    $('toggle-files').textContent = mobile.matches ? '打开文件面板' : open ? '隐藏文件面板' : '显示文件面板';
    $('sidebar-backdrop').hidden = !mobile.matches || !open;
    $('workspace').inert = mobile.matches && open;
  }
  function sidebar(open = mobile.matches ? !document.body.classList.contains('sidebar-open') : !prefs.sidebar) {
    if (mobile.matches) document.body.classList.toggle('sidebar-open', open);
    else { prefs.sidebar = open; document.body.classList.toggle('sidebar-collapsed', !open); persist(); }
    syncSidebar();
    if (!open && $('sidebar').contains(document.activeElement)) filesTrigger().focus();
  }
  function filesTrigger() { return mobile.matches ? $('open-files') : $<HTMLDetailsElement>('project-menu').querySelector<HTMLElement>('summary')!; }
  function focusPreview(value = !focused) {
    focused = value; document.body.classList.toggle('preview-focus', value);
    $('focus-preview').setAttribute('aria-pressed', String(value));
    $('focus-preview').setAttribute('aria-label', value ? '返回编辑布局' : '专注预览');
    $('focus-preview').title = value ? '返回编辑布局 · Esc' : '专注预览 · Esc 返回';
    if (value && mobile.matches) sidebar(false);
    syncSidebar();
  }
  function toggleSidebar() { if (focused) { focusPreview(false); sidebar(true); } else sidebar(); }
  function dock(tab: DockTab = prefs.tab, expand = false) {
    prefs.tab = tab; if (expand) prefs.collapsed = false;
    document.body.classList.toggle('dock-collapsed', prefs.collapsed);
    for (const name of ['problems', 'console'] as const) {
      $(name + '-tab').setAttribute('aria-selected', String(name === tab));
      $(name + '-tab').tabIndex = name === tab ? 0 : -1;
      $(name + '-panel').hidden = name !== tab;
    }
    $('console-actions').hidden = tab !== 'console';
    $('toggle-dock').setAttribute('aria-expanded', String(!prefs.collapsed));
    $('toggle-dock').setAttribute('aria-label', prefs.collapsed ? '展开底部面板' : '收起底部面板');
    $('toggle-dock').title = prefs.collapsed ? '展开面板' : '收起面板';
    persist();
  }
  function filterLogs() {
    const filter = $<HTMLSelectElement>('log-filter').value;
    $('logs').dataset.filter = filter;
    const lines = [...$('logs').querySelectorAll<HTMLElement>('.log-line')];
    $('no-logs').hidden = !lines.length || lines.some(line => filter === 'all' || line.classList.contains('error') || filter === 'warn' && line.classList.contains('warn'));
  }
  function follow(value: boolean) { autoscroll = value; $('auto-scroll').setAttribute('aria-pressed', String(value)); }
  function logAdded(level: string) {
    filterLogs();
    if (level === 'error') dock('console', true);
    if (autoscroll) { const panel = $('console-panel'); panel.scrollTop = panel.scrollHeight; }
  }
  function resizeVariables() {
    $('panels').style.setProperty('--editor-ratio', prefs.ratio + '%');
    // Stacked panes use fractions to preserve both panels on short screens.
    $('panels').style.setProperty('--stack-ratio', prefs.ratio + 'fr');
    $('panels').style.setProperty('--stack-rest', (100 - prefs.ratio) + 'fr');
    $('workspace').style.setProperty('--dock-height', Math.min(prefs.dockHeight, Math.max(110, innerHeight * .34)) + 'px');
    $('panel-resizer').setAttribute('aria-valuenow', String(Math.round(prefs.ratio)));
    $('panel-resizer').setAttribute('aria-orientation', stacked() ? 'horizontal' : 'vertical');
    $('dock-resizer').setAttribute('aria-valuenow', String(Math.round(prefs.dockHeight)));
  }
  function resizeHandle(id: string, vertical: () => boolean, change: (position: number) => void, nudge: (delta: number) => void, reset: () => void) {
    const handle = $(id); let dragging = false;
    handle.onpointerdown = event => { if (event.button !== 0) return; event.preventDefault(); dragging = true; handle.setPointerCapture(event.pointerId); document.body.classList.add('resizing'); document.body.classList.toggle('resizing-vertical', vertical()); };
    handle.onpointermove = event => { if (dragging) { change(vertical() ? event.clientY : event.clientX); resizeVariables(); } };
    const end = () => { if (!dragging) return; dragging = false; document.body.classList.remove('resizing', 'resizing-vertical'); persist(); };
    handle.onpointerup = end; handle.onpointercancel = end; handle.onlostpointercapture = end;
    handle.ondblclick = () => { reset(); resizeVariables(); persist(); };
    handle.onkeydown = event => {
      const negative = vertical() ? 'ArrowUp' : 'ArrowLeft', positive = vertical() ? 'ArrowDown' : 'ArrowRight';
      if (event.key !== negative && event.key !== positive && event.key !== 'Home') return;
      event.preventDefault(); event.key === 'Home' ? reset() : nudge(event.key === negative ? -1 : 1); resizeVariables(); persist();
    };
  }
  resizeHandle('panel-resizer', stacked, position => { const bounds = $('panels').getBoundingClientRect(); prefs.ratio = clamp(100 * (position - (stacked() ? bounds.top : bounds.left)) / (stacked() ? bounds.height : bounds.width), 28, 72); }, delta => { prefs.ratio = clamp(prefs.ratio + delta * 3, 28, 72); }, () => { prefs.ratio = defaults.ratio; });
  resizeHandle('dock-resizer', () => true, position => { prefs.collapsed = false; dock(); prefs.dockHeight = clamp($('workspace').getBoundingClientRect().bottom - position, 120, Math.min(340, innerHeight * .4)); }, delta => { prefs.dockHeight = clamp(prefs.dockHeight - delta * 20, 120, 340); }, () => { prefs.dockHeight = defaults.dockHeight; });
  function fitCanvas() {
    const bounds = $('preview-body').getBoundingClientRect();
    const width = Math.max(1, Math.floor(Math.min(bounds.width - 28, (bounds.height - 24) * 16 / 9)));
    $('preview').style.setProperty('--canvas-width', width + 'px');
    $('preview').style.setProperty('--canvas-height', Math.max(1, Math.floor(width * 9 / 16)) + 'px');
    $('preview-size').textContent = `${width} × ${Math.floor(width * 9 / 16)}`;
  }
  new ResizeObserver(fitCanvas).observe($('preview-body'));
  function renderTabs() {
    $('tabs').replaceChildren();
    for (const path of tabs) {
      const group = document.createElement('div'); group.className = 'editor-tab' + (path === selected ? ' active' : '');
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(path === selected)); button.tabIndex = path === selected ? 0 : -1; button.title = path;
      const label = document.createElement('span'); label.className = 'tab-name'; label.textContent = path.split('/').at(-1)!; button.append(fileIcon(path), label);
      button.onclick = () => { focusPreview(false); options.selectFile(path); options.focusEditor(); };
      button.onkeydown = event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); const index = (tabs.indexOf(path) + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length; options.selectFile(tabs[index]); $('tabs').querySelector<HTMLElement>('[aria-selected="true"]')?.focus(); };
      const close = document.createElement('button'); close.className = 'icon-button close-tab'; close.append(icon('close')); close.title = '关闭标签页 ' + label.textContent; close.setAttribute('aria-label', close.title); close.disabled = tabs.length === 1;
      close.onclick = () => { const index = tabs.indexOf(path); tabs = tabs.filter(value => value !== path); if (selected === path) options.selectFile(tabs[Math.min(index, tabs.length - 1)] ?? files[0]); else renderTabs(); };
      group.append(button, close); $('tabs').append(group);
    }
    $('file-path').textContent = selected.replace(/^\//, '');
    $('file-path').title = selected;
    $('language-tag').textContent = selected.split('.').at(-1)?.toUpperCase() ?? 'FILE';
    $('tabs').querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  $('open-files').onclick = () => { if (focused) focusPreview(false); sidebar(true); };
  $('toggle-files').onclick = toggleSidebar;
  $('share-menu').onclick = () => $('share').click();
  $('close-sidebar').onclick = () => sidebar(false); $('sidebar-backdrop').onclick = () => sidebar(false);
  $('focus-preview').onclick = () => focusPreview();
  for (const tab of ['problems', 'console'] as const) $(tab + '-tab').onclick = () => { if (prefs.tab === tab && !prefs.collapsed) { prefs.collapsed = true; dock(); } else dock(tab, true); };
  for (const tab of ['problems', 'console'] as const) $(tab + '-tab').onkeydown = event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const target: DockTab = event.key === 'Home' ? 'problems' : event.key === 'End' ? 'console' : tab === 'problems' ? 'console' : 'problems'; dock(target, true); $(target + '-tab').focus(); } };
  $('toggle-dock').onclick = () => { prefs.collapsed = !prefs.collapsed; dock(); };
  $('log-filter').onchange = filterLogs;
  $('auto-scroll').onclick = () => { follow(!autoscroll); if (autoscroll) $('console-panel').scrollTop = $('console-panel').scrollHeight; };
  $('console-panel').onscroll = () => { const panel = $('console-panel'); if (!prefs.collapsed && panel.clientHeight && panel.scrollHeight - panel.scrollTop - panel.clientHeight > 30) follow(false); };
  $('copy-log').onclick = async () => { const text = [...$('logs').querySelectorAll<HTMLElement>('.log-line')].filter(line => getComputedStyle(line).display !== 'none').map(line => line.textContent).join('\n'); try { await navigator.clipboard.writeText(text); options.toast('控制台输出已复制'); } catch { options.toast('无法访问剪贴板，请选择输出后手动复制'); } };
  const dialog = $<HTMLDialogElement>('shortcuts-dialog'); $('shortcuts').onclick = () => dialog.showModal(); $('close-shortcuts').onclick = () => dialog.close(); dialog.onclick = event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } };
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); toggleSidebar(); }
    if (event.key === 'Escape' && !dialog.open) {
      for (const id of ['project-menu', 'examples-menu']) { const menu = $<HTMLDetailsElement>(id); if (menu.open) { menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus(); return; } }
      if (!$('file-form').hidden) { $('file-form').hidden = true; $('new-file').focus(); return; }
      if (focused) focusPreview(false); else if (mobile.matches) sidebar(false);
    }
  });
  window.addEventListener('message', event => {
    const frame = $('preview').querySelector('iframe');
    if (frame && event.source === frame.contentWindow && event.origin === new URL(frame.src).origin && event.data?.type === 'godotjs-preview-escape' && event.data.protocolVersion === 1) focusPreview(false);
  });
  document.addEventListener('click', event => { for (const id of ['project-menu', 'examples-menu']) { const menu = $<HTMLDetailsElement>(id); if (!menu.contains(event.target as Node) || (event.target as HTMLElement).closest('.menu-popover button,.menu-item')) menu.open = false; } });
  for (const id of ['examples-menu', 'project-menu']) {
    const menu = $<HTMLDetailsElement>(id);
    menu.addEventListener('keydown', event => { if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); menu.open = true; const buttons = [...menu.querySelectorAll<HTMLElement>('[data-example],.menu-popover button,.menu-item')].filter(button => button.getClientRects().length && !button.hasAttribute('disabled')); const index = buttons.indexOf(document.activeElement as HTMLElement); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index < 0 ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0) : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus(); });
    document.addEventListener('focusin', event => { if (menu.open && !menu.contains(event.target as Node)) menu.open = false; });
  }
  for (const label of document.querySelectorAll<HTMLElement>('label[tabindex="0"]')) label.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); label.querySelector<HTMLInputElement>('input')?.click(); } };
  mobile.addEventListener('change', () => { document.body.classList.remove('sidebar-open'); document.body.classList.toggle('sidebar-collapsed', !prefs.sidebar); resizeVariables(); syncSidebar(); });
  window.addEventListener('resize', () => { const next = innerHeight < 560; if (next && !compact) { prefs.collapsed = true; dock(); } compact = next; resizeVariables(); });
  document.body.classList.toggle('sidebar-collapsed', !prefs.sidebar); syncSidebar();
  resizeVariables(); dock();
  return {
    toggleFiles: toggleSidebar,
    syncFiles(paths: string[], active: string) { files = paths; selected = active; tabs = tabs.filter(path => paths.includes(path)); if (active && !tabs.includes(active)) tabs.push(active); $('file-count').textContent = String(paths.length); renderTabs(); },
    resetTabs() { tabs = []; $<HTMLInputElement>('file-search').value = ''; focusPreview(false); if (mobile.matches) sidebar(false); },
    renameFile(old: string, path: string) { tabs = tabs.map(value => value === old ? path : value); },
    filePicked() { focusPreview(false); if (mobile.matches) sidebar(false); },
    runStarted() { if (mobile.matches) focusPreview(true); },
    logAdded,
    clearLogs() { $('no-logs').hidden = true; },
    showProblems() { dock('problems', true); focusPreview(false); },
    showConsole() { dock('console', true); },
    setReady() { $('run-label').textContent = $('preview').querySelector('iframe') ? '重新运行' : '运行'; $('run').setAttribute('aria-busy', 'false'); },
    setBuilding() { $('run-label').textContent = '构建中'; $('run').setAttribute('aria-busy', 'true'); $('stop').removeAttribute('disabled'); },
  };
}
