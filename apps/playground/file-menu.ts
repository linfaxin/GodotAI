interface Options {
  select(path: string): void;
  canDelete(path: string): boolean;
  rename(path: string): void;
  remove(path: string): void;
  toast(message: string): void;
}

export function createFileMenu(options: Options) {
  const menu = document.getElementById('file-context-menu')!;
  const tree = document.getElementById('files')!;
  const rename = document.getElementById('rename-file') as HTMLButtonElement;
  const remove = document.getElementById('delete-file') as HTMLButtonElement;
  let path = '';
  function close(restoreFocus = false) {
    menu.hidden = true;
    if (restoreFocus) [...tree.querySelectorAll<HTMLButtonElement>('.file')].find(item => item.dataset.path === path)?.focus();
  }
  function open(file: string, x: number, y: number) {
    options.select(file); path = file;
    document.getElementById('file-menu-path')!.textContent = file.split('/').at(-1)!;
    remove.disabled = !options.canDelete(file); remove.title = remove.disabled ? '入口文件或最后一个文件不能删除' : '删除此文件';
    menu.hidden = false; const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(x, innerWidth - bounds.width - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, innerHeight - bounds.height - 6)) + 'px';
    rename.focus();
  }
  rename.onclick = () => { close(); options.rename(path); };
  remove.onclick = () => { if (options.canDelete(path)) { close(); options.remove(path); } };
  document.getElementById('copy-file-path')!.onclick = async () => { const file = path; close(true); try { await navigator.clipboard.writeText(file); options.toast('文件路径已复制'); } catch { options.toast('无法访问剪贴板'); } };
  menu.onkeydown = event => {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus(); }
  };
  tree.addEventListener('keydown', event => {
    const row = (event.target as HTMLElement).closest<HTMLButtonElement>('.file'); if (!row) return;
    const file = row.dataset.path!;
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); const bounds = row.getBoundingClientRect(); open(file, bounds.left + 28, bounds.bottom); }
    else if (event.key === 'F2') { event.preventDefault(); options.rename(file); }
    else if (event.key === 'Delete' && options.canDelete(file)) { event.preventDefault(); options.remove(file); }
  });
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target as Node)) close(); });
  document.addEventListener('focusin', event => { if (!menu.hidden && !menu.contains(event.target as Node)) close(); });
  document.addEventListener('scroll', event => { if (!menu.contains(event.target as Node)) close(); }, true);
  window.addEventListener('resize', () => close());
  return { open, close };
}
