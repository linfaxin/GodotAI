import type { EditorProject } from '../../scripts/jsb.react-browser/src/project-document.js';
import { BUILTIN_PACKAGES } from './builtin-catalog.js';

export function isDependencyManifest(path: string): boolean {
  return /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(path);
}

/** Upgrade old saved/shared projects to the site's fixed, read-only catalog. */
export function useBuiltInDependencies(project: EditorProject): EditorProject {
  for (const path of Object.keys(project.files)) {
    if (!isDependencyManifest(path)) continue;
    if (project.config.entry === path || Object.values(project.config.entries ?? {}).some(entry => entry.module === path)
      || Object.values(project.config.assets ?? {}).some(asset => asset.source === path)) {
      throw Error('E_PROJECT_MANIFEST: 依赖清单不能作为入口或资源使用');
    }
    delete project.files[path];
  }
  delete project.lock;
  project.config.dependencies = { ...BUILTIN_PACKAGES };
  if (!Object.hasOwn(project.files, project.selected)) project.selected = project.config.entry;
  return project;
}

export function assertEditableFile(path: string): void {
  if (isDependencyManifest(path)) throw Error('E_READ_ONLY_DEPENDENCIES: 依赖由站点内置，请在「内置依赖」中查看');
}
