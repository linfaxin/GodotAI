from pathlib import Path
import json
r=Path(__file__).resolve().parents[3];p=r/'tests/react/showcase/projects';base=json.loads((p/'completion-engine.project.json').read_text())
def v(x,y,z=0):return dict(x=x,y=y,z=z)
a={
 'box':{'type':'BoxMesh','properties':{'size':v(.4,.4,.4)}},'batch':{'type':'MultiMesh','mesh':'box','dimension':3,'count':1},
 'point2':{'type':'RectangleShape2D','properties':{'size':dict(x=2,y=2)}},'long2':{'type':'RectangleShape2D','properties':{'size':dict(x=20,y=2)}},
 'point3':{'type':'BoxShape3D','properties':{'size':v(2,2,2)}},'long3':{'type':'BoxShape3D','properties':{'size':v(20,2,2)}},'rubber':{'type':'PhysicsMaterial','properties':{'friction':.5,'bounce':.4}},
 'audio':{'type':'AudioBusLayout','buses':[{'name':'Music','volumeDb':-6,'effects':[{'type':'AudioEffectReverb','properties':{'wet':.2,'dry':1,'room_size':.6}}]}]},
 'clips':{'type':'AnimationLibrary','animations':{name:{'length':.2,'tracks':[{'path':'Mover:position','keys':[[0,dict(x=x,y=0)],[.2,dict(x=x,y=0)]]}]} for name,x in [('idle',0),('move',10)]}},
 'machine':{'type':'AnimationNodeStateMachine','stateMachineType':1,'states':{'Idle':{'type':'animation','animation':'idle'},'Move':{'type':'animation','animation':'move'}},'entry':'Idle','transitions':[{'from':'Idle','to':'Move'}]},
 'nested':{'type':'AnimationNodeBlendTree','nodes':{'Locomotion':{'asset':'machine'}},'connections':[['output',0,'Locomotion']]},
}
for dim in [2,3]:
 for side,(left,right) in [('Left',(0,10 if dim==2 else 2)),('Right',(30 if dim==2 else 6,40 if dim==2 else 8))]:
  z=10 if dim==2 else 2
  points=[dict(x=left,y=0),dict(x=right,y=0),dict(x=right,y=z),dict(x=left,y=z)] if dim==2 else [v(left,0,0),v(right,0,0),v(right,0,z),v(left,0,z)]
  a['nav'+side+str(dim)]={'type':'NavigationPolygon' if dim==2 else 'NavigationMesh','vertices':points,'polygons':[[0,1,2,3]]}
files={'/src/App.tsx':(p/'parity-engine.tsx').read_text(),'/assets/parity.resources.json':json.dumps({'version':1,'assets':a},indent=2),'/assets/morph.glb':list((r/'tests/react/showcase/fixtures/morph.glb').read_bytes()),'/assets/tone.ogg':base['files']['/assets/tone.ogg'],'/assets/ui.ttf':base['files']['/assets/ui.ttf'],'/DejaVu-LICENSE.txt':base['files']['/DejaVu-LICENSE.txt'],'/README.md':'Focus the preview and press Ctrl+J. Interact with the checkbox, dropdown, stepped inputs and tabs. Two red panels render the same SubViewport through a managed path and a scoped texture AssetRef. The scene also exercises safe joint removal/recreation, rotated/excluded queries, motion casts, nested state machines, morph animation, isolated MultiMesh instances, audio buses and linked navigation. DejaVu font license is included.'}
base.update(files=files,controls={'renderPixels':1});(p/'parity-engine.project.json').write_text(json.dumps(base,indent=2)+'\n')
