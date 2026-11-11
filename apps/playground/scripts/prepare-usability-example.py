from pathlib import Path
import json,struct,zlib,binascii,math
root=Path(__file__).resolve().parents[3];dest=root/'tests/react/showcase/projects';old=json.loads((dest/'presentation-engine.project.json').read_text())
def png(w,h,pixel):
 def chunk(k,d):return struct.pack('>I',len(d))+k+d+struct.pack('>I',binascii.crc32(k+d)&0xffffffff)
 return list(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(b'\0'+b''.join(bytes(pixel(x,y)) for x in range(w)) for y in range(h))))+chunk(b'IEND',b''))
a={'area2':{'type':'RectangleShape2D','properties':{'size':dict(x=128,y=128)}},'area3':{'type':'BoxShape3D','properties':{'size':dict(x=8,y=8,z=8)}},'quad':{'type':'QuadMesh','size':dict(x=1,y=1)},'largeQuad':{'type':'QuadMesh','size':dict(x=1.5,y=1.5)},'mix':{'type':'AudioBusLayout','buses':[{'name':'Dry'},{'name':'Room2'},{'name':'Room3'},{'name':'Verb','effects':[{'type':'AudioEffectReverb','properties':{'dry':0,'wet':1}}]}]}}
pcm=[]
for i in range(800):
 v=int(math.sin(i*math.tau*440/8000)*8000);pcm.extend(struct.pack('<h',v))
a['tone']={'type':'AudioStreamWAV','format':1,'stereo':False,'mixRate':8000,'data':pcm,'loopMode':1,'loopBegin':0,'loopEnd':800}
def mat(name,**props):a[name]={'type':'StandardMaterial3D','properties':{'shading_mode':0,**props}}
mat('cut',albedo_texture='/assets/alpha.png',transparency=2,alpha_scissor_threshold=.5,texture_filter=0)
mat('hash',albedo_color=dict(r=0,g=1,b=0,a=.5),transparency=3,alpha_hash_scale=1)
mat('red',albedo_color=dict(r=1,g=0,b=0,a=1))
mat('depth',albedo_color=dict(r=0,g=1,b=0,a=1),depth_draw_mode=2)
mat('noDepth',albedo_color=dict(r=0,g=1,b=0,a=1),no_depth_test=True,depth_draw_mode=2)
mat('blue',albedo_color=dict(r=0,g=0,b=1,a=1))
mat('billboard',albedo_color=dict(r=0,g=0,b=1,a=1),billboard_mode=1,billboard_keep_scale=True)
files={'/src/App.tsx':(dest/'usability-engine.tsx').read_text(),'/assets/gameplay.resources.json':json.dumps({'version':1,'assets':a},indent=2),'/assets/ui.ttf':old['files']['/assets/ui.ttf'],'/assets/white.png':png(8,8,lambda x,y:(255,255,255,255)),'/assets/blue.png':png(8,8,lambda x,y:(0,0,255,255)),'/assets/alpha.png':png(2,1,lambda x,y:(0,255,0,64 if x==0 else 192)),'/assets/material.tres':'[gd_resource type="StandardMaterial3D" format=3]\n[resource]\ntransparency = 2\nalpha_scissor_threshold = 0.3\ndepth_draw_mode = 2\nbillboard_mode = 1\nbillboard_keep_scale = true\n','/README.md':'Automatic checks cover bounded rich text, Unicode/selection/reveal, registered images and safe mode switching; Range ratio/page/rounding; form editing; CanvasGroup opacity; SubViewport clear/override behavior; Root-local area audio routing and 3D material visibility. Click OPEN, clear the editor, edit the HP SpinBox, drag the slider and scrollbars, click the small viewport button, then Start audio. Audio levels are measured in scoped native buses.'}
files['/assets/audio-shape.tres']='[gd_resource type="RectangleShape2D" format=3]\n[resource]\nsize = Vector2(128,128)\n'
files['/assets/routing.tscn']='[gd_scene load_steps=2 format=3]\n[ext_resource type="RectangleShape2D" path="res://assets/audio-shape.tres" id="shape"]\n[node name="Routing" type="Node2D"]\n[node name="Room" type="Area2D" parent="."]\naudio_bus_name = &"Room2"\naudio_bus_override = true\ncollision_layer = 1\ncollision_mask = 0\n[node name="Shape" type="CollisionShape2D" parent="Room"]\nshape = ExtResource("shape")\n'
(dest/'usability-engine.project.json').write_text(json.dumps(dict(schemaVersion=1,demoId='shader',entry='/src/App.tsx',selected='/src/App.tsx',mode='development',controls={'renderPixels':1},files=files),indent=2)+'\n')
