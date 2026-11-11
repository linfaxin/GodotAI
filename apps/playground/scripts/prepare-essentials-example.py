from pathlib import Path
import json,struct,zlib,binascii,math
root=Path(__file__).resolve().parents[3];dest=root/'tests/react/showcase/projects';base=json.loads((dest/'behaviors-engine.project.json').read_text());assets=json.loads(base['files']['/assets/gameplay.resources.json'])['assets'];completion=json.loads((dest/'completion-engine.project.json').read_text());base['files']['/assets/ui.ttf']=completion['files']['/assets/ui.ttf'];base['files']['/DejaVu-LICENSE.txt']=completion['files']['/DejaVu-LICENSE.txt']
def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',binascii.crc32(kind+data)&0xffffffff)
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',16,16,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(b'\x00'+b'\xff'*64 for _ in range(16))))+chunk(b'IEND',b'');base['files']['/assets/white.png']=list(png)
assets['flatCurve']={'type':'Curve','points':[{'x':0,'y':1},{'x':1,'y':1}]}
for name,r,g,b in [('normal',.15,.3,.45),('hover',.2,.5,.7),('pressed',.6,.2,.15),('disabled',.2,.2,.2),('focus',.5,.7,.3)]:assets[name]={'type':'StyleBoxFlat','properties':{'bg_color':dict(r=r,g=g,b=b,a=1)}}
data=[]
for i in range(800):data.extend(struct.pack('<h',int(math.sin(i*2*math.pi*220/8000)*2000)))
for name,mode in [('loop',1),('shot',0)]:assets[name]={'type':'AudioStreamWAV','format':1,'stereo':False,'mixRate':8000,'data':data,'loopMode':mode,'loopBegin':0,'loopEnd':800}
base['files']['/assets/gameplay.resources.json']=json.dumps({'version':1,'assets':assets},indent=2);base['files']['/src/App.tsx']=(dest/'essentials-engine.tsx').read_text();base['files']['/README.md']='Press F to focus the label; click First then press Tab to verify focusNext; press P to test looping audio and one-shot completion. Automatic checks cover inherited commands, process modes, physics/idle timers, body constraints/damping, native containers, icons/styles, Sprite3D/Label3D pixels, screen notifications, particle curves, line gradient pixels and audio configuration/cleanup.'
(dest/'essentials-engine.project.json').write_text(json.dumps(base,indent=2)+'\n')
