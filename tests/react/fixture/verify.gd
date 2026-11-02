extends SceneTree

var ticks := 0
var phase := 0
var initial_main: Node
var other: Node
var hud: Node
var launch_path := ""
var marker_path := ""
var stress_identity: Node
var stress_resets := 0
var toggle_started := 0
var started_at := Time.get_ticks_msec()

func _initialize() -> void:
    var active = JSON.parse_string(FileAccess.get_file_as_string("res://generated/react/active.json"))
    if not active is Dictionary:
        fail("active descriptor missing")
        return
    var manifest = JSON.parse_string(FileAccess.get_file_as_string(str(active.manifestPath)))
    if not manifest is Dictionary:
        fail("manifest missing")
        return
    launch_path = str(manifest.entries.app.scene)
    marker_path = str(manifest.resources.marker.uri)
    call_deferred("start_fixture")

func start_fixture() -> void:
    var error = change_scene_to_file(launch_path)
    if error != OK:
        fail("entry load error %s" % error)

func fail(message: String) -> void:
    push_error("GODOT_REACT_FIXTURE_FAILED: " + message)
    quit(1)

func require_value(condition: bool, message: String) -> bool:
    if not condition:
        fail(message)
        return false
    return true

func count_business(parent: Node) -> int:
    var total := 0
    for child in parent.get_children():
        total += 1 + count_business(child)
    return total

func native_accept(button: Button) -> void:
    button.grab_focus()
    var press := InputEventKey.new()
    press.keycode = KEY_ENTER
    press.pressed = true
    Input.parse_input_event(press)
    var release := InputEventKey.new()
    release.keycode = KEY_ENTER
    release.pressed = false
    Input.parse_input_event(release)

func _process(_delta: float) -> bool:
    ticks += 1
    if Time.get_ticks_msec() - started_at > 20000:
        fail("fixture timed out at phase %s" % phase)
        return false
    if not is_instance_valid(current_scene):
        return false
    var app = current_scene.get_node_or_null("App")
    if app == null:
        return false
    match phase:
        0:
            var value = app.get_node_or_null("Main/Value")
            if value == null or value.text != "ctx-A/Main:1":
                return false
            if OS.get_cmdline_user_args().has("--inject-foreign-node"):
                var foreign := Node.new()
                foreign.name = "ExternalForeignSibling"
                root.add_child(foreign)
                print("GODOT_REACT_FOREIGN_NODE_INJECTED")
                phase = 99
                return false
            if OS.get_cmdline_user_args().has("--trigger-tsx-error"):
                print("GODOT_REACT_SOURCE_MAP_TRIGGERED")
                app.get_node("Other/Increment").toggled.emit(false)
                phase = 99
                return false
            initial_main = value
            other = app.get_node("Other/Value")
            hud = app.get_node("HUD/Status")
            if not require_value(other.text == "ctx-A/Other:10", "initial independent state"):
                return false
            if not require_value(app.get_node("Imported/Caption").text == "managed-template", "template content"):
                return false
            if not require_value(count_business(current_scene) == 15, "business node count / hidden envelope"):
                return false
            if not require_value(ResourceLoader.load(marker_path).resource_name == "react-conformance-marker", "native resource closure"):
                return false
            native_accept(app.get_node("Main/Increment"))
            phase = 1
        1:
            if app.get_node("Main/Value").text != "ctx-A/Main:2":
                return false
            if not require_value(app.get_node("Main/Value") == initial_main, "state update replaced native object"):
                return false
            native_accept(app.get_node("Other/Increment"))
            toggle_started = ticks
            phase = 11
        11:
            if ticks - toggle_started < 4:
                return false
            if not require_value(not app.get_node("Other/Increment").button_pressed and other.text == "ctx-A/Other:10", "controlled Button did not restore without a state update"):
                return false
            native_accept(app.get_node("Actions/UpdateProps"))
            phase = 2
        2:
            if app.get_node("Main/Value").text != "ctx-B/Main:2":
                return false
            if not require_value(app.get_node("Other/Value") == other and other.text == "ctx-B/Other:10", "Context/other identity"):
                return false
            if not require_value(app.get_node("HUD/Status") == hud and hud.text == "HUD:ctx-B", "HUD persistence"):
                return false
            if not require_value(app.get_node("Actions/UpdateProps").button_pressed, "uncontrolled native Button state was incorrectly reset"):
                return false
            app.get_node("Actions/ResetMain").pressed.emit()
            phase = 3
        3:
            if app.get_node("Main/Value").text != "ctx-B/Main:77":
                return false
            if not require_value(not is_instance_valid(initial_main), "retired native object not released"):
                return false
            if not require_value(app.get_node("Other/Value") == other and app.get_node("HUD/Status") == hud, "key reset affected sibling/HUD"):
                return false
            if not require_value(count_business(current_scene) == 15, "node graph changed after key reset"):
                return false
            stress_identity = app.get_node("Main/Value")
            app.get_node("Actions/ResetMain").pressed.emit()
            phase = 4
        4:
            var current = app.get_node("Main/Value")
            if current == stress_identity:
                return false
            if not require_value(not is_instance_valid(stress_identity), "stress retirement not released"):
                return false
            if not require_value(current.text == "ctx-B/Main:77" and app.get_node("Other/Value") == other and app.get_node("HUD/Status") == hud, "stress reset corrupted independent component"):
                return false
            if not require_value(count_business(current_scene) == 15, "stress native node count did not return to plateau"):
                return false
            stress_resets += 1
            stress_identity = current
            if stress_resets < 100:
                app.get_node("Actions/ResetMain").pressed.emit()
            else:
                print("GODOT_REACT_FIXTURE_BEHAVIOR_OK ", JSON.stringify({"ticks": ticks, "businessNodes": 15, "nativeGuiInput": true, "template": true, "propsPreserveState": true, "keyResetsOneScene": true, "context": true, "stressResets": stress_resets, "nativeNodePlateau": true, "controlledButton": true, "uncontrolledButton": true}))
                quit(0)
                phase = 5
    return false
