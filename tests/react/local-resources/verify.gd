extends SceneTree

var ticks := 0
var resets := 0
var previous_a: Node
var previous_a_material_id := 0
var persistent_b: Node
var b_material: Resource
var initialized := false
var material_path := ""
var started_at := Time.get_ticks_msec()

func _initialize() -> void:
    var active = JSON.parse_string(FileAccess.get_file_as_string("res://generated/react/active.json"))
    var manifest = JSON.parse_string(FileAccess.get_file_as_string(str(active.manifestPath)))
    for resource in manifest.resources.values():
        if str(resource.type) == "CanvasItemMaterial":
            material_path = str(resource.uri)
    call_deferred("change_scene_to_file", str(manifest.entries.local.scene))

func fail(message: String) -> void:
    push_error("GODOT_REACT_FIXTURE_FAILED: " + message)
    quit(1)

func require_value(condition: bool, message: String) -> bool:
    if not condition:
        fail(message)
        return false
    return true

func _process(_delta: float) -> bool:
    ticks += 1
    if Time.get_ticks_msec() - started_at > 20000:
        fail("local-resource fixture timed out")
        return false
    if current_scene == null:
        return false
    var world = current_scene.get_node_or_null("LocalWorld")
    if world == null:
        return false
    var a = world.get_node("A")
    var b = world.get_node("B")
    if initialized and is_instance_valid(previous_a) and a == previous_a:
        return false
    if not require_value(a.material != null and a.material == a.get_node("Caption").material, "per-instance aliases were not preserved"):
        return false
    if not require_value(b.material != null and b.material == b.get_node("Caption").material and a.material != b.material, "instances share a local-to-scene resource"):
        return false
    if not require_value(a.material.resource_local_to_scene and a.material.get_local_scene() == a and b.material.get_local_scene() == b, "local resource scene identity differs from native PackedScene"):
        return false
    if not require_value(a.get_node("Caption").owner == a and b.get_node("Caption").owner == b, "template owner graph differs from PackedScene"):
        return false
    if not initialized:
        initialized = true
        persistent_b = b
        b_material = b.material
        if not require_value(not material_path.is_empty() and ResourceLoader.load(material_path) != a.material, "source asset was not cloned"):
            return false
    else:
        if not require_value(not is_instance_valid(previous_a) and b == persistent_b and b.material == b_material, "local scene reset affected persistent instance"):
            return false
        if not require_value(a.material.get_instance_id() != previous_a_material_id, "key reset reused the retired local resource identity"):
            return false
        resets += 1
    previous_a = a
    previous_a_material_id = a.material.get_instance_id()
    if resets < 20:
        world.get_node("ResetA").pressed.emit()
    else:
        print("GODOT_REACT_LOCAL_RESOURCES_NATIVE_OK ", JSON.stringify({"resets": resets, "sameInstanceAliases": true, "crossInstanceIsolation": true, "localSceneIdentity": true, "owners": true, "sourceCloned": true, "persistentSibling": true}))
        quit(0)
    return false
