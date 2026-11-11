from pathlib import Path
import json,struct,zlib,binascii
root=Path(__file__).resolve().parents[3];dest=root/'tests/react/showcase/projects'
def png(width,height,pixel):
 def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',binascii.crc32(kind+data)&0xffffffff)
 return list(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(b'\0'+b''.join(bytes(pixel(x,y)) for x in range(width)) for y in range(height))))+chunk(b'IEND',b''))
rgba=lambda r,g,b:dict(r=r,g=g,b=b,a=1)
a={'gray':{'type':'Gradient','points':[dict(offset=0,color=rgba(0,0,0)),dict(offset=1,color=rgba(1,1,1))]},'initialGreen':{'type':'Gradient','points':[dict(offset=0,color=rgba(0,1,0)),dict(offset=1,color=rgba(0,1,0))]},'initialGreenTexture':{'type':'GradientTexture1D','gradient':'initialGreen'},'zero':{'type':'Curve','points':[dict(x=0,y=0),dict(x=1,y=0)]},'zeroTexture':{'type':'CurveTexture','curve':'zero'},'alphaMask':{'type':'BitMap','image':'/assets/mask.png','alphaThreshold':.5},'particleMaterial':{'type':'StandardMaterial3D','properties':{'shading_mode':0,'vertex_color_use_as_albedo':True}},'particleQuad':{'type':'QuadMesh','size':dict(x=.3,y=.3),'material':'particleMaterial'},'sections':{'type':'AnimationLibrary','animations':{'move':{'length':1,'tracks':[{'path':'Mover:position','keys':[[0,dict(x=0,y=0)],[1,dict(x=100,y=0)]]}]}}}}
a['edgeMask']={'type':'BitMap','image':'/assets/edge.png','alphaThreshold':119/255-1e-10}
for name,fill,repeat in [('linear2d',0,0),('radial2d',1,0),('square2d',2,0),('repeat2d',0,1),('mirror2d',0,2)]:
 a[name]={'type':'GradientTexture2D','gradient':'gray','width':32,'height':32,'fill':fill,'repeat':repeat,'fillFrom':dict(x=.5,y=.5) if fill else dict(x=0,y=0),'fillTo':dict(x=1,y=1) if fill else dict(x=.25 if repeat else 1,y=0)}
p={'direction':dict(x=1,y=0,z=0),'gravity':dict(x=0,y=0,z=0),'particle_flag_disable_z':True,'color_initial_ramp':'initialGreenTexture'}
for n,v in [('radial_accel',4),('tangential_accel',2),('orbit_velocity',.2),('hue_variation',.5),('angle',15)]:p[n+'_min']=v;p[n+'_max']=v;p[n+'_curve']='zeroTexture'
a['fidelityParticles']={'type':'ParticleProcessMaterial','properties':p}
for d in [2,3]:
 vertices=[]
 for x in range(11):
  for y in [0,1]:vertices.append(dict(x=x,y=0,z=y) if d==3 else dict(x=x*10,y=y*10))
 a['search'+str(d)]={'type':'NavigationPolygon' if d==2 else 'NavigationMesh','vertices':vertices,'polygons':[[2*i,2*i+2,2*i+3,2*i+1] for i in range(10)]}
files={'/src/App.tsx':(dest/'fidelity-engine.tsx').read_text(),'/assets/gameplay.resources.json':json.dumps({'version':1,'assets':a},indent=2),'/assets/mask.png':png(16,8,lambda x,y:(255,255,255,255 if x<8 else 0)),'/assets/edge.png':png(1,1,lambda x,y:(255,255,255,119)),'/assets/white.png':png(8,8,lambda x,y:(255,255,255,255)),'/assets/checker.png':png(2,2,lambda x,y:[[(255,0,0,255),(0,255,0,255)],[(0,0,255,255),(255,255,255,255)]][y][x]),'/assets/mask.tres':'[gd_resource type="BitMap" format=3]\n[resource]\ndata = {"size":Vector2i(3,1),"data":PackedByteArray(6)}\n','/assets/gradient.tres':'[gd_resource type="GradientTexture2D" load_steps=2 format=3]\n[sub_resource type="Gradient" id="g"]\n[resource]\ngradient = SubResource("g")\nwidth = 16\nheight = 16\nfill = 2\nrepeat = 1\n','/README.md':'Automatic native and rendered checks cover Control clipping, RTL/stretch layout, size notifications without feedback loops, bounded animation sections, camera alignment/rotation/limits and depth projection, 2D gradients, alpha bitmap input masks, CPU/GPU particle parameters and colors, bounded navigation search/clipped paths, and Polygon2D/Line2D drawing. Click the right transparent half of the white button (ignored), then its left half (one press).'}
project=dict(schemaVersion=1,demoId='shader',entry='/src/App.tsx',selected='/src/App.tsx',mode='development',controls={'renderPixels':1},files=files)
(dest/'fidelity-engine.project.json').write_text(json.dumps(project,indent=2)+'\n')
