const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');

class SpeechEngine {
  constructor(resources,{threads=6,speechModel='base.en',batchSize=4,pythonExecutable='',worker,onState=()=>{},onAudio=()=>{},onCaptureError=()=>{}}={}) {
    if(!Number.isInteger(threads)||threads<1||threads>16||!Number.isInteger(batchSize)||batchSize<1||batchSize>32||
      !['base.en','small.en','medium.en','large-v3'].includes(speechModel))throw new TypeError('Invalid speech settings.');
    this.resources=resources;this.options={threads:Math.min(threads,os.availableParallelism()),speechModel,batchSize};
    const local=path.join(__dirname,'..','.venv',process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'python.exe':'python');
    this.python=pythonExecutable||process.env.MEETING_PYTHON||(fs.existsSync(local)?local:process.platform==='win32'?'python':'python3');
    this.worker=worker||path.join(__dirname,'..','python','worker.py');
    this.onState=onState;this.onAudio=onAudio;this.onCaptureError=onCaptureError;
    this.child=null;this.requests=new Map();this.sequence=0;this._ready=false;this.failure=null;this.starting=null;this.log='';
  }
  get ready(){return this._ready&&this.child!==null&&!this.failure;}
  state(){this.onState({ready:this.ready,failure:this.failure});}
  launch(){
    if(this.child)return;
    this.failure=null;
    const child=spawn(this.python,['-u',this.worker],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;
    const fail=error=>{if(this.child!==child)return;this.child=null;this._ready=false;this.failure=error;for(const pending of this.requests.values())pending.reject(error);this.requests.clear();child.kill();this.state();};
    child.on('error',error=>fail(new Error('Could not start Python/WhisperX: '+error.message)));
    child.on('exit',code=>fail(new Error(`WhisperX worker exited (${code}). ${this.log.slice(-1500)}`)));
    child.stdin.on('error',fail);child.stderr.on('data',data=>{this.log=(this.log+data).slice(-4000);});
    createInterface({input:child.stdout}).on('line',line=>{
      if(this.child!==child)return;
      try{
        if(Buffer.byteLength(line)>2*1024*1024)throw new Error('WhisperX response too large.');
        const value=JSON.parse(line);
        if(value.event==='audio'){this.onAudio(value.value);return;}
        if(value.event==='capture-error'){this.onCaptureError(value.value);return;}
        const pending=this.requests.get(value.id);if(!pending)return;this.requests.delete(value.id);
        if(value.error)pending.reject(new Error(String(value.error)));else pending.resolve(value.value);
      }catch(error){fail(error);}
    });
  }
  request(method,value,timeout=120000){
    this.launch();const id=++this.sequence,child=this.child;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.close();reject(new Error('WhisperX request timed out; pending audio is preserved.'));},timeout);
      this.requests.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
      child.stdin.write(JSON.stringify({id,method,value})+'\n',error=>{if(error){this.requests.get(id)?.reject(error);this.requests.delete(id);}});
    });
  }
  start(){
    if(this.ready)return Promise.resolve();if(this.starting)return this.starting;
    const loading=this.request('load',{...this.options,cache:path.join(this.resources,'models')},600000);const child=this.child;
    this.starting=loading.then(()=>{if(this.child!==child)throw new Error('Speech model closed.');this._ready=true;this.failure=null;this.state();}).catch(error=>{if(this.child===child){this._ready=false;this.failure=error;this.state();}throw error;}).finally(()=>{if(this.child===child||!this.child)this.starting=null;});
    return this.starting;
  }
  async transcribe(filename){
    if(!this.ready)throw this.failure||new Error('WhisperX is not running.');
    const segments=await this.request('transcribe',filename);
    if(!Array.isArray(segments)||segments.some(s=>!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start||typeof s.text!=='string'))throw new Error('WhisperX returned invalid transcript data.');
    return segments;
  }
  devices(){return this.request('devices',null,30000);}
  startCapture(settings){return this.request('capture-start',settings,30000);}
  stopCapture(){return this.child?this.request('capture-stop',null,15000):Promise.resolve();}
  captureSettings(value){return this.request('capture-settings',value,15000);}
  close(){
    const child=this.child;this.child=null;this._ready=false;this.starting=null;this.failure=null;
    for(const pending of this.requests.values())pending.reject(new Error('Speech model closed.'));this.requests.clear();child?.kill();this.state();
  }
}
module.exports={SpeechEngine};
