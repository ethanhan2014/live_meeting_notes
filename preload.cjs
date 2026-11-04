const {contextBridge,ipcRenderer} = require('electron');
async function invoke(channel,...args) {
  const result=await ipcRenderer.invoke(channel,...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
contextBridge.exposeInMainWorld('meeting',{
  state:() => invoke('meeting-state-get'),start:() => invoke('meeting-start'),
  pcm:value => ipcRenderer.send('meeting-pcm',value),stop:generate => invoke('meeting-stop',generate),
  captureFailed:message => invoke('meeting-capture-failed',message),notes:(regenerate=false) => invoke('meeting-notes',regenerate),
  research:id => invoke('meeting-research',id),export:format => invoke('meeting-export',format),
  source:url => invoke('meeting-source',url),cancel:() => invoke('meeting-cancel'),
  paused:value => invoke('meeting-paused',value),audioTest:value => invoke('meeting-audio-test',value),
  open:id => invoke('meeting-open',id),recover:() => invoke('meeting-recover'),
  editTranscript:(index,value) => invoke('meeting-edit-transcript',index,value),editNotes:value => invoke('meeting-edit-notes',value),
  actionDone:(index,done)=>invoke('meeting-action-done',index,done),compact:()=>invoke('meeting-compact'),compactControl:command=>invoke('meeting-compact-control',command),
  loadTranscript:name=>invoke('meeting-load-transcript',name),importTranscript:()=>invoke('meeting-import-transcript'),pickTranscriptFolder:()=>invoke('meeting-pick-transcript-folder'),rescan:()=>invoke('meeting-rescan'),
  settings:value => invoke('meeting-settings',value),pickCodex:() => invoke('meeting-pick-codex'),diagnostics:() => invoke('meeting-diagnostics'),
  onState:callback => ipcRenderer.on('meeting-state',(_event,value) => callback(value)),
  onClose:callback => ipcRenderer.on('meeting-close-capture',() => callback()),
  onStop:callback=>ipcRenderer.on('meeting-stop-request',()=>callback())
});
