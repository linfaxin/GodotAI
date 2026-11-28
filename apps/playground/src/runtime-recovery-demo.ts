import type {EngineProjectDocument} from '@godot-js/project-tools/project-document';
import {createInputScriptDemo} from './input-script-demo.ts';
import {parseProject, type EditorProject} from './project-model.ts';

export const RUNTIME_RECOVERY_DEMO_ID = 'runtime-recovery-demo';
export const RUNTIME_RECOVERY_START_FILE = '/src/start.ts';
export const RUNTIME_RECOVERY_ASSET_FILE = '/assets/recovery-patch.png';
export const RUNTIME_RECOVERY_ERROR = 'RUNTIME_RECOVERY_START_FAILURE';
export const RUNTIME_RECOVERY_ROOT_PATH = '/root/PlaygroundEngineBootstrap/Main';
export const RUNTIME_RECOVERY_PLAYER_PATH = RUNTIME_RECOVERY_ROOT_PATH + '/Player';
export const RUNTIME_RECOVERY_PATCH = {x: 384, y: 128, original: [25, 128, 240], replacement: [220, 60, 100]} as const;

// 4×4 opaque patches with the two RGB values above, encoded with encodeRgbaPng.
const originalPatch = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAT0lEQVR4AQFEALv/ABmA8P8ZgPD/GYDw/xmA8P8AGYDw/xmA8P8ZgPD/GYDw/wAZgPD/GYDw/xmA8P8ZgPD/ABmA8P8ZgPD/GYDw/xmA8P9IfyiBFWKOsQAAAABJRU5ErkJggg==';
const replacementPatch = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAT0lEQVR4AQFEALv/ANw8ZP/cPGT/3Dxk/9w8ZP8A3Dxk/9w8ZP/cPGT/3Dxk/wDcPGT/3Dxk/9w8ZP/cPGT/ANw8ZP/cPGT/3Dxk/9w8ZP9BZyext3fDpQAAAABJRU5ErkJggg==';

function startup(broken: boolean): string {
  return `import {Node, PackedScene, ResourceLoader, Sprite2D, Texture2D, Vector2} from 'godot';
const startupBroken = ${broken};

export async function start({mount}: {mount: Node}) {
  await Promise.resolve();
  if (startupBroken) throw Error('${RUNTIME_RECOVERY_ERROR}');
  const packed = ResourceLoader.load('res://main.tscn');
  if (!(packed instanceof PackedScene)) throw Error('Expected the Main scene');
  const main = packed.instantiate();
  if (!main) throw Error('Could not instantiate Main');
  mount.add_child(main);

  const texture = ResourceLoader.load('res:/${RUNTIME_RECOVERY_ASSET_FILE}');
  if (!(texture instanceof Texture2D)) throw Error('Expected the imported patch texture');
  const patch = new Sprite2D();
  patch.texture = texture;
  patch.position = new Vector2(${RUNTIME_RECOVERY_PATCH.x}, ${RUNTIME_RECOVERY_PATCH.y});
  patch.scale = new Vector2(16, 16);
  main.add_child(patch);
}
`;
}

export function runtimeRecoveryFixture(profile: string): {document: EngineProjectDocument; repairedSource: string; replacementPng: number[]} {
  const inputDemo = createInputScriptDemo(profile);
  const path = 'res:/' + RUNTIME_RECOVERY_START_FILE;
  const files = {
    ...inputDemo.files,
    [RUNTIME_RECOVERY_START_FILE]: startup(true),
    [RUNTIME_RECOVERY_ASSET_FILE]: Array.from(atob(originalPatch), byte => byte.charCodeAt(0)),
    '/README.md': '在 API 调用台打开「Summer：定位启动错误并恢复试玩」。修复 /src/start.ts 的 startupBroken 后，继续使用同一个项目。',
  };
  return {
    document: {
      schemaVersion: 4, runtime: 'engine', engineProfile: profile, launch: {kind: 'script', module: path, export: 'start'}, files,
      resourceImports: [{resource: 'res:/' + RUNTIME_RECOVERY_ASSET_FILE, converter: 'godotjs/png-ctex', parameters: {mipmaps: false}}],
      editor: {demoId: RUNTIME_RECOVERY_DEMO_ID, selected: RUNTIME_RECOVERY_START_FILE, mode: 'production'},
    },
    repairedSource: startup(false),
    replacementPng: Array.from(atob(replacementPatch), byte => byte.charCodeAt(0)),
  };
}

export function createRuntimeRecoveryDemo(profile: string): EditorProject {
  return parseProject(runtimeRecoveryFixture(profile).document);
}

export function matchesRuntimeRecoveryDemo(project: EditorProject, sample: EditorProject): boolean {
  return project.demoId === sample.demoId && project.engineProfile === sample.engineProfile && project.mode === sample.mode &&
    JSON.stringify(project.engineDocument?.launch) === JSON.stringify(sample.engineDocument?.launch) &&
    JSON.stringify(project.engineDocument?.baseDocument.resourceImports) === JSON.stringify(sample.engineDocument?.baseDocument.resourceImports) &&
    Object.keys(project.files).length === Object.keys(sample.files).length &&
    Object.entries(sample.files).every(([path, contents]) => {
      const actual = project.files[path];
      return typeof contents === 'string' ? actual === contents :
        Array.isArray(actual) && actual.length === contents.length && contents.every((byte, index) => actual[index] === byte);
    });
}
