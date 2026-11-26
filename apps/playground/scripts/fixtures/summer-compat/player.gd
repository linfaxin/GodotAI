extends Node2D

const ACTIONS: Array[StringName] = [&"move_right", &"jump"]

var trace: FileAccess
var run_id := ""
var elapsed_game_seconds := 0.0
var was_pressed := {&"move_right": false, &"jump": false}
var held_ticks := {&"move_right": 0, &"jump": 0}


func _ready() -> void:
	run_id = "%d-%s" % [OS.get_process_id(), Crypto.new().generate_random_bytes(12).hex_encode()]
	var trace_dir := OS.get_environment("GODOTAI_SUMMER_TRACE_DIR")
	if trace_dir.is_empty():
		trace_dir = OS.get_user_data_dir()
	var trace_path := trace_dir.path_join("godotai-summer-%s.jsonl" % run_id)
	trace = FileAccess.open(trace_path, FileAccess.WRITE)
	if trace == null:
		push_error("Summer input fixture could not open its trace: %s (%s)" % [trace_path, FileAccess.get_open_error()])
		get_tree().quit(1)
		return
	record_edge("ready", &"", 0)
	print("GODOTAI_SUMMER_TRACE ", trace_path)


func _physics_process(delta: float) -> void:
	elapsed_game_seconds += delta
	for action in ACTIONS:
		var pressed := Input.is_action_pressed(action)
		if pressed and not was_pressed[action]:
			held_ticks[action] = 0
			record_edge("pressed", action, 0)
		if pressed:
			held_ticks[action] += 1
			if action == &"move_right":
				position.x += 16
		elif was_pressed[action]:
			record_edge("released", action, held_ticks[action])
		was_pressed[action] = pressed


func record_edge(edge: String, action: StringName, ticks: int) -> void:
	var observation := {
		"schemaVersion": 1,
		"fixture": "godotai-summer-input",
		"runId": run_id,
		"pid": OS.get_process_id(),
		"edge": edge,
		"action": String(action),
		"physicsFrame": Engine.get_physics_frames(),
		"processFrame": Engine.get_process_frames(),
		"wallUsec": Time.get_ticks_usec(),
		"elapsedGameSeconds": elapsed_game_seconds,
		"physicsTicksPerSecond": Engine.physics_ticks_per_second,
		"physicsInterpolation": ProjectSettings.get_setting("physics/common/physics_interpolation", false),
		"timeScale": Engine.time_scale,
		"heldTicks": ticks,
		"position": {"x": position.x, "y": position.y},
	}
	if edge == "ready":
		observation["engineBuild"] = Engine.get_version_info()
	trace.store_line(JSON.stringify(observation))
	trace.flush()
