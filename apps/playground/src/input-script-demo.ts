import {parseProject, type EditorProject} from './project-model.ts';

export const INPUT_SCRIPT_DEMO_ID = 'input-script-demo';
export const INPUT_SCRIPT_PLAYER_PATH = '/root/Main/Player';

export function createInputScriptDemo(profile: string): EditorProject {
  return parseProject({
    schemaVersion: 4, runtime: 'engine', engineProfile: profile,
    launch: {kind: 'scene', source: 'project'},
    editor: {demoId: INPUT_SCRIPT_DEMO_ID, selected: '/src/Player.ts', mode: 'production'},
    files: {
      '/project.godot': `config_version=5
[application]
config/name="Input script"
run/main_scene="res://main.tscn"
[display]
window/size/viewport_width=960
window/size/viewport_height=640
window/stretch/mode="canvas_items"
window/stretch/aspect="ignore"
[rendering]
renderer/rendering_method="gl_compatibility"
environment/defaults/default_clear_color=Color(1, 0, 0, 1)
[physics]
common/physics_ticks_per_second=60
common/physics_interpolation=false
[input]
move_right={
"deadzone": 0.5,
"events": []
}
[GodotJS]
runtime/core/camel_case_bindings_enabled=false
`,
      '/main.tscn': `[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://src/Player.ts" id="1"]
[node name="Main" type="Node2D"]
[node name="Player" type="Node2D" parent="."]
position = Vector2(64, 256)
script = ExtResource("1")
[node name="Marker" type="Polygon2D" parent="Player"]
polygon = PackedVector2Array(-16, -16, 16, -16, 16, 16, -16, 16)
color = Color(1, 1, 1, 1)
`,
      '/src/Player.ts': `import {Input, Node2D, Vector2} from 'godot';
export default class Player extends Node2D {
  _physics_process(_delta: number) {
    if (Input.is_action_pressed('move_right')) {
      this.position = new Vector2(this.position.x + 16, this.position.y);
    }
  }
}
`,
      '/README.md': '用 engine.game_input 按住 move_right 四个物理步。Player 从 x=64 移到 x=128。用 engine.game_probe 核对位置和画面。',
    },
  });
}

export function matchesInputScriptDemo(project: EditorProject, sample: EditorProject): boolean {
  return project.demoId === sample.demoId && project.engineProfile === sample.engineProfile && project.mode === sample.mode &&
    project.engineDocument?.launch.kind === 'scene' && project.engineDocument.launch.source === 'project' &&
    Object.keys(project.files).length === Object.keys(sample.files).length &&
    Object.entries(sample.files).every(([path, contents]) => project.files[path] === contents);
}
