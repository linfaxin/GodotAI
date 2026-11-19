import {defaultProject} from './project-templates';
import type {EditorProject} from './project-model';

export const INTERACTION_DEMO_ID = 'interaction-demo';

export function createInteractionDemo(profile: string) {
  const project = defaultProject('godot', profile);
  project.demoId = INTERACTION_DEMO_ID;
  project.files[project.entry] = `import {Node2D, ColorRect, Vector2, Color, InputEvent, InputEventKey, InputEventMouseButton, Key, print} from "godot";

export default class Main extends Node2D {
  private fill!: ColorRect;
  private target!: ColorRect;

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
    print('试玩示例已就绪');
  }

  _input(event: InputEvent) {
    if (event instanceof InputEventKey && event.physical_keycode === Key.KEY_SPACE) {
      if (event.pressed && !event.echo) this.fill.color = new Color(0, 1, 0, 1);
      print(event.pressed ? '试玩按下 Space' : '试玩释放 Space');
    }
    if (event instanceof InputEventMouseButton && event.button_index === 1) {
      if (event.pressed && this.target.get_rect().has_point(event.position)) this.target.color = new Color(1, 1, 0, 1);
      print(event.pressed ? '试玩按下左键' : '试玩释放左键');
    }
  }
}
`;
  project.files['/README.md'] = '在试玩回放中按 Space 将红色背景变为绿色。点击左上方色块会将它变为黄色。';
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
