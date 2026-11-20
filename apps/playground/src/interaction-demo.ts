import {defaultProject} from './project-templates';
import type {EditorProject} from './project-model';

export const INTERACTION_DEMO_ID = 'interaction-demo';
export const INTERACTION_DEMO_PLAYER = {name: 'Player', startX: 64, endX: 128, y: 256, viewportWidth: 960, viewportHeight: 640};

export function createInteractionDemo(profile: string) {
  const project = defaultProject('godot', profile);
  const {name, startX, endX, y} = INTERACTION_DEMO_PLAYER;
  project.demoId = INTERACTION_DEMO_ID;
  project.files['/project.godot'] = (project.files['/project.godot'] as string).replace(
    'window/stretch/mode="canvas_items"', 'window/stretch/mode="canvas_items"\nwindow/stretch/aspect="ignore"');
  project.files[project.entry] = `import {Node2D, ColorRect, Vector2, Color, InputEvent, InputEventKey, InputEventMouseButton, Key, print} from "godot";

export default class Main extends Node2D {
  private fill!: ColorRect;
  private target!: ColorRect;
  private player: Node2D | null = null;

  _ready() {
    this.fill = new ColorRect();
    this.fill.size = new Vector2(4096, 4096);
    this.fill.color = new Color(1, 0, 0, 1);
    this.add_child(this.fill);
    this.target = new ColorRect();
    this.target.position = new Vector2(24, 24);
    this.target.size = new Vector2(180, 150);
    this.target.color = new Color(0, 0, 1, 1);
    this.add_child(this.target);
    const player = new Node2D();
    player.set_name('${name}');
    player.position = new Vector2(${startX}, ${y});
    const marker = new ColorRect();
    marker.position = new Vector2(-16, -16);
    marker.size = new Vector2(32, 32);
    marker.color = new Color(1, 1, 1, 1);
    player.add_child(marker);
    this.add_child(player);
    this.player = player;
    print('试玩示例已就绪');
  }

  _input(event: InputEvent) {
    if (event instanceof InputEventKey) {
      if (event.physical_keycode === Key.KEY_SPACE) {
        if (event.pressed && !event.echo) this.fill.color = new Color(0, 1, 0, 1);
        print(event.pressed ? '试玩按下 Space' : '试玩释放 Space');
      }
      if (event.pressed && !event.echo && event.physical_keycode === Key.KEY_RIGHT && this.player) {
        this.player.position = new Vector2(${endX}, ${y});
      }
      if (event.pressed && !event.echo && event.physical_keycode === Key.KEY_LEFT && this.player) {
        this.player.queue_free();
        this.player = null;
      }
    }
    if (event instanceof InputEventMouseButton && event.button_index === 1) {
      if (event.pressed && this.target.get_rect().has_point(event.position)) this.target.color = new Color(1, 1, 0, 1);
      print(event.pressed ? '试玩按下左键' : '试玩释放左键');
    }
  }
}
`;
  project.files['/README.md'] = '按右箭头将 Player 从 x=64 移到 x=128，按左箭头移除 Player。按 Space 将红色背景变成绿色，点击左上方色块将它变成黄色。';
  return project;
}

export function matchesInteractionDemo(project: EditorProject, sample: EditorProject): boolean {
  return project.demoId === sample.demoId && project.engineProfile === sample.engineProfile &&
    project.runtime === sample.runtime && project.entry === sample.entry && project.mode === sample.mode &&
    project.mainScene === sample.mainScene && project.mainSceneSource === sample.mainSceneSource &&
    project.demoApiVersion === sample.demoApiVersion && !project.engineDocument && !project.migration &&
    !Object.keys(project.controls).length && Object.keys(project.files).length === Object.keys(sample.files).length &&
    Object.entries(sample.files).every(([path, contents]) => project.files[path] === contents);
}
