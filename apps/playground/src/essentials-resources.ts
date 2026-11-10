const fail=(message:string):never=>{throw Error('E_ESSENTIAL_RESOURCE: '+message);};
function integer(value:any,min:number,max:number){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)fail('Integer out of range');return value as number;}
/** Raw PCM and loop positions use sample frames, independently of channel count. */
export function serializeWaveform(sound:any):string[]{
 if(!sound||typeof sound!=='object'||Array.isArray(sound)||Object.keys(sound).some(k=>!['type','format','stereo','mixRate','data','loopMode','loopBegin','loopEnd'].includes(k)))fail('Invalid waveform fields');
 const format=integer(sound.format,0,1),rate=integer(sound.mixRate,8000,192000);if(typeof sound.stereo!=='boolean'||!Array.isArray(sound.data)||!sound.data.length||sound.data.length>1048576)fail('Invalid PCM data');sound.data.forEach((v:any)=>integer(v,0,255));const stride=(format?2:1)*(sound.stereo?2:1);if(sound.data.length%stride)fail('Incomplete PCM frame');const frames=sound.data.length/stride,mode=integer(sound.loopMode??0,0,3),begin=integer(sound.loopBegin??0,0,frames),end=integer(sound.loopEnd??frames,0,frames);if(mode&&begin>=end)fail('Empty or reversed loop');
 return [`format = ${format}`,`stereo = ${sound.stereo}`,`mix_rate = ${rate}`,`data = PackedByteArray(${sound.data.join(',')})`,`loop_mode = ${mode}`,`loop_begin = ${begin}`,`loop_end = ${end}`];
}
