from pathlib import Path
import json,struct,zlib,binascii
root=Path(__file__).resolve().parents[1];dest=root.parents[1]/'tests/react/showcase/projects'
old=json.loads((dest/'usability-engine.project.json').read_text())
def png(w,h,pixel):
 def chunk(k,b):return struct.pack('>I',len(b))+k+b+struct.pack('>I',binascii.crc32(k+b)&0xffffffff)
 raw=b''.join(b'\0'+bytes(v for x in range(w) for v in pixel(x,y)) for y in range(h))
 return list(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))
blue=dict(r=0,g=0,b=1,a=1);black=dict(r=0,g=0,b=0,a=1);green=dict(r=0,g=1,b=0,a=1)
a={
 'procedural':dict(type='ProceduralSkyMaterial',properties=dict(sky_top_color=blue,sky_horizon_color=blue,ground_bottom_color=blue,ground_horizon_color=blue,sky_energy_multiplier=1,ground_energy_multiplier=1,use_debanding=False)),
 'proceduralSky':dict(type='Sky',properties=dict(sky_material='procedural',radiance_size=0)),
 'proceduralEnv':dict(type='Environment',properties=dict(background_mode=2,sky='proceduralSky')),
 'panoramaMaterial':dict(type='PanoramaSkyMaterial',properties=dict(panorama='/assets/panorama.png',filter=False)),
 'panoramaSky':dict(type='Sky',properties=dict(sky_material='panoramaMaterial',radiance_size=0)),
 'panoramaA':dict(type='Environment',properties=dict(background_mode=2,sky='panoramaSky',sky_rotation=dict(x=0,y=0,z=0))),
 'panoramaB':dict(type='Environment',properties=dict(background_mode=2,sky='panoramaSky',sky_rotation=dict(x=0,y=3.14159265,z=0))),
 'depthFog':dict(type='Environment',properties=dict(background_mode=1,background_color=black,fog_enabled=True,fog_mode=1,fog_light_color=green,fog_light_energy=1,fog_depth_begin=1,fog_depth_end=3,fog_depth_curve=1)),
 'heightA':dict(type='Environment',properties=dict(background_mode=1,background_color=black,fog_enabled=True,fog_density=0,fog_height=3,fog_height_density=0,fog_light_color=green)),
 'heightB':dict(type='Environment',properties=dict(background_mode=1,background_color=black,fog_enabled=True,fog_density=0,fog_height=3,fog_height_density=2,fog_light_color=green)),
 'black':dict(type='Environment',properties=dict(background_mode=1,background_color=black)),
 'red':dict(type='StandardMaterial3D',properties=dict(shading_mode=0,albedo_color=dict(r=1,g=0,b=0,a=1))),
 'quad':dict(type='QuadMesh',size=dict(x=4,y=4))
}
files={'/src/App.tsx':(dest/'composition-engine.tsx').read_text(),'/assets/composition.resources.json':json.dumps(dict(version=1,assets=a),indent=2),'/assets/ui.ttf':old['files']['/assets/ui.ttf'],'/assets/blue.png':png(8,8,lambda x,y:(0,0,255,255)),'/assets/panorama.png':png(64,32,lambda x,y:(255,0,0,255) if x<32 else (0,0,255,255)),
 '/assets/ui.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Texture2D" path="res://assets/blue.png" id="icon"]\n[node name="Imported" type="HSplitContainer"]\nposition = Vector2(2000,2000)\n[node name="Text" type="TextEdit" parent="."]\ntext = "Native\\nUnicode 你好"\neditable = false\n[node name="Items" type="ItemList" parent="."]\nselect_mode = 1\nitem_count = 2\nitem_0/text = "Native item"\nitem_0/icon = ExtResource("icon")\nitem_1/text = "Disabled"\nitem_1/disabled = true\n[node name="Tabs" type="TabContainer" parent="."]\n[node name="One" type="Control" parent="Tabs"]\n[node name="Two" type="Control" parent="Tabs"]\n',
 '/README.md':'Exercises native multiline selection/caret/undo, real typing, read-only state, icon lists/multi-select/activation, native split dragging and flow relayout, tab metadata/disabled/hidden/removal, canvas layer masks with ancestor rules, procedural and panorama skies, depth/height fog, and distance/hysteresis culling. Real pixel gates and verified Stop cleanup run in development, production, development.'}
(dest/'composition-engine.project.json').write_text(json.dumps(dict(schemaVersion=1,demoId='shader',entry='/src/App.tsx',selected='/src/App.tsx',mode='development',controls={'renderPixels':1},files=files),indent=2)+'\n')
