from pathlib import Path
import json
root=Path(__file__).resolve().parents[3];dest=root/'tests/react/showcase/projects'
base=json.loads((dest/'gameplay-engine.project.json').read_text());assets=json.loads(base['files']['/assets/gameplay.resources.json'])['assets'];nav=json.loads(json.loads((dest/'parity-engine.project.json').read_text())['files']['/assets/parity.resources.json'])['assets']
for key in ['navLeft2','navRight2','navLeft3','navRight3']:assets[key]=nav[key]
def v(x,y,z=0):return dict(x=x,y=y,z=z)
assets.update({
 'platform2':{'type':'RectangleShape2D','properties':{'size':dict(x=80,y=8)}},'rider2':{'type':'RectangleShape2D','properties':{'size':dict(x=8,y=12)}},'platform3':{'type':'BoxShape3D','properties':{'size':v(4,.3,4)}},'rider3':{'type':'BoxShape3D','properties':{'size':v(.3,.6,.3)}},
 'field2':{'type':'RectangleShape2D','properties':{'size':dict(x=100,y=100)}},'field3':{'type':'BoxShape3D','properties':{'size':v(10,10,10)}},
 'gradient':{'type':'Gradient','points':[{'offset':0,'color':dict(r=1,g=0,b=0,a=1)},{'offset':1,'color':dict(r=0,g=1,b=0,a=1)}]},'scaleCurve':{'type':'Curve','points':[dict(x=0,y=1),dict(x=1,y=.5)]},'gradientTexture':{'type':'GradientTexture1D','gradient':'gradient','width':32},
 'whiteGradient':{'type':'Gradient','points':[{'offset':0,'color':dict(r=1,g=1,b=1,a=1)},{'offset':1,'color':dict(r=1,g=1,b=1,a=1)}]},'whiteTexture':{'type':'GradientTexture1D','gradient':'whiteGradient','width':1},
 'panelMesh':{'type':'BoxMesh','properties':{'size':v(1.8,1.8,.1)}},'particleMesh':{'type':'BoxMesh','properties':{'size':v(.1,.1,.1)}}
})
uniforms='uniform vec4 tint : source_color = vec4(1.0);\nuniform float gain = 1.0;\nuniform bool enabled = true;\nuniform int mode = 0;\nuniform vec2 shift = vec2(0.0);\nuniform vec3 direction = vec3(0.0,0.0,1.0);\nuniform sampler2D image : filter_nearest;\n'
for kind in ['canvas','spatial']:
 prefix='shader_type canvas_item;\n' if kind=='canvas' else 'shader_type spatial;\nrender_mode unshaded;\n'
 output='COLOR = vec4(rgb,tint.a);' if kind=='canvas' else 'ALBEDO = rgb;'
 code=prefix+uniforms+'void fragment(){vec3 rgb=tint.rgb*gain+direction*0.0;if(mode==1){rgb*=texture(image,UV+shift).rgb;}if(!enabled){rgb=vec3(0.0);}'+output+'}\n'
 assets[kind+'Shader']={'type':'ShaderMaterial','code':code,'parameters':{'tint':dict(r=1,g=1,b=1,a=1),'gain':1,'enabled':True,'mode':0,'shift':dict(x=0,y=0),'direction':v(0,0,1),'image':{'asset':'gradientTexture'}}}
base['files']['/src/App.tsx']=(dest/'behaviors-engine.tsx').read_text();base['files']['/assets/gameplay.resources.json']=json.dumps({'version':1,'assets':assets},indent=2);base['files']['/README.md']='Click the yellow marker and press F. The program verifies moving platforms, gravity areas, managed collision exceptions, camera coordinate mapping, isolated shader parameters, camera cull masks, CPU particle gradients/curves, full navigation paths and concurrent appearance/value/volume/transform Tweens. The two 3D previews share a World3D and render different layers.'
(dest/'behaviors-engine.project.json').write_text(json.dumps(base,indent=2)+'\n')
