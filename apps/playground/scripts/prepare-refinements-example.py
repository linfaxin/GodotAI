from pathlib import Path
import json,struct,zlib,binascii
root=Path(__file__).resolve().parents[1];dest=root/'examples'
def png(w,h,pixel):
 def chunk(k,b):return struct.pack('>I',len(b))+k+b+struct.pack('>I',binascii.crc32(k+b)&0xffffffff)
 raw=b''.join(b'\0'+bytes(v for x in range(w) for v in pixel(x,y)) for y in range(h))
 return list(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))
rgba=lambda r,g,b:dict(r=r,g=g,b=b,a=1)
a={'quad2':dict(type='QuadMesh',size=dict(x=16,y=16)),'quad3':dict(type='QuadMesh',size=dict(x=.8,y=.8)),'batchMesh3':dict(type='QuadMesh',size=dict(x=.6,y=.6),material='batchSpatial'),
 'batch2':dict(type='MultiMesh',mesh='quad2',dimension=2,count=3,customData=True,visibleCount=1,customAabb=dict(position=dict(x=-16,y=-16,z=-1),size=dict(x=128,y=96,z=2))),
 'batch3':dict(type='MultiMesh',mesh='batchMesh3',dimension=3,count=3,customData=True,visibleCount=1),
 'batchCanvas':dict(type='ShaderMaterial',code='shader_type canvas_item; varying vec4 tint; void vertex(){tint=INSTANCE_CUSTOM;} void fragment(){COLOR=tint;}'),
 'batchSpatial':dict(type='ShaderMaterial',code='shader_type spatial; render_mode unshaded,cull_disabled; varying vec4 tint; void vertex(){tint=INSTANCE_CUSTOM;} void fragment(){ALBEDO=tint.rgb;ALPHA=tint.a;}'),
 'parentMaterial':dict(type='ShaderMaterial',code='shader_type canvas_item; uniform vec4 tint:source_color; void fragment(){COLOR=tint;}',parameters=dict(tint=rgba(1,0,0))),
 'ownMaterial':dict(type='ShaderMaterial',code='shader_type canvas_item; void fragment(){COLOR=vec4(0.0,0.0,1.0,1.0);}'),
 'sheet':dict(type='CanvasItemMaterial',properties=dict(particles_animation=True,particles_anim_h_frames=2,particles_anim_v_frames=2,particles_anim_loop=True,light_mode=1)),
 'flatOne':dict(type='Curve',points=[dict(x=0,y=1),dict(x=1,y=1)]),'flatTexture':dict(type='CurveTexture',curve='flatOne'),
 'flipbookProcess':dict(type='ParticleProcessMaterial',properties=dict(direction=dict(x=1,y=0,z=0),gravity=dict(x=0,y=0,z=0),particle_flag_disable_z=True,initial_velocity_min=0,initial_velocity_max=0,anim_speed_min=20,anim_speed_max=20,anim_speed_curve='flatTexture',anim_offset_min=0,anim_offset_max=0)),
 'path2':dict(type='Curve2D',points=[dict(position=dict(x=0,y=0)),dict(position=dict(x=100,y=0))]),'path3':dict(type='Curve3D',points=[dict(position=dict(x=0,y=0,z=0)),dict(position=dict(x=0,y=0,z=-10))]),'zeroPath':dict(type='Curve2D',points=[dict(position=dict(x=3,y=4)),dict(position=dict(x=3,y=4))]),
 'baseRed':dict(type='StandardMaterial3D',properties=dict(shading_mode=0,albedo_color=rgba(1,0,0))),
 'overlay':dict(type='ShaderMaterial',code='shader_type spatial; render_mode unshaded,cull_disabled; uniform vec4 tint:source_color; void fragment(){ALBEDO=tint.rgb;ALPHA=tint.a;}',parameters=dict(tint=rgba(0,1,0))),
 'deform':dict(type='ShaderMaterial',code='shader_type spatial; render_mode unshaded,cull_disabled; void vertex(){VERTEX.x-=10.0;} void fragment(){ALBEDO=vec3(0.0,1.0,0.0);}')}
