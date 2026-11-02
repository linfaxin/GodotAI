/** Trusted SceneState expansion; never instantiates Nodes or executes project scripts. */
export function extractorSource(sources: readonly string[]): string {
  return `extends SceneTree
func encode(value):
 if value is Vector2: return {"x": value.x, "y": value.y}
 if value is Color: return {"r": value.r, "g": value.g, "b": value.b, "a": value.a}
 if value is Resource: return {"resource": value.resource_path, "type": value.get_class()}
 return value
func join_path(prefix, relative):
 if relative == ".": return prefix
 if prefix == ".": return relative
 return prefix + "/" + relative
func normalized(path):
 if path.begins_with("./"): return path.substr(2)
 return path
func expanded(state):
 var result = {}
 var base = state.get_base_scene_state()
 if base != null: result = expanded(base)
 for i in state.get_node_count():
  var path = normalized(str(state.get_node_path(i)))
  var nested = state.get_node_instance(i)
  if nested != null:
   var children = expanded(nested.get_state())
   for child_path in children:
    var child = children[child_path].duplicate(true)
    if child_path == ".": child.name = str(state.get_node_name(i))
    if child.owner != "": child.owner = join_path(path, child.owner)
    result[join_path(path, child_path)] = child
  if not result.has(path): result[path] = {"name": str(state.get_node_name(i)), "type": str(state.get_node_type(i)), "properties": {}, "owner": ""}
  if str(state.get_node_type(i)) != "": result[path].type = str(state.get_node_type(i))
  result[path].name = str(state.get_node_name(i))
  var owner = normalized(str(state.get_node_owner_path(i)))
  if owner != "": result[path].owner = owner
  for p in state.get_node_property_count(i): result[path].properties[str(state.get_node_property_name(i,p))] = encode(state.get_node_property_value(i,p))
 return result
func _initialize():
 var output = []
 for source in ${JSON.stringify(sources)}:
  var scene = ResourceLoader.load(source)
  if not scene is PackedScene:
   quit(41)
   return
  var nodes = expanded(scene.get_state())
  var counts = {}
  for path in nodes:
   var parent = (path.get_base_dir() if path.contains("/") else ".") if path != "." else "@root"
   nodes[path].order = counts.get(parent, 0)
   counts[parent] = nodes[path].order + 1
  output.append({"source": source, "nodes": nodes})
 var file = FileAccess.open("res://extracted.json", FileAccess.WRITE)
 file.store_string(JSON.stringify(output))
 quit(0)
`;
}
