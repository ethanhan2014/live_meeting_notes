import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';

const callbacks=new Map();let latest=null;
// Subscribe before either window asks for state, so startup cannot miss updates.
for(const event of ['meeting-state','meeting-audio','meeting-close-capture','meeting-stop-request','meeting-fatal']){
  await listen(event,({payload})=>{
    if(event==='meeting-state')latest=payload;
    if(event==='meeting-fatal'&&latest){latest={...latest,active:false,busy:null,error:String(payload),closing:true};for(const callback of callbacks.get('meeting-state')||[])callback(latest);}
    for(const callback of callbacks.get(event)||[])callback(payload);
  });
}
const call=(method,...args)=>invoke('meeting_call',{method,args});
const on=(event,callback)=>{if(!callbacks.has(event))callbacks.set(event,[]);callbacks.get(event).push(callback);};
window.meeting={
  state:()=>call('meeting-state-get'),start:options=>call('meeting-start',options),stop:generate=>call('meeting-stop',generate),
  devices:()=>call('meeting-devices'),captureSettings:value=>call('meeting-capture-settings',value),
  captureFailed:message=>call('meeting-capture-failed',message),notes:(regenerate=false)=>call('meeting-notes',regenerate),
  research:id=>call('meeting-research',id),export:format=>call('meeting-export',format),source:url=>call('meeting-source',url),
  cancel:()=>call('meeting-cancel'),paused:value=>call('meeting-paused',value),audioTest:(value,options)=>call('meeting-audio-test',value,options),
  open:id=>call('meeting-open',id),recover:()=>call('meeting-recover'),editTranscript:(index,value)=>call('meeting-edit-transcript',index,value),
  editNotes:value=>call('meeting-edit-notes',value),actionDone:(index,done)=>call('meeting-action-done',index,done),
  compact:()=>call('meeting-compact'),compactControl:command=>call('meeting-compact-control',command),
  loadTranscript:name=>call('meeting-load-transcript',name),importTranscript:()=>call('meeting-import-transcript'),
  pickTranscriptFolder:()=>call('meeting-pick-transcript-folder'),rescan:()=>call('meeting-rescan'),settings:value=>call('meeting-settings',value),
  diagnostics:()=>call('meeting-diagnostics'),
  onState:callback=>on('meeting-state',callback),onAudio:callback=>on('meeting-audio',callback),
  onClose:callback=>on('meeting-close-capture',callback),onStop:callback=>on('meeting-stop-request',callback)
};
