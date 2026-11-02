extends SceneTree

var ticks := 0
var grounded_ticks := 0
var saw_fall := false
var last_y := 0.0
var started_at := Time.get_ticks_msec()

func _initialize() -> void:
    var active = JSON.parse_string(FileAccess.get_file_as_string("res://generated/react/active.json"))
    var manifest = JSON.parse_string(FileAccess.get_file_as_string(str(active.manifestPath)))
    call_deferred("change_scene_to_file", str(manifest.entries.physics.scene))

func fail(message: String) -> void:
    push_error("GODOT_REACT_FIXTURE_FAILED: " + message)
    quit(1)

func _process(_delta: float) -> bool:
    ticks += 1
    if Time.get_ticks_msec() - started_at > 20000:
        fail("physics fixture timed out")
        return false
    if current_scene == null:
        return false
    var actor = current_scene.get_node_or_null("PhysicsWorld/Actor")
    if actor == null:
        return false
    if not actor is CharacterBody2D:
        fail("actor is not real CharacterBody2D")
        return false
    if actor.position.y > 15 and actor.position.y > last_y:
        saw_fall = true
    last_y = actor.position.y
    if actor.position.y > 170:
        fail("actor fell through static native collision shape")
        return false
    if actor.is_on_floor() and actor.position.y >= 120 and actor.position.y <= 130 and abs(actor.velocity.y) < 0.1:
        grounded_ticks += 1
    else:
        grounded_ticks = 0
    if grounded_ticks >= 30 and saw_fall:
        print("GODOT_REACT_PHYSICS_NATIVE_OK ", JSON.stringify({"ticks": ticks, "positionY": actor.position.y, "velocityY": actor.velocity.y, "onFloor": actor.is_on_floor(), "sawFall": saw_fall}))
        quit(0)
    return false
