from pathlib import Path
import json
root=Path(__file__).resolve().parents[3];dest=root/'apps/playground/examples';base=json.loads((dest/'scene-details-engine.project.json').read_text());assets=json.loads(base['files']['/assets/gameplay.resources.json'])['assets']
assets.update({'contact2':{'type':'RectangleShape2D','properties':{'size':dict(x=8,y=8)}},'contact3':{'type':'BoxShape3D','properties':{'size':dict(x=.8,y=.8,z=.8)}}})
for space in range(3):
 assets['gradient'+str(space)]={'type':'Gradient','interpolationColorSpace':space,'points':[{'offset':0,'color':dict(r=1,g=0,b=0,a=1)},{'offset':1,'color':dict(r=0,g=1,b=0,a=1)}]}
 assets['gradient'+str(space)+'Texture']={'type':'GradientTexture1D','gradient':'gradient'+str(space),'width':64}
base['files']['/assets/free-curve.tres']='[gd_resource type="Curve" format=3]\n[resource]\n_limits = [0.0,1.0,0.0,1.0]\n_data = [Vector2(0,0),0.0,2.0,1,0,Vector2(1,1),0.0,0.0,0,1]\n'
base['files']['/assets/free-gradient.tres']='[gd_resource type="Gradient" format=3]\n[resource]\ninterpolation_color_space = 2\noffsets = PackedFloat32Array(0,1)\ncolors = PackedColorArray(1,0,0,1,0,1,0,1)\n'
base['files']['/src/App.tsx']=(dest/'precision-engine.tsx').read_text();base['files']['/assets/gameplay.resources.json']=json.dumps({'version':1,'assets':assets},indent=2);base['files']['/README.md']='Hold/release each button, drag the textured button outside while held, right-click the masked button, activate Release with Space, touch the Touch button and drag inside the scroller. Native checks cover free Curve tangents, three Gradient color spaces, sanitized shape contacts and owner lifetime in 2D/3D, rigid contact signals, ray shape indices, scoped scroll targets and navigation avoidance height/3D/Y/forced-velocity behavior.'
(dest/'precision-engine.project.json').write_text(json.dumps(base,indent=2)+'\n')
