const labels: Readonly<Record<string, string>> = Object.freeze({
  'core-ui-v1': '基础 UI',
  'ui-media-v1': 'UI 与图片',
  'behavior-physics-v1': '2D 物理',
  'game-2d-v1': '2D 游戏：UI、贴图与物理',
});

export function profileLabel(id: string): string { return labels[id] ?? id; }

export function unsupportedProfileMessage(id: string, profiles: Readonly<Record<string, unknown>>): string | undefined {
  return Object.hasOwn(profiles, id) ? undefined : `当前运行版本不支持能力范围 ${id}。项目内容已保留；请选择可用能力范围，或使用支持该项目的运行版本。`;
}
