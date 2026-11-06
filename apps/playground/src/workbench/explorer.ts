import { fileIcon, icon } from './file-icons.js';

interface Entry { name: string; path: string; children: Map<string, Entry>; file?: boolean; }

/** The explorer owns view state only; collapsing a folder never changes files. */
export function createExplorer(selectFile: (path: string) => void, contextMenu: (path: string, x: number, y: number) => void) {
  const tree = document.getElementById('files')!;
  const search = document.getElementById('file-search') as HTMLInputElement;
  const collapsed = new Set<string>();
  let selected = '';
  const items = () => [...tree.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];
  const visible = () => items().filter(item => item.getClientRects().length > 0);
  function focus(item?: HTMLButtonElement) { if (!item) return; for (const node of items()) node.tabIndex = node === item ? 0 : -1; item.focus(); }
  function expand(item: HTMLButtonElement, open: boolean) {
    item.setAttribute('aria-expanded', String(open));
    const group = document.getElementById(item.getAttribute('aria-controls')!)!; group.hidden = !open;
    open ? collapsed.delete(item.dataset.path!) : collapsed.add(item.dataset.path!);
    const active = items().find(node => node.tabIndex === 0);
    if (active && !active.getClientRects().length) { active.tabIndex = -1; item.tabIndex = 0; }
  }
  tree.onkeydown = event => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="treeitem"]'); if (!item) return;
    const list = visible(), index = list.indexOf(item), folder = item.hasAttribute('aria-expanded');
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft'].includes(event.key)) event.preventDefault();
    if (event.key === 'ArrowDown') focus(list[Math.min(list.length - 1, index + 1)]);
    else if (event.key === 'ArrowUp') focus(list[Math.max(0, index - 1)]);
    else if (event.key === 'Home') focus(list[0]);
    else if (event.key === 'End') focus(list.at(-1));
    else if (event.key === 'ArrowRight' && folder) { if (item.getAttribute('aria-expanded') === 'false') expand(item, true); else focus(list[index + 1]); }
    else if (event.key === 'ArrowLeft') { if (folder && item.getAttribute('aria-expanded') === 'true') expand(item, false); else focus(items().find(node => node.dataset.path === item.dataset.parent)); }
  };
  document.getElementById('collapse-folders')!.onclick = () => { for (const item of items().filter(node => node.hasAttribute('aria-expanded')).reverse()) expand(item, false); };
  return {
    render(paths: string[], active: string) {
      const focusedPath = tree.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.path : undefined;
      const query = search.value.trim().toLowerCase();
      const selectionChanged = selected !== active;
      if (selectionChanged) { const parts = active.split('/').filter(Boolean); for (let i = 1; i < parts.length; i++) collapsed.delete('/' + parts.slice(0, i).join('/')); }
      selected = active;
      const root: Entry = { name: '', path: '', children: new Map() };
      for (const path of paths) {
        if (query && !path.toLowerCase().includes(query)) continue;
        const parts = path.split('/').filter(Boolean); let parent = root;
        parts.forEach((name, index) => { if (!parent.children.has(name)) parent.children.set(name, { name, path: '/' + parts.slice(0, index + 1).join('/'), children: new Map() }); parent = parent.children.get(name)!; if (index === parts.length - 1) parent.file = true; });
      }
      tree.replaceChildren(); let serial = 0;
      function append(parent: Entry, container: HTMLElement, level: number) {
        for (const entry of [...parent.children.values()].sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name))) {
          const wrapper = document.createElement('div'); wrapper.className = 'tree-entry'; wrapper.setAttribute('role', 'none');
          const item = document.createElement('button'); item.type = 'button'; item.className = entry.file ? 'file tree-row' : 'folder tree-row'; item.title = entry.path; item.dataset.path = entry.path; item.dataset.parent = parent.path;
          item.style.setProperty('--depth', String(level)); item.setAttribute('role', 'treeitem'); item.setAttribute('aria-level', String(level)); item.tabIndex = -1;
          const name = document.createElement('span'); name.className = 'tree-name'; name.textContent = entry.name;
          if (entry.file) {
            item.classList.toggle('selected', entry.path === active); item.setAttribute('aria-selected', String(entry.path === active)); item.setAttribute('aria-current', String(entry.path === active));
            item.append(fileIcon(entry.path), name); item.onclick = () => selectFile(entry.path);
            item.oncontextmenu = event => { event.preventDefault(); contextMenu(entry.path, event.clientX, event.clientY); };
          } else {
            const group = document.createElement('div'); group.id = 'tree-folder-' + ++serial; group.setAttribute('role', 'group'); group.hidden = !query && collapsed.has(entry.path);
            item.setAttribute('aria-expanded', String(!group.hidden)); item.setAttribute('aria-controls', group.id); item.append(icon('chevron'), icon('folder'), name); item.onclick = () => { focus(item); expand(item, item.getAttribute('aria-expanded') !== 'true'); };
            wrapper.append(item, group); append(entry, group, level + 1);
          }
          if (entry.file) {
            const more = document.createElement('button'); more.className = 'icon-button file-menu-trigger'; more.append(icon('more')); more.type = 'button'; more.tabIndex = -1;
            more.setAttribute('aria-label', '文件操作 ' + entry.name); more.title = '文件操作'; more.setAttribute('aria-haspopup', 'menu');
            more.onclick = event => { event.stopPropagation(); const bounds = more.getBoundingClientRect(); contextMenu(entry.path, bounds.left, bounds.bottom); };
            wrapper.append(item, more);
          }
          container.append(wrapper);
        }
      }
      append(root, tree, 1);
      document.getElementById('no-files')!.hidden = root.children.size > 0;
      const target = visible().find(item => item.dataset.path === (focusedPath ?? active)) ?? visible()[0];
      if (target) { target.tabIndex = 0; if (focusedPath) target.focus(); else if (selectionChanged) target.scrollIntoView({ block: 'nearest' }); }
    },
    reset() { collapsed.clear(); selected = ''; },
  };
}
