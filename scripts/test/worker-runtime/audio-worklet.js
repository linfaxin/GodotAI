class BufferAudioProbe extends AudioWorkletProcessor{
 constructor(){super();this.blocks=[];this.offset=0;this.rendered=0;this.energy=0;this.port.onmessage=({data})=>{if(data.port){this.source=data.port;this.source.onmessage=({data:block})=>{if(block instanceof Float32Array)this.blocks.push(block);};this.source.start();}};}
 process(inputs,outputs){const out=outputs[0][0];for(let i=0;i<out.length;i++){if(this.blocks.length){const block=this.blocks[0],value=block[this.offset++];out[i]=value;this.energy+=value*value;this.rendered++;if(this.offset===block.length){this.blocks.shift();this.offset=0;}}}if(this.rendered>=4096&&!this.reported){this.reported=true;this.port.postMessage({type:'audio-rendered',frames:this.rendered,energy:this.energy});}return true;}
}
registerProcessor('buffer-audio-probe',BufferAudioProbe);
