from pathlib import Path
import json, struct, zlib
root=Path(__file__).resolve().parents[3];dest=root/'tests/react/showcase/projects'
def v(x,y,z=0):return dict(x=x,y=y,z=z)
def chunk(name,data):return struct.pack('>I',len(data))+name+data+struct.pack('>I',zlib.crc32(name+data)&0xffffffff)
row=bytes([0])+bytes([255,0,0,255])*3+bytes([0,255,0,255])*3
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',6,2,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(row*2))+chunk(b'IEND',b'')
assets={
 'dot2':{'type':'RectangleShape2D','properties':{'size':dict(x=4,y=4)}},'wall2':{'type':'RectangleShape2D','properties':{'size':dict(x=1,y=40)}},'area2':{'type':'RectangleShape2D','properties':{'size':dict(x=30,y=50)}},
 'dot3':{'type':'BoxShape3D','properties':{'size':v(.3,.3,.3)}},'wall3':{'type':'BoxShape3D','properties':{'size':v(.1,4,4)}},'area3':{'type':'BoxShape3D','properties':{'size':v(2,5,5)}},
 'greenAtlas':{'type':'AtlasTexture','atlas':'/assets/palette.png','region':[3,0,3,2],'filterClip':True},
 'audio':{'type':'AudioBusLayout','buses':[{'name':'Music','effects':[{'type':'AudioEffectReverb','properties':{'wet':.2}},{'type':'AudioEffectLowPassFilter','properties':{'cutoff_hz':1000}},{'type':'AudioEffectCompressor','properties':{'threshold':-12}},{'type':'AudioEffectLimiter','properties':{'ceiling_db':-1}}]}]},
 'triangle':{'type':'ArrayMesh','surfaces':[{'vertices':[v(-1,-1),v(1,-1),v(0,1)],'normals':[v(0,0,1)]*3,'uvs':[dict(x=0,y=1),dict(x=1,y=1),dict(x=.5,y=0)],'indices':[0,2,1],'material':'green'}]},
}
for name,color in [('red',(1,.1,.1)),('green',(.1,1,.1)),('blue',(.1,.3,1))]:assets[name]={'type':'StandardMaterial3D','properties':{'albedo_color':dict(zip(['r','g','b','a'],[*color,1])),'shading_mode':0}}
for d in [2,3]:
 points=[dict(x=0,y=0),dict(x=2,y=0),dict(x=0,y=2)] if d==2 else [v(0,0,0),v(1,0,0),v(0,1,0),v(0,0,1)]
 assets['convex'+str(d)]={'type':'ConvexPolygonShape'+str(d)+'D','points':points}
 assets['concave'+str(d)]={'type':'ConcavePolygonShape'+str(d)+'D',('segments' if d==2 else 'faces'):points[:2 if d==2 else 3]}
 assets['boundary'+str(d)]={'type':'WorldBoundaryShape'+str(d)+'D','normal':dict(x=0,y=-1) if d==2 else v(0,1,0),'distance':0}
 assets['separation'+str(d)]={'type':'SeparationRayShape'+str(d)+'D','length':2,'slideOnSlope':True}
scene={'type':'Node2D','props':{'position':dict(x=760,y=300)},'children':[{'type':'Polygon2D','props':{'polygon':[dict(x=0,y=0),dict(x=70,y=0),dict(x=35,y=50)],'color':dict(r=.2,g=1,b=.4,a=1)}},{'type':'Sprite2D','props':{'position':dict(x=30,y=70),'texture':{'asset':'/assets/palette.png'},'regionEnabled':True,'regionRect':{'position':dict(x=3,y=0),'size':dict(x=1,y=1)},'scale':dict(x=40,y=40)}}]}
files={'/src/App.tsx':(dest/'gameplay-engine.tsx').read_text(),'/assets/gameplay.resources.json':json.dumps({'version':1,'assets':assets},indent=2),'/assets/palette.png':list(png),'/geometry.scene.json':json.dumps(scene),'/README.md':'Type J in the input field: only the text and raw input counter should change. Press Escape, click empty preview space and press J: the unhandled game action should fire. Click the offscreen button. The scene exercises collision DTOs, CCD, coordinate transforms, sprite atlases, polygon drawing/collision, scroll/focus controls, ArrayMesh surface isolation and scoped audio effect parameters.'}
project={'schemaVersion':1,'demoId':'shader','entry':'/src/App.tsx','selected':'/src/App.tsx','mode':'development','controls':{'renderPixels':1},'files':files};(dest/'gameplay-engine.project.json').write_text(json.dumps(project,indent=2)+'\n')
