"""Deterministic tiny skinned glTF fixture; all bytes are embedded and locally authored."""
import json, struct, sys
from pathlib import Path
binary=bytearray(); views=[]; accessors=[]
def add(data, component, kind, count, **extra):
 while len(binary)%4: binary.append(0)
 offset=len(binary);binary.extend(data);view=len(views);views.append({'buffer':0,'byteOffset':offset,'byteLength':len(data)})
 accessor=len(accessors);accessors.append({'bufferView':view,'componentType':component,'count':count,'type':kind,**extra});return accessor
floats=lambda values:struct.pack('<'+'f'*len(values),*values)
pos=add(floats([-.5,0,0,.5,0,0,0,1,0]),5126,'VEC3',3,min=[-.5,0,0],max=[.5,1,0])
normal=add(floats([0,0,1]*3),5126,'VEC3',3)
joints=add(struct.pack('<12H',*([0]*12)),5123,'VEC4',3)
weights=add(floats([1,0,0,0]*3),5126,'VEC4',3)
indices=add(struct.pack('<3H',0,1,2),5123,'SCALAR',3)
bind=add(floats([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),5126,'MAT4',1)
times=add(floats([0,1]),5126,'SCALAR',2,min=[0],max=[1])
translations=add(floats([0,0,0,1,0,0]),5126,'VEC3',2)
doc={'asset':{'version':'2.0','generator':'GodotAI test fixture'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'name':'RiggedModel','children':[1,2]},{'name':'RootBone'},{'name':'Mesh','mesh':0,'skin':0}], 'meshes':[{'primitives':[{'attributes':{'POSITION':pos,'NORMAL':normal,'JOINTS_0':joints,'WEIGHTS_0':weights},'indices':indices}]}],'skins':[{'name':'Rig','joints':[1],'skeleton':1,'inverseBindMatrices':bind}],'animations':[{'name':'Wave','samplers':[{'input':times,'output':translations,'interpolation':'LINEAR'}],'channels':[{'sampler':0,'target':{'node':1,'path':'translation'}}]}],'buffers':[{'byteLength':len(binary)}],'bufferViews':views,'accessors':accessors}
morph='--morph' in sys.argv
if morph:
 delta=add(floats([0,0,0,0,0,0,0,.5,0]),5126,'VEC3',3)
 weight_keys=add(floats([0,1]),5126,'SCALAR',2)
 doc['meshes'][0]['primitives'][0]['targets']=[{'POSITION':delta}]
 doc['meshes'][0]['weights']=[0]
 doc['meshes'][0]['extras']={'targetNames':['Smile']}
 doc['animations'].append({'name':'Smile','samplers':[{'input':times,'output':weight_keys,'interpolation':'LINEAR'}],'channels':[{'sampler':0,'target':{'node':2,'path':'weights'}}]})
 doc['buffers'][0]['byteLength']=len(binary)
js=json.dumps(doc,separators=(',',':')).encode();js+=b' '*((-len(js))%4);binary+=b'\0'*((-len(binary))%4)
output=struct.pack('<III',0x46546c67,2,12+8+len(js)+8+len(binary))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(binary),0x004e4942)+binary
Path(__file__).with_name('morph.glb' if morph else 'rigged.glb').write_bytes(output)
