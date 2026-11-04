const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function setup(){
  let Processor;const messages=[];
  class AudioWorkletProcessor{constructor(){this.port={postMessage:value=>messages.push(value)};}}
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/audio-worklet.js'),'utf8'),{AudioWorkletProcessor,Float32Array,registerProcessor:(_name,value)=>{Processor=value;}});
  const processor=new Processor();
  const run=()=>{const output=new Float32Array(1600).fill(1);processor.process([[new Float32Array(1600).fill(.2)],[new Float32Array(1600).fill(.4)]],[[output]]);assert.ok(output.every(value=>value===0));return messages.at(-1);};
  return {processor,run};
}
test('worklet applies independent gains, microphone mute and zero-sample pause without feedback',()=>{
 const {processor,run}=setup();
 processor.port.onmessage({data:{micGain:2,systemGain:.5}});assert.ok(Math.abs(run().pcm[0]-.3)<.0001);
 processor.port.onmessage({data:{muted:true}});let frame=run();assert.ok(Math.abs(frame.pcm[0]-.1)<.0001);assert.equal(frame.mic,0);assert.ok(frame.rawMic>.19);
 processor.port.onmessage({data:{paused:true}});frame=run();assert.ok(frame.pcm.every(value=>value===0));assert.equal(frame.pcm.length,1600);
 processor.port.onmessage({data:{paused:false,muted:false,micGain:3,systemGain:3}});frame=run();assert.ok(frame.peak>.8);assert.ok(frame.rawSystem>.39);
});
test('worklet flush acknowledges final partial packet and clamps clipping',()=>{
 const {processor}=setup();const packets=[];processor.port.postMessage=value=>packets.push(value);
 processor.port.onmessage({data:{micGain:3,systemGain:3}});
 processor.process([[new Float32Array(128).fill(1)],[new Float32Array(128).fill(1)]],[[new Float32Array(128)]]);
 processor.port.onmessage({data:'flush'});
 assert.equal(packets.length,2);assert.equal(packets[0].pcm.length,128);assert.equal(packets[0].peak,3);assert.ok(packets[0].pcm.every(value=>value===1));assert.equal(packets[1].flushed,true);
});
