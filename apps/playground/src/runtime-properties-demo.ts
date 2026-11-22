import {parseProject, type EditorProject} from './project-model.ts';

export const RUNTIME_PROPERTIES_DEMO_ID = 'runtime-properties-demo';
export const RUNTIME_PROPERTIES_PLAYER_PATH = '/root/Main/Player';
export const RUNTIME_PROPERTIES_DEMO_READY = 'RUNTIME_PROPERTIES_DEMO_READY';

/** A normal scene and standard GodotJS exports; there is no debug state registry. */
export function createRuntimePropertiesDemo(profile: string): EditorProject {
  return parseProject({
    schemaVersion: 4, runtime: 'engine', engineProfile: profile,
    launch: {kind: 'scene', source: 'project'},
    editor: {demoId: RUNTIME_PROPERTIES_DEMO_ID, selected: '/src/Player.ts', mode: 'production'},
    files: {
      '/project.godot': `config_version=5
[application]
config/name="Runtime properties"
run/main_scene="res://main.tscn"
[display]
window/size/viewport_width=960
window/size/viewport_height=640
window/stretch/mode="canvas_items"
window/stretch/aspect="ignore"
[rendering]
renderer/rendering_method="gl_compatibility"
environment/defaults/default_clear_color=Color(1, 0, 0, 1)
`,
      '/main.tscn': `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://src/Player.ts" id="1_player"]

[node name="Main" type="Node2D"]

[node name="Background" type="ColorRect" parent="."]
offset_left = -4096.0
offset_top = -4096.0
offset_right = 4096.0
offset_bottom = 4096.0
mouse_filter = 2
color = Color(1, 0, 0, 1)

[node name="Player" type="Node2D" parent="."]
position = Vector2(64, 256)
script = ExtResource("1_player")

[node name="Marker" type="ColorRect" parent="Player"]
offset_left = -16.0
offset_top = -16.0
offset_right = 16.0
offset_bottom = 16.0
mouse_filter = 2
color = Color(1, 1, 1, 1)

[node name="HealthBase" type="ColorRect" parent="."]
offset_left = 24.0
offset_top = 24.0
offset_right = 224.0
offset_bottom = 40.0
mouse_filter = 2
color = Color(0, 0, 0, 1)

[node name="HealthBar" type="ColorRect" parent="."]
offset_left = 24.0
offset_top = 24.0
offset_right = 224.0
offset_bottom = 40.0
mouse_filter = 2
color = Color(0, 1, 0, 1)

[node name="Caption" type="Label" parent="."]
offset_left = 24.0
offset_top = 48.0
offset_right = 600.0
offset_bottom = 80.0
mouse_filter = 2
`,
      '/src/Player.ts': `import {Node2D, ColorRect, Label, NodePath, Vector2, InputEvent, InputEventKey, Key, Variant, print} from 'godot';
import {createClassBinder} from 'godot.annotations';

const bind = createClassBinder();

@bind()
export default class Player extends Node2D {
  @bind.export(Variant.Type.TYPE_INT)
  accessor health: number = 100;
  @bind.export(Variant.Type.TYPE_FLOAT)
  accessor move_step: number = 64;
  @bind.export(Variant.Type.TYPE_BOOL)
  accessor can_move: boolean = true;
  @bind.export(Variant.Type.TYPE_STRING)
  accessor display_name: string = 'Player 你好';

  private internalCounter = 0;
  private bar!: ColorRect;
  private caption!: Label;

  _ready() {
    this.bar = this.get_node(new NodePath('../HealthBar')) as ColorRect;
    this.caption = this.get_node(new NodePath('../Caption')) as Label;
    this._process(0);
    print('${RUNTIME_PROPERTIES_DEMO_READY}');
  }

  _process(_delta: number) {
    this.bar.size = new Vector2(2 * Math.max(0, Math.min(100, this.health)), 16);
    this.caption.text = this.display_name + ' · Health ' + this.health;
  }

  _input(event: InputEvent) {
    if (!(event instanceof InputEventKey) || !event.pressed || event.echo) return;
    if (event.physical_keycode === Key.KEY_RIGHT && this.can_move) {
      this.position = new Vector2(this.position.x + this.move_step, 256);
      this.internalCounter++;
    }
    if (event.physical_keycode === Key.KEY_DOWN) this.position = new Vector2(64, 256);
  }
}
`,
      '/README.md': '标准 GodotJS 导出属性示例。Right 每次移动 move_step 像素，Down 恢复位置。health 控制血条；运行时修改不保存到场景或源码。',
    },
  });
}

export function matchesRuntimePropertiesDemo(project: EditorProject, sample: EditorProject): boolean {
  return project.demoId === RUNTIME_PROPERTIES_DEMO_ID && project.engineProfile === sample.engineProfile &&
    project.engineDocument?.launch.kind === 'scene' && project.mode === sample.mode &&
    Object.keys(project.files).length === Object.keys(sample.files).length &&
    Object.entries(sample.files).every(([path, contents]) => project.files[path] === contents);
}
