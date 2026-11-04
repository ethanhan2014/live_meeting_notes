const {spawn} = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {setTimeout:delay} = require('node:timers/promises');

class SpeechEngine {
  constructor(resources, {threads=6,vad=false,onState=()=>{}}={}) {
    if (!Number.isInteger(threads) || threads < 1 || threads > 16 || typeof vad !== 'boolean' || typeof onState !== 'function') {
      throw new TypeError('Invalid speech settings.');
    }
    this.resources=resources; this.threads=Math.min(threads,os.availableParallelism()); this.vad=vad; this.onState=onState;
    this.child=null; this.failure=null; this.starting=null; this.controller=null; this._ready=false;
  }
  get ready() { return this._ready && this.child !== null && !this.failure; }
  state() { this.onState({ready:this.ready,failure:this.failure}); }
  start() {
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    const controller=new AbortController(); this.controller=controller; this.failure=null;
    const starting=this.launch(controller).catch(error=>{
      if (this.controller===controller) {
        const child=this.child; this.child=null; this._ready=false; this.failure=error;
        controller.abort(error); child?.kill(); this.state();
      }
      throw error;
    }).finally(()=>{if(this.starting===starting)this.starting=null;});
    this.starting=starting;
    return starting;
  }
  async launch(controller) {
    const {signal}=controller;
    const executable=path.join(this.resources,'whisper',process.platform==='win32'?'whisper-server.exe':'whisper-server');
    const model=path.join(this.resources,'models','ggml-base.en.bin');
    const vadModel=path.join(this.resources,'models','ggml-silero-v6.2.0.bin');
    await fs.access(executable,constants.X_OK); await fs.access(model);
    if (this.vad) await fs.access(vadModel);
    signal.throwIfAborted();
    const port=await new Promise((resolve,reject)=>{
      const probe=net.createServer(); probe.on('error',reject);
      probe.listen(0,'127.0.0.1',()=>{const selected=probe.address().port;probe.close(()=>resolve(selected));});
    });
    signal.throwIfAborted();
    this.url=`http://127.0.0.1:${port}`; this.log='';
    const args=['-m',model,'--host','127.0.0.1','--port',String(port),
      '-l','en','-t',String(this.threads),'-ng','-nlp','-bo','1','-bs','1','-sns'];
    if (this.vad) args.push('--vad','-vm',vadModel);
    const child=spawn(executable,args,{windowsHide:true,cwd:path.dirname(executable)});
    this.child=child;
    child.stderr.on('data',data=>{this.log=(this.log+data).slice(-4000);});
    child.stdout.on('data',()=>{});
    const failed=error=>{
      if (this.child!==child) return;
      this.child=null; this._ready=false; this.failure=error; controller.abort(error); this.state();
    };
    child.on('error',failed);
    child.on('exit',code=>failed(new Error(`Local speech process exited (${code}).`)));
    const deadline=Date.now()+45000;
    while (Date.now()<deadline) {
      signal.throwIfAborted();
      try {
        const response=await fetch(this.url+'/',{signal:AbortSignal.any([signal,AbortSignal.timeout(1000)])});
        signal.throwIfAborted();
        if (response.ok) {this._ready=true;this.state();return;}
      } catch {signal.throwIfAborted();}
      await delay(200,undefined,{signal});
    }
    throw new Error('Local speech model did not start within 45 seconds.');
  }
  async transcribe(wavPath) {
    if (!this.ready) throw this.failure || new Error('Speech model is not running.');
    const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(90000)]);
    const audio=await fs.readFile(wavPath,{signal});
    signal.throwIfAborted();
    if (audio.length>200000 || audio.length<44) throw new Error('Invalid audio chunk size.');
    const form=new FormData();
    form.append('file',new Blob([audio],{type:'audio/wav'}),'chunk.wav');
    form.append('response_format','verbose_json');form.append('language','en');
    form.append('temperature','0.0');form.append('temperature_inc','0.0');
    const response=await fetch(this.url+'/inference',{method:'POST',body:form,signal});
    if (!response.ok) throw new Error(`Speech recognition failed (${response.status}).`);
    const result=await response.json();
    signal.throwIfAborted();
    if (!Array.isArray(result.segments)) throw new Error('Speech model returned invalid transcript data.');
    return result.segments.filter(segment=>segment.no_speech_prob<.8 || segment.no_speech_prob===undefined).map(segment=>{
      // shortcut: b5454 remaps only VAD segment times, restore token trimming when upstream also remaps word times.
      if (this.vad) {const {words,...timedSegment}=segment;return timedSegment;}
      return segment;
    });
  }
  close() {
    const child=this.child; this.child=null; this._ready=false;
    this.controller?.abort(new Error('Speech model closed.')); this.controller=null; this.starting=null;
    child?.kill(); this.state();
  }
}
module.exports={SpeechEngine};
