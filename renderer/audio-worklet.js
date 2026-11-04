class MeetingAudio extends AudioWorkletProcessor {
  constructor() {
    super();this.buffer=new Float32Array(1600);this.index=0;
    this.mic=0;this.system=0;this.rawMic=0;this.rawSystem=0;this.mixed=0;this.peak=0;
    this.micGain=1;this.systemGain=1;this.muted=false;this.paused=false;
    this.port.onmessage=event => {
      if (event.data === 'flush') {this.send();this.port.postMessage({flushed:true});return;}
      for (const key of ['micGain','systemGain']) if (Number.isFinite(event.data?.[key]) && event.data[key]>=0 && event.data[key]<=3) this[key]=event.data[key];
      for (const key of ['muted','paused']) if (typeof event.data?.[key]==='boolean') this[key]=event.data[key];
    };
  }
  send() {
    if (!this.index) return;
    const pcm=this.buffer.slice(0,this.index);
    this.port.postMessage({pcm,mic:Math.sqrt(this.mic/this.index),system:Math.sqrt(this.system/this.index),
      rawMic:Math.sqrt(this.rawMic/this.index),rawSystem:Math.sqrt(this.rawSystem/this.index),
      mixed:Math.sqrt(this.mixed/this.index),peak:this.peak},[pcm.buffer]);
    this.index=0;this.mic=0;this.system=0;this.rawMic=0;this.rawSystem=0;this.mixed=0;this.peak=0;
  }
  process(inputs,outputs) {
    const length=outputs[0]?.[0]?.length || 128;
    for (let index=0;index < length;index++) {
      let mic=0,system=0;
      for (const channel of inputs[0] || []) mic += channel[index] || 0;
      for (const channel of inputs[1] || []) system += channel[index] || 0;
      mic /= inputs[0]?.length || 1;system /= inputs[1]?.length || 1;
      this.rawMic+=mic*mic;this.rawSystem+=system*system;
      mic=this.muted || this.paused ? 0 : mic*this.micGain;system=this.paused ? 0 : system*this.systemGain;
      const mixed=(mic+system)*.5;
      this.buffer[this.index++]=Math.max(-1,Math.min(1,mixed));
      this.mic+=mic*mic;this.system+=system*system;this.mixed+=mixed*mixed;this.peak=Math.max(this.peak,Math.abs(mixed));
      if (this.index === this.buffer.length) this.send();
    }
    for (const output of outputs[0] || []) output.fill(0);
    return true;
  }
}
registerProcessor('meeting-audio',MeetingAudio);
