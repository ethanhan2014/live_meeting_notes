const {app,BrowserWindow,session,desktopCapturer,ipcMain,dialog,shell,powerMonitor,screen} = require('electron');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {Recording} = require('./lib/recording.cjs');
const {SpeechEngine} = require('./lib/speech.cjs');
const {safeError} = require('./lib/codex.cjs');
const {AgentJobs,detectAgents} = require('./lib/agents.cjs');
const {listTranscripts,saveTranscript,readTranscript} = require('./lib/transcripts.cjs');
const {loadLatestSession,loadSession,listSessions,saveSession,commitSession,exportSession,atomicWrite} = require('./lib/session.cjs');
const {defaults,loadSettings,saveSettings,validateSettings} = require('./lib/settings.cjs');
const {editTranscript,editNotes,setActionDone} = require('./lib/edits.cjs');
const {drainForShutdown} = require('./lib/lifecycle.cjs');

app.setName('Live Meeting Notes');
const primary=app.requestSingleInstanceLock();
if(!primary)app.quit();
let window,recording,speech,jobs,root,entry,resources,settingsPath,busy=null,error=null,closing=false,testing=false,paused=false;
let settings={...defaults},history=[],recovery={count:0,bytes:0,legacyCount:0},diagnostic=null,shutdown=null,captureReleased=null,operationIdle=null;
let agents=[],scriptFiles=[],scriptSaveError=null,scriptKey='',scriptWrites=Promise.resolve(),overlay,overlayEntry;
function transcriptDirectory(){return settings.transcriptFolder||path.join(app.isPackaged?(process.env.PORTABLE_EXECUTABLE_DIR||path.dirname(app.getPath('exe'))):__dirname,'scripts');}
function state() {
  return {session:recording?.session || null,active:recording?.active || false,pending:recording?.pending || 0,
    busy,error:error || recording?.failure?.message || null,captureError:recording?.failure?.message || null,
    ready:speech?.ready || false,closing,testing,paused,settings,history,recovery,diagnostic,metrics:recording?.metrics || null,
    agents,scriptFiles,scriptSaveError,scriptsDirectory:transcriptDirectory()};
}
function broadcast(){for(const view of [window,overlay])if(view&&!view.isDestroyed())view.webContents.send('meeting-state',state());}
function changed(){
  if(recording?.session){
    const current=recording.session,folder=transcriptDirectory(),key=JSON.stringify([folder,current.id,current.status,current.endedAt,current.transcript,current.notes,current.answers]);
    if(key!==scriptKey){scriptKey=key;const snapshot=structuredClone(current);
      scriptWrites=scriptWrites.then(async()=>{await saveTranscript(folder,snapshot);if(folder===transcriptDirectory()){scriptFiles=await listTranscripts(folder);scriptSaveError=null;}broadcast();})
        .catch(failure=>{scriptSaveError='TXT transcript save failed: '+safeError(failure.message)+' Choose a writable transcript folder in Settings.';broadcast();});
    }
  }
  broadcast();
}
function trusted(event){if(!((window&&event.sender===window.webContents&&event.senderFrame?.url===entry)||(overlay&&event.sender===overlay.webContents&&event.senderFrame?.url===overlayEntry)))throw new Error('Request denied.');}
function finishClose(){if(!busy)operationIdle?.();}
function handle(channel,action){ipcMain.handle(channel,async(event,...args)=>{
  trusted(event);
  try{return {ok:true,value:await action(...args)};}
  catch(failure){error=safeError(failure.message);changed();finishClose();return {ok:false,error};}
});}
function idle(){if(busy||recording.active||closing||testing)throw new Error('Finish the current operation first.');}
async function refresh(){history=await listSessions(root);recovery=recording.session?await recording.recoverable():{count:0,bytes:0,legacyCount:0};changed();}
async function mutation(action){
  idle();busy='saving';error=null;changed();
  try{await action();await refresh();}finally{busy=null;changed();finishClose();}
  return state();
}
function speechState(value){if(value.failure)error=safeError(value.failure.message);changed();}
async function ensureSpeech(){try{await speech.start();changed();}catch(failure){error=safeError(failure.message);changed();throw failure;}}
function compactBounds(area){const width=Math.min(340,area.width);return {x:area.x+area.width-width,y:area.y,width,height:area.height};}
function restoreWindow(){if(overlay&&!overlay.isDestroyed())overlay.destroy();overlay=null;if(window&&!window.isDestroyed()){window.restore();window.show();window.focus();}}
async function showCompact(){
  if(!recording.active||closing)return;
  if(overlay&&!overlay.isDestroyed()){overlay.show();return;}
  overlayEntry=pathToFileURL(path.join(__dirname,'renderer','overlay.html')).href;
  overlay=new BrowserWindow({...compactBounds(screen.getDisplayMatching(window.getBounds()).workArea),frame:false,transparent:true,backgroundColor:'#00000000',alwaysOnTop:true,skipTaskbar:true,resizable:false,title:'Live transcript',
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  overlay.setOpacity(.7);overlay.webContents.setWindowOpenHandler(()=>({action:'deny'}));overlay.webContents.on('will-navigate',(event,url)=>{if(url!==overlayEntry)event.preventDefault();});
  overlay.on('close',event=>{if(recording.active){event.preventDefault();window.webContents.send('meeting-stop-request');}});
  overlay.webContents.on('render-process-gone',restoreWindow);
  await overlay.loadFile(path.join(__dirname,'renderer','overlay.html'));window.minimize();
}
async function openTranscript(file){
  if(!/\.txt$/i.test(file))throw new Error('Choose a TXT transcript.');
  return mutation(async()=>{await scriptWrites;const selected=await readTranscript(file,root);if(['recording','finishing','generating-notes'].includes(selected.status)){selected.status='incomplete';selected.incompleteReason='This imported session was not finished.';}
    await saveSession(root,selected);recording.session=selected;recording.failure=null;});
}
async function beginShutdown(reason=''){
  if(shutdown)return shutdown;
  closing=true;jobs?.cancel();changed();
  shutdown=(async()=>{
    if(recording?.active||testing){
      let timer,released=false;
      const flushed=new Promise(resolve=>{captureReleased=()=>{released=true;resolve();};timer=setTimeout(resolve,3000);});
      try{window?.webContents.send('meeting-close-capture');}catch{}
      await flushed;clearTimeout(timer);captureReleased=null;
      if(!released)reason ||= 'Capture stopped responding. The final audio buffer may be missing.';
    }
    if(busy==='preparing'||busy==='saving'||busy==='opening'){
      let timer;await new Promise(resolve=>{operationIdle=resolve;timer=setTimeout(resolve,5000);});clearTimeout(timer);operationIdle=null;
    }
    if(recording)await drainForShutdown(recording,speech,()=>saveSession(root,recording.session),{reason});
    if(busy){
      let timer;await new Promise(resolve=>{operationIdle=resolve;timer=setTimeout(resolve,5000);});clearTimeout(timer);operationIdle=null;
    }
    changed();
    // shortcut: JSON survives a slow TXT shutdown save, the TXT files are rebuilt on the next startup.
    let scriptTimer;try{await Promise.race([scriptWrites,new Promise(resolve=>{scriptTimer=setTimeout(resolve,5000);})]);}finally{clearTimeout(scriptTimer);}
    if(overlay&&!overlay.isDestroyed())overlay.destroy();
    speech?.close();jobs?.cancel();
    if(window&&!window.isDestroyed())window.destroy();app.quit();
  })().catch(failure=>{console.error(safeError(failure.message));speech?.close();window?.destroy();app.quit();});
  return shutdown;
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

app.whenReady().then(async()=>{
  if(!primary)return;
  root=path.join(app.getPath('userData'),'sessions');settingsPath=path.join(app.getPath('userData'),'settings.json');
  try{settings=await loadSettings(settingsPath);}catch(failure){error='Could not load settings: '+safeError(failure.message);}
  resources=app.isPackaged?path.join(process.resourcesPath,'resources'):path.join(__dirname,'resources');
  speech=new SpeechEngine(resources,{threads:settings.threads,vad:settings.vad,onState:speechState});
  jobs=new AgentJobs(path.join(app.getPath('userData'),'agent-jobs'),app.isPackaged?path.join(process.resourcesPath,'schemas'):undefined,settings);
  agents=await detectAgents(settings.codexExecutable);
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
  scriptWrites=scriptWrites.then(async()=>{for(const item of existing)await saveTranscript(folder,await loadSession(root,item.id));scriptFiles=await listTranscripts(folder);})
    .catch(failure=>{scriptSaveError='TXT transcript save failed: '+safeError(failure.message)+' Choose a writable transcript folder in Settings.';});
  entry=pathToFileURL(path.join(__dirname,'renderer','index.html')).href;
  window=new BrowserWindow({width:1280,height:900,minWidth:900,minHeight:700,title:'Live Meeting Notes',backgroundColor:'#10141c',autoHideMenuBar:true,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(url!==entry)event.preventDefault();});
  window.webContents.on('render-process-gone',()=>beginShutdown('The display process stopped unexpectedly. Recording may be incomplete.'));
  window.on('unresponsive',()=>{if(recording.active||testing)beginShutdown('The recording window stopped responding.');});
  session.defaultSession.setPermissionCheckHandler((contents,permission)=>contents===window.webContents&&['media','display-capture'].includes(permission));
  session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details)=>callback(contents===window.webContents&&contents.getURL()===entry&&
    (permission==='display-capture'||(permission==='media'&&!(details.mediaTypes||[]).includes('video')))));
  session.defaultSession.setDisplayMediaRequestHandler((request,callback)=>{
    if(request.frame?.url!==entry||!request.userGesture)return callback(null);
    desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:0,height:0}}).then(sources=>callback(sources[0]?{video:sources[0],audio:'loopback'}:null)).catch(()=>callback(null));
  });
  handle('meeting-state-get',()=>state());
  handle('meeting-start',async()=>{
    idle();busy='preparing';error=null;paused=false;changed();
    try{await ensureSpeech();if(closing)throw new Error('The app is closing.');recording.threshold=settings.noiseThreshold;await recording.start();if(closing){await recording.stop();throw new Error('The app is closing.');}await refresh();}
    finally{busy=null;changed();finishClose();}
    return state();
  });
  ipcMain.on('meeting-pcm',(event,pcm)=>{
    try{trusted(event);}catch{return;}
    try{if(!(pcm instanceof Float32Array)||pcm.length>3200)throw new Error('Invalid audio packet.');recording.push(pcm);}
    catch(failure){recording.failure=failure;error=safeError(failure.message);changed();}
  });
  handle('meeting-capture-failed',message=>{
    if(typeof message!=='string'||message.length>1000)throw new Error('Invalid capture error.');
    recording.failure=new Error(message);if(recording.session)recording.session.interruption=message;error=message;changed();
  });
  handle('meeting-stop',async generateNotes=>{
    if(typeof generateNotes!=='boolean')throw new Error('Invalid Stop request.');
    captureReleased?.();
    if(busy)throw new Error('Finish the current operation first.');
    busy='finishing';paused=false;changed();
    try{await recording.stop();await refresh();}finally{restoreWindow();busy=null;changed();finishClose();}
    if(generateNotes&&!closing)await notes();
    await refresh();return state();
  });
  handle('meeting-paused',value=>{if(typeof value!=='boolean'||!recording.active)throw new Error('No active recording.');paused=value;changed();});
  handle('meeting-audio-test',value=>{
    if(typeof value!=='boolean')throw new Error('Invalid audio test request.');
    if(value){idle();error=null;}else{captureReleased?.();}
    testing=value;changed();return state();
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
  handle('meeting-export',async format=>{
    if(!['txt','md'].includes(format)||!recording.session)throw new Error('No meeting available to export.');
    const contents=exportSession(recording.session,format),filename=`Meeting ${recording.session.startedAt.slice(0,19).replace(/[:T]/g,'-')}.${format}`;
    const selected=await dialog.showSaveDialog(window,{defaultPath:path.join(app.getPath('documents'),filename),filters:[{name:format==='txt'?'Text file':'Markdown',extensions:[format]}]});
    if(selected.canceled||!selected.filePath)return false;
    await atomicWrite(selected.filePath,contents);return true;
  });
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
  handle('meeting-compact',showCompact);
  handle('meeting-compact-control',command=>{
    if(command==='stop'){if(recording.active)window.webContents.send('meeting-stop-request');}
    else if(command==='restore')restoreWindow();else throw new Error('Invalid window command.');
  });
  handle('meeting-load-transcript',name=>{idle();if(typeof name!=='string'||path.basename(name)!==name||/[\0\/\\]/.test(name))throw new Error('Invalid transcript filename.');return openTranscript(path.join(transcriptDirectory(),name));});
  handle('meeting-import-transcript',async()=>{idle();const selected=await dialog.showOpenDialog(window,{defaultPath:transcriptDirectory(),properties:['openFile'],filters:[{name:'Text transcript',extensions:['txt']}]});if(!selected.canceled)return openTranscript(selected.filePaths[0]);});
  handle('meeting-pick-transcript-folder',async()=>{idle();const selected=await dialog.showOpenDialog(window,{defaultPath:transcriptDirectory(),properties:['openDirectory','createDirectory']});return selected.canceled?null:selected.filePaths[0];});
  handle('meeting-rescan',async()=>{idle();agents=await detectAgents(settings.codexExecutable);scriptFiles=await listTranscripts(transcriptDirectory());scriptKey='';changed();return state();});
  handle('meeting-settings',value=>mutation(async()=>{
    const next=validateSettings(value);await saveSettings(settingsPath,next);
    const restart=next.threads!==settings.threads||next.vad!==settings.vad;
    settings=next;jobs.settings=settings;recording.threshold=settings.noiseThreshold;diagnostic=null;error=null;agents=await detectAgents(settings.codexExecutable);
    if(restart){speech.close();speech=new SpeechEngine(resources,{threads:settings.threads,vad:settings.vad,onState:speechState});recording.engine=speech;if(!closing)ensureSpeech().catch(()=>{});}
  }));
  handle('meeting-pick-codex',async()=>{
    idle();const result=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'Native Codex executable',extensions:['exe']}]});return result.canceled?null:result.filePaths[0];
  });
  handle('meeting-diagnostics',async()=>{
    idle();busy='diagnostics';jobs.cancelled=false;error=null;diagnostic=null;changed();
    try{diagnostic=await jobs.testConnection();return diagnostic;}finally{busy=null;changed();finishClose();}
  });
  handle('meeting-source',async value=>{
    if(typeof value!=='string'||value.length>8000)throw new Error('Invalid source URL.');
    const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid source URL.');await shell.openExternal(url.href);
  });
  handle('meeting-cancel',()=>jobs.cancel());
  window.on('close',event=>{event.preventDefault();beginShutdown();});
  window.on('closed',()=>{if(overlay&&!overlay.isDestroyed())overlay.destroy();jobs.cancel();speech.close();});
  powerMonitor.on('suspend',()=>{if(recording.active||testing)beginShutdown('Windows suspended during recording.');});
  await window.loadFile(path.join(__dirname,'renderer','index.html'));ensureSpeech().catch(()=>{});
}).catch(failure=>{console.error(safeError(failure.message));app.quit();});
app.on('second-instance',()=>{if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(window&&!window.isDestroyed()&&(recording?.active||busy||testing)){event.preventDefault();beginShutdown();}});
