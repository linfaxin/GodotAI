extends Node
# Trusted engine-only probe. These classes are not exposed by the TSX profile.
var two: SubViewport
var three: SubViewport
var ticks := 0
var checking := false
var completed := false
func _ready():
    two = SubViewport.new()
    two.size = Vector2i(64, 64)
    two.disable_3d = true
    two.render_target_update_mode = SubViewport.UPDATE_ALWAYS
    add_child(two)
    var image := Image.create(1, 1, false, Image.FORMAT_RGBA8)
    image.fill(Color.WHITE)
    var particle2 := GPUParticles2D.new()
    particle2.position = Vector2(32, 32)
    particle2.amount = 1
    particle2.lifetime = 8.0
    particle2.explosiveness = 1.0
    particle2.visibility_rect = Rect2(-32, -32, 64, 64)
    particle2.texture = ImageTexture.create_from_image(image)
    var material2 := ParticleProcessMaterial.new()
    material2.gravity = Vector3.ZERO
    material2.particle_flag_disable_z = true
    material2.scale_min = 8.0
    material2.scale_max = 8.0
    material2.color = Color.RED
    particle2.process_material = material2
    two.add_child(particle2)
    three = SubViewport.new()
    three.size = Vector2i(64, 64)
    three.own_world_3d = true
    three.render_target_update_mode = SubViewport.UPDATE_ALWAYS
    add_child(three)
    var camera := Camera3D.new()
    camera.projection = Camera3D.PROJECTION_ORTHOGONAL
    camera.size = 2.0
    camera.position = Vector3(0, 0, 3)
    camera.current = true
    three.add_child(camera)
    var particle3 := GPUParticles3D.new()
    particle3.amount = 1
    particle3.lifetime = 8.0
    particle3.explosiveness = 1.0
    particle3.visibility_aabb = AABB(Vector3(-1, -1, -1), Vector3(2, 2, 2))
    var material3 := ParticleProcessMaterial.new()
    material3.gravity = Vector3.ZERO
    particle3.process_material = material3
    var mesh := QuadMesh.new()
    mesh.size = Vector2(0.5, 0.5)
    var surface := StandardMaterial3D.new()
    surface.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
    surface.albedo_color = Color.BLUE
    mesh.material = surface
    particle3.draw_pass_1 = mesh
    three.add_child(particle3)
func _process(_delta):
    ticks += 1
    if completed or checking or ticks < 40 or ticks % 20 != 0:
        return
    checking = true
    await RenderingServer.frame_post_draw
    var red := two.get_texture().get_image().get_pixel(32, 32)
    var blue := three.get_texture().get_image().get_pixel(32, 32)
    if red.r > 0.8 and red.b < 0.2 and blue.b > 0.8 and blue.r < 0.2:
        completed = true
        print("GPU_PROBE_OK ", JSON.stringify({"gpu2d":true,"gpu3d":true,"renderer":RenderingServer.get_current_rendering_method()}))
    elif ticks > 240:
        completed = true
        push_error("GPU_PROBE_FAILED "+str(red)+" "+str(blue))
    checking = false
