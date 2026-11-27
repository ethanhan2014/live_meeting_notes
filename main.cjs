const {createInterface}=require('node:readline');
const os=require('node:os');
const path = require('node:path');
const {Recording} = require('./lib/recording.cjs');
const {SpeechEngine} = require('./lib/speech.cjs');
const {AIJobs,safeError} = require('./lib/ai.cjs');
const {loadApiConfig,saveApiEnv}=require('./lib/env.cjs');
const {listTranscripts,saveTranscript,readTranscript} = require('./lib/transcripts.cjs');
const {loadLatestSession,loadSession,listSessions,saveSession,commitSession,exportSession,atomicWrite} = require('./lib/session.cjs');
const {defaults,loadSettings,saveSettings,validateSettings} = require('./lib/settings.cjs');
const {editTranscript,editNotes,setActionDone} = require('./lib/edits.cjs');
const {drainForShutdown} = require('./lib/lifecycle.cjs');

const data=process.env.MEETING_DATA_DIR||path.join(process.platform==='win32'?(process.env.APPDATA||os.homedir()):process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support'):path.join(os.homedir(),'.local','share'),'Live Meeting Notes');
let recording,speech,jobs,root,resources,settingsPath,apiEnvPath,busy=null,error=null,closing=false,testing=false,paused=false;
let settings={...defaults},history=[],recovery={count:0,bytes:0,legacyCount:0},diagnostic=null,shutdown=null,operationIdle=null;
let scriptFiles=[],scriptSaveError=null,scriptKey='',scriptWrites=Promise.resolve();
let captureFailure=null;
const handlers=new Map();
function send(value){process.stdout.write(JSON.stringify(value)+'\n');}
function transcriptDirectory(){return settings.transcriptFolder||path.join(data,'scripts');}
function state() {
  return {platform:process.platform,session:recording?.session || null,active:recording?.active || false,pending:recording?.pending || 0,
    busy,error:error || recording?.failure?.message || null,captureError:captureFailure || recording?.failure?.message || null,
    ready:speech?.ready || false,closing,testing,paused,settings:{...settings,apiKey:''},hasApiKey:!!settings.apiKey,apiEnvPath,history,recovery,diagnostic,metrics:recording?.metrics || null,
    scriptFiles,scriptSaveError,scriptsDirectory:transcriptDirectory()};
}
function broadcast(){send({event:'meeting-state',value:state()});}
function changed(){
  if(recording?.session){
    const current=recording.session,folder=transcriptDirectory(),key=JSON.stringify([folder,current.id,current.status,current.endedAt,current.transcript,current.notes,current.answers]);
    if(key!==scriptKey){scriptKey=key;const snapshot=structuredClone(current);
      scriptWrites=scriptWrites.then(async()=>{await saveTranscript(folder,snapshot);await saveTranscript(folder,snapshot,'md');if(folder===transcriptDirectory()){scriptFiles=await listTranscripts(folder);scriptSaveError=null;}broadcast();})
        .catch(failure=>{scriptSaveError='Meeting document save failed: '+safeError(failure.message)+' Choose a writable transcript folder in Settings.';broadcast();});
    }
  }
  broadcast();
}
function finishClose(){if(!busy)operationIdle?.();}
function handle(channel,action){handlers.set(channel,action);}
function idle(){if(busy||recording.active||closing||testing)throw new Error('Finish the current operation first.');}
async function refresh(){history=await listSessions(root);recovery=recording.session?await recording.recoverable():{count:0,bytes:0,legacyCount:0};changed();}
async function mutation(action){
  idle();busy='saving';error=null;changed();
  try{await action();await refresh();}finally{busy=null;changed();finishClose();}
  return state();
}
function speechState(value){
 if(value.failure){
  error=safeError(value.failure.message);
  if(recording?.active||testing||busy==='preparing'){captureFailure=error;if(recording?.active){recording.failure=new Error(error);recording.session.interruption=error;}}
 }
 changed();
}
async function ensureSpeech(){try{await speech.start();changed();}catch(failure){error=safeError(failure.message);changed();throw failure;}}
async function openTranscript(file){
  if(!/\.txt$/i.test(file))throw new Error('Choose a TXT transcript.');
  return mutation(async()=>{await scriptWrites;const selected=await readTranscript(file,root);if(['recording','finishing','generating-notes'].includes(selected.status)){selected.status='incomplete';selected.incompleteReason='This imported session was not finished.';}
    await saveSession(root,selected);recording.session=selected;recording.failure=null;});
}
async function beginShutdown(reason=''){
 if(shutdown)return shutdown;
 closing=true;jobs?.cancel();changed();
 shutdown=(async()=>{
  try{await speech?.stopCapture();}catch(failure){reason ||= failure.message;}
  testing=false;
  if(busy){let timer;await new Promise(resolve=>{operationIdle=resolve;timer=setTimeout(resolve,5000);});clearTimeout(timer);operationIdle=null;}
  if(recording)await drainForShutdown(recording,speech,()=>saveSession(root,recording.session),{reason});
  changed();await scriptWrites;speech?.close();jobs?.cancel();return state();
 })();return shutdown;
}
async function notes(regenerate=false) {
  const current=recording.session;
  if(!current)throw new Error('Record a meeting first.');
  if(current.notes&&!regenerate)return current.notes;
  jobs.cancelled=false;
  const previous=current.status;busy='notes';error=null;current.status='generating-notes';changed();
  let committed=false;
  try{
    await saveSession(root,current);
    await commitSession(root,current,{notes:await jobs.notes(current),answers:[],notesEdited:false,status:previous});
    committed=true;
    return current.notes;
  }finally{
    current.status=previous;
    try{if(!committed)await saveSession(root,current);}finally{busy=null;changed();finishClose();}
  }
}

function makeSpeech(){
 return new SpeechEngine(resources,{...settings,onState:speechState,onAudio:frame=>{
  if(!frame||!Array.isArray(frame.pcm)||frame.pcm.length>3200||!frame.pcm.every(Number.isFinite))throw new Error('Invalid native audio packet.');
  if(recording?.active)recording.push(Float32Array.from(frame.pcm));
  const {pcm,...meters}=frame;send({event:'meeting-audio',value:meters});
 },onCaptureError:message=>{error=safeError(String(message));captureFailure=error;if(recording?.active){recording.failure=new Error(error);recording.session.interruption=error;}changed();}});
}
async function initialize(){
  root=path.join(data,'sessions');settingsPath=path.join(data,'settings.json');apiEnvPath=path.join(data,'.env');
  try{settings=validateSettings({...await loadSettings(settingsPath),...await loadApiConfig(apiEnvPath,path.join(__dirname,'.env'))});}catch(failure){error='Could not load settings: '+safeError(failure.message);}
  resources=path.join(data,'whisperx');
  speech=makeSpeech();
  jobs=new AIJobs(settings,path.join(__dirname,'schemas'));
  recording=new Recording(root,speech,changed);recording.threshold=settings.noiseThreshold;
  try{
    recording.session=await loadLatestSession(root);
    if(recording.session&&['recording','finishing','generating-notes'].includes(recording.session.status)){
      recording.session.status='incomplete';recording.session.incompleteReason='The previous session ended before processing finished.';
      recording.session.interruption=recording.session.incompleteReason;
      await saveSession(root,recording.session);
    }
    await refresh();
  }catch(failure){error=safeError(failure.message);}
  const folder=transcriptDirectory(),existing=history.slice();
  scriptWrites=scriptWrites.then(async()=>{for(const item of existing){const saved=await loadSession(root,item.id);await saveTranscript(folder,saved);await saveTranscript(folder,saved,'md');}scriptFiles=await listTranscripts(folder);})
    .catch(failure=>{scriptSaveError='Meeting document save failed: '+safeError(failure.message)+' Choose a writable transcript folder in Settings.';});
  handle('meeting-state-get',()=>state());
  handle('meeting-devices',()=>speech.devices());
  function captureOptions(value={}){if(!value||typeof value.microphone!=='string'||value.microphone.length>4096)throw new Error('Invalid microphone selection.');return {micGain:settings.micGain,systemGain:settings.systemGain,microphone:value.microphone,muted:false,paused:false};}
  handle('meeting-start',async options=>{
    idle();const capture=captureOptions(options);busy='preparing';error=null;captureFailure=null;paused=false;changed();
    try{
      await ensureSpeech();if(closing)throw new Error('The app is closing.');await speech.startCapture(capture);
      if(closing)throw new Error('The app is closing.');if(captureFailure)throw new Error(captureFailure);
      recording.threshold=settings.noiseThreshold;await recording.start();
      if(captureFailure)throw new Error(captureFailure);await refresh();
    }catch(failure){
      await speech.stopCapture().catch(()=>{});
      if(recording.active){recording.failure??=failure;recording.session.interruption=failure.message;await recording.stop().catch(()=>{});}
      throw failure;
    }finally{busy=null;changed();finishClose();}return state();
  });
  handle('meeting-capture-failed',message=>{
    if(typeof message!=='string'||message.length>1000)throw new Error('Invalid capture error.');
    recording.failure=new Error(message);if(recording.session)recording.session.interruption=message;error=message;changed();
  });
  handle('meeting-stop',async generateNotes=>{
    if(typeof generateNotes!=='boolean')throw new Error('Invalid Stop request.');
    if(busy)throw new Error('Finish the current operation first.');
    busy='finishing';paused=false;changed();
    try{
      try{await speech.stopCapture();}catch(failure){recording.failure=failure;if(recording.session)recording.session.interruption=failure.message;}
      await recording.stop();await refresh();
    }finally{send({event:'meeting-restore'});busy=null;changed();finishClose();}
    if(generateNotes&&!closing)await notes();
    await refresh();return state();
  });
  handle('meeting-paused',async value=>{if(typeof value!=='boolean'||!recording.active)throw new Error('No active recording.');await speech.captureSettings({paused:value});paused=value;changed();});
  handle('meeting-capture-settings',async value=>{
    if(!value||Object.keys(value).some(k=>!['muted','micGain','systemGain'].includes(k))||(value.muted!==undefined&&typeof value.muted!=='boolean')||['micGain','systemGain'].some(k=>value[k]!==undefined&&(!Number.isFinite(value[k])||value[k]<0||value[k]>3)))throw new Error('Invalid capture settings.');return speech.captureSettings(value);
  });
  handle('meeting-audio-test',async(value,options)=>{
    if(typeof value!=='boolean')throw new Error('Invalid audio test request.');
    if(value){idle();error=null;captureFailure=null;busy='preparing';changed();try{await speech.startCapture(captureOptions(options));if(captureFailure)throw new Error(captureFailure);testing=true;}finally{busy=null;changed();finishClose();}}
    else{await speech.stopCapture();testing=false;changed();}return state();
  });
  handle('meeting-notes',async(regenerate=false)=>{idle();if(typeof regenerate!=='boolean')throw new Error('Invalid notes request.');const result=await notes(regenerate);await refresh();return result;});
  handle('meeting-research',async id=>{
    idle();if(typeof id!=='string'||id.length>100)throw new Error('Invalid question.');
    const current=recording.session,question=current?.notes?.questions.find(value=>value.id===id);
    if(!question)throw new Error('This question is not in the saved notes.');
    busy='research';jobs.cancelled=false;error=null;changed();
    try{
      let answer;
      try{answer=await jobs.research(current,question);}catch(failure){
        if(!current.answers.some(value=>value.questionId===id&&value.status==='answered'))await commitSession(root,current,{answers:current.answers.filter(value=>value.questionId!==id).concat({questionId:id,status:'unresolved',answer:'',sources:[],gaps:[safeError(failure.message)]})});
        throw failure;
      }
      await commitSession(root,current,{answers:current.answers.filter(value=>value.questionId!==id).concat(answer)});return answer;
    }finally{busy=null;changed();finishClose();}
  });
  handle('meeting-export',async(format,destination)=>{if(!['txt','md'].includes(format)||!recording.session)throw new Error('No meeting available to export.');if(typeof destination!=='string'||!path.isAbsolute(destination))throw new Error('Choose an absolute export path.');await atomicWrite(destination,exportSession(recording.session,format));return true;});
  handle('meeting-open',async id=>{
    idle();busy='opening';error=null;changed();
    try{
      const selected=await loadSession(root,id);
      if(['recording','finishing','generating-notes'].includes(selected.status)){selected.status='incomplete';await saveSession(root,selected);}
      recording.session=selected;recording.failure=null;recording.pending=0;
      await refresh();
    }finally{busy=null;changed();finishClose();}
    return state();
  });
  handle('meeting-recover',async()=>{
    idle();busy='recovering';error=null;changed();
    try{await recording.recover();}finally{try{await refresh();}finally{busy=null;changed();finishClose();}}
    return state();
  });
  handle('meeting-edit-transcript',(index,value)=>mutation(()=>editTranscript(root,recording.session,index,value)));
  handle('meeting-edit-notes',value=>mutation(()=>editNotes(root,recording.session,value)));
  handle('meeting-action-done',(index,done)=>mutation(()=>setActionDone(root,recording.session,index,done)));
  handle('meeting-load-transcript',name=>{idle();if(typeof name!=='string'||path.basename(name)!==name||/[\0\/\\]/.test(name))throw new Error('Invalid transcript filename.');return openTranscript(path.join(transcriptDirectory(),name));});
  handle('meeting-import-transcript',file=>{idle();if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('Choose an absolute transcript path.');return openTranscript(file);});
  handle('meeting-rescan',async()=>{idle();scriptFiles=await listTranscripts(transcriptDirectory());scriptKey='';changed();return state();});
  handle('meeting-settings',value=>mutation(async()=>{
    const next=validateSettings(value);if(!next.apiKey&&next.apiProvider===settings.apiProvider&&next.apiBaseUrl===settings.apiBaseUrl)next.apiKey=settings.apiKey;await saveSettings(settingsPath,next);await saveApiEnv(apiEnvPath,next);
    const restart=['threads','speechModel','batchSize','pythonExecutable'].some(key=>next[key]!==settings[key]);
    settings=next;jobs.settings=settings;recording.threshold=settings.noiseThreshold;diagnostic=null;error=null;
    if(restart){speech.close();speech=makeSpeech();recording.engine=speech;}
  }));
  handle('meeting-diagnostics',async()=>{
    idle();busy='diagnostics';jobs.cancelled=false;error=null;diagnostic=null;changed();
    try{diagnostic=await jobs.testConnection();return diagnostic;}finally{busy=null;changed();finishClose();}
  });
  handle('meeting-cancel',()=>jobs.cancel());
  handle('meeting-shutdown',()=>beginShutdown());
}
const ready=initialize();
const input=createInterface({input:process.stdin});
input.on('line',async line=>{
 let request;
 try{
  if(Buffer.byteLength(line)>2*1024*1024)throw new Error('Request too large.');request=JSON.parse(line);await ready;
  if(!Number.isSafeInteger(request.id)||!Array.isArray(request.args)||!handlers.has(request.method))throw new Error('Unknown or invalid meeting command.');
  send({id:request.id,value:await handlers.get(request.method)(...request.args)});
 }catch(failure){error=safeError(failure.message);changed();finishClose();send({id:request?.id,error});}
});
input.on('close',()=>{ready.then(()=>beginShutdown()).finally(()=>process.exit());});
ready.catch(failure=>{console.error(safeError(failure.message));process.exitCode=1;input.close();});
