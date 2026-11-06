export function icon(name: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
}

export function fileIcon(path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase();
  const span = document.createElement('span'); span.className = 'file-icon type-' + extension; span.setAttribute('aria-hidden', 'true');
  if (extension === 'tsx' || extension === 'jsx') span.append(icon('react'));
  else if (['png', 'jpg', 'jpeg', 'svg'].includes(extension ?? '')) span.append(icon('image'));
  else if (extension === 'ts' || extension === 'js') span.textContent = extension.toUpperCase();
  else if (extension === 'json') span.textContent = '{}';
  else span.append(icon('file'));
  return span;
}