collision=[dict(x=-8,y=-8),dict(x=8,y=-8),dict(x=8,y=8),dict(x=-8,y=8)]
a['tileNav']=dict(type='NavigationPolygon',vertices=collision,polygons=[[0,1,2,3]])
a['tiles']=dict(type='TileSet',texture='/assets/tiles.png',tileSize=dict(x=16,y=16),tiles=[dict(x=0,y=0,collision=collision,navigation='tileNav'),dict(x=1,y=0,collision=collision,navigation='tileNav')])
a['sortTiles']=dict(type='TileSet',texture='/assets/sort-tiles.png',tileSize=dict(x=16,y=16),textureRegionSize=dict(x=32,y=16),tiles=[dict(x=0,y=0),dict(x=1,y=0)])
files={'/src/App.tsx':(dest/'refinements-engine.tsx').read_text(),'/assets/refinements.resources.json':json.dumps(dict(version=1,assets=a),indent=2),'/assets/ui.ttf':list((root.parents[1]/'tests/react/showcase/fixtures/ui-subset.ttf').read_bytes()),'/assets/mask.png':png(16,16,lambda x,y:(255,255,255,255 if (x-7.5)**2+(y-7.5)**2<49 else 0)),'/assets/sheet.png':png(32,32,lambda x,y:[(255,0,0,255),(0,255,0,255),(0,0,255,255),(255,255,0,255)][(y//16)*2+x//16]),'/assets/tiles.png':png(32,16,lambda x,y:(255,0,0,255) if x<16 else (0,255,0,255)),'/assets/sort-tiles.png':png(64,16,lambda x,y:(255,0,0,255) if x<32 else (0,255,0,255)),
 '/assets/sort.scene.json':json.dumps(dict(type='Node2D',props=dict(name='YSort',position=dict(x=40,y=0),ySortEnabled=True),children=[dict(type='TileMapLayer',props=dict(name='Back',tileSet=dict(asset='tiles'),ySortEnabled=True,ySortOrigin=-10)),dict(type='TileMapLayer',props=dict(name='Front',tileSet=dict(asset='tiles'),ySortEnabled=True,ySortOrigin=10))])),
 '/assets/native.tscn':'[gd_scene format=3]\n[node name="Native" type="Node2D"]\nposition = Vector2(2000,0)\nuse_parent_material = true\n[node name="EditorNative" type="CodeEdit" parent="."]\nline_folding = true\ngutters_draw_fold_gutter = true\nminimap_draw = true\nminimap_width = 48\ntext = "root:\\n  child"\n[node name="RichNative" type="RichTextLabel" parent="."]\nbbcode_enabled = true\ntext = "[table=2][cell]甲[/cell][cell]乙[/cell][/table]"\n[node name="MapNative" type="TileMapLayer" parent="."]\nenabled = false\nuse_kinematic_bodies = true\ny_sort_origin = 10\nphysics_quadrant_size = 1\n',
 '/README.md':'Exercises isolated MultiMesh visibility/custom data/bounds; real CanvasItem alpha masks and parent materials; native CPU/GPU sprite-sheet animation; TileMap rendering/collision/navigation enable and movement, quadrant and sorting; bounded 2D/3D curve sampling; overlay shaders and geometry bounds; CodeEdit native gutter/folding/search/editing; structured rich tables/lists/selection/hints. Browser development, production, development gates use real pixels/input and Stop cleanup.'}
(dest/'refinements-engine.project.json').write_text(json.dumps(dict(schemaVersion=1,demoId='shader',entry='/src/App.tsx',selected='/src/App.tsx',mode='development',controls=dict(renderPixels=1),files=files),indent=2)+'\n')
