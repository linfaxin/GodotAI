extends SceneTree

func _initialize() -> void:
	call_deferred("extract")

# Flatten imported mesh nodes offline. Runtime scene trees remain React-owned.
func mesh_for(child: MeshInstance3D, transform: Transform3D, materials: Dictionary, strict_texture: bool) -> ArrayMesh:
	var source: Mesh = child.mesh
	if child.skin != null:
		source = child.bake_mesh_from_current_skeleton_pose()
	var result := ArrayMesh.new()
	for surface in range(source.get_surface_count()):
		var tool := SurfaceTool.new()
		tool.begin(Mesh.PRIMITIVE_TRIANGLES)
		tool.append_from(source, surface, transform)
		var material = child.get_active_material(surface)
		if strict_texture and material is StandardMaterial3D and material.albedo_texture == null:
			push_error("Missing upstream colormap texture")
			return null
		if material is StandardMaterial3D:
			var identity = material.get_instance_id()
			if not materials.has(identity):
				var copy = material.duplicate()
				# Imported CompressedTexture2D retains its temporary cache path.
				# Embed pixels instead, so exported meshes are self-contained.
				if material.albedo_texture != null:
					copy.albedo_texture = ImageTexture.create_from_image(material.albedo_texture.get_image())
				materials[identity] = copy
			material = materials[identity]
		tool.set_material(material)
		tool.commit(result)
	return result

func vector(v: Vector3) -> Dictionary:
	return {"x":v.x,"y":v.y,"z":v.z}

func extract() -> void:
	var output := OS.get_cmdline_user_args()[0]
	var jobs = JSON.parse_string(FileAccess.get_file_as_string("res://models.json"))
	var parts := {}
	DirAccess.make_dir_recursive_absolute(output)
	for job in jobs:
		var packed: PackedScene = load("res://" + job.source)
		if packed == null:
			quit(1)
			return
		var instance := packed.instantiate()
		root.add_child(instance)
		await process_frame
		var result := ArrayMesh.new()
		var materials := {}
		var list := []
		var index := 0
		for child in instance.find_children("*", "MeshInstance3D", true, false):
			var transform: Transform3D = child.global_transform
			transform.origin.y += job.get("offsetY",0)
			var exported := mesh_for(child,Transform3D.IDENTITY if job.get("parts",false) else transform,materials,job.get("strictTexture",true))
			if exported == null:
				quit(1)
				return
			if job.get("parts",false):
				var id: String = job.id + "-" + str(index)
				var record = {"id":id,"name":child.name,"position":vector(transform.origin),"rotation":vector(transform.basis.get_euler()),"scale":vector(transform.basis.get_scale())}
				ResourceSaver.save(exported,output.path_join(id+".res"),ResourceSaver.FLAG_BUNDLE_RESOURCES|ResourceSaver.FLAG_COMPRESS)
				if job.get("collision",false):
					var shape = exported.create_convex_shape()
					if shape == null:
						push_error("Unable to create convex shard shape")
						quit(1)
						return
					record.shapeId = id+"-shape"
					ResourceSaver.save(shape,output.path_join(record.shapeId+".res"),ResourceSaver.FLAG_COMPRESS)
				list.append(record)
			else:
				for surface in range(exported.get_surface_count()):
					result.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES,exported.surface_get_arrays(surface))
					result.surface_set_material(result.get_surface_count()-1,exported.surface_get_material(surface))
			index += 1
		if job.get("parts",false):
			parts[job.id] = list
		else:
			if result.get_surface_count() == 0:
				push_error("Empty extracted mesh: " + job.id)
				quit(1)
				return
			var error := ResourceSaver.save(result,output.path_join(job.id+".res"),ResourceSaver.FLAG_BUNDLE_RESOURCES|ResourceSaver.FLAG_COMPRESS)
			if error != OK:
				quit(1)
				return
		print("PLAYGROUND_ASSET ",job.id," ",index," meshes")
		instance.free()
	var file := FileAccess.open(output.path_join("models.json"),FileAccess.WRITE)
	file.store_string(JSON.stringify(parts))
	file.close()
	quit(0)
