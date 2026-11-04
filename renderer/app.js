const $=id => document.getElementById(id);
let current=null,systemStream=null,micStream=null,context=null,worklet=null,capturing=false,stopping=false,starting=false,flushResolve=null;
let shownSession=null,shownRevision=null,shownSegments=0,shownNotes='',shownHistory='',shownSettings='';
let testMode=false,muted=false,paused=false,calibration=null,editSave=null;
let shownAgents='',shownScripts='';
function node(tag,text,className='') {const value=document.createElement(tag);value.textContent=text;value.className=className;return value;}
function time(seconds) {const value=Math.floor(Math.max(0,seconds));return [Math.floor(value/3600),Math.floor(value/60)%60,value%60].map(part=>String(part).padStart(2,'0')).join(':');}
function showError(message) {$('error').textContent=message;$('error').hidden=!message;}
function elapsed() {
  const session=current?.session;
  $('elapsed').textContent=session ? time((Date.parse(session.endedAt || new Date().toISOString())-Date.parse(session.startedAt))/1000) : '00:00';
}
function settingsValue() {
  return {micGain:Number($('mic-gain').value),systemGain:Number($('system-gain').value),noiseThreshold:Number($('noise-threshold').value),
    threads:Number($('threads').value),vad:$('vad').checked,codexExecutable:$('codex-path').value.trim(),transcriptFolder:$('transcript-folder').value.trim(),
    summaryAgent:$('summary-agent').value,summaryModel:$('summary-model').value.trim(),summaryEffort:$('summary-effort').value,
    answerAgent:$('answer-agent').value,answerModel:$('answer-model').value.trim(),answerEffort:$('answer-effort').value};
}
function modelControls(prefix){
  const agent=$(prefix+'-agent').value,selected=$(prefix+'-effort').value;
  const efforts={codex:['minimal','low','medium','high','xhigh'],claude:['low','medium','high','xhigh','max'],opencode:['low','medium','high','max'],gemini:['low','medium','high']}[agent]||[];
  $(prefix+'-effort').replaceChildren(...['',...efforts].map(value=>{const option=node('option',value||'Default');option.value=value;return option;}));$(prefix+'-effort').value=efforts.includes(selected)?selected:'';
  const models={codex:['gpt-6-luna','gpt-6.1-sol'],claude:['sonnet','opus','haiku'],opencode:[],gemini:['gemini-2.5-flash','gemini-2.5-pro']}[agent]||[];
  $(prefix+'-models').replaceChildren(...models.map(value=>{const option=node('option',value);option.value=value;return option;}));
}
function gains() {
  for(const name of ['mic','system'])$(name+'-gain-value').textContent=Number($(name+'-gain').value).toFixed(1)+'×';
  if(testMode)worklet?.port.postMessage({micGain:Number($('mic-gain').value),systemGain:Number($('system-gain').value)});
}
function evidence(card,timestamps,session) {
  for(const stamp of timestamps){
    const exact=session.transcript.filter(segment=>Math.abs(segment.start-stamp)<.001);
    const passages=exact.length?exact:session.transcript.filter(segment=>stamp>=segment.start&&stamp<=segment.end);
    const quote=node('blockquote','','evidence-quote');quote.append(node('time',time(stamp)),node('span',passages.map(segment=>segment.text).join(' ')||'No matching passage.'));card.append(quote);
  }
}
function renderSummary(content,summary) {
  const match=summary.trim().match(/^Summary:?\s*\r?\n([\s\S]*?)\r?\nKey findings:?\s*\r?\n([\s\S]*?)\r?\nKey points:?\s*\r?\n([\s\S]*)$/i);
  const sections=match?[['Summary',match[1]],['Key findings',match[2]],['Key points',match[3]]]:[['Summary',summary],['Key findings',null],['Key points',null]];
  for(const [title,text]of sections)content.append(node('h3',title,'section-title'),node('p',text===null?'Regenerate notes to populate this section.':text.trim(),text===null?'muted':'summary'));
}
const noteTabs=['summary','actions','questions'];
let activeNotesTab='summary';
function selectNotesTab(name) {
  activeNotesTab=name;
  for(const tab of noteTabs){const selected=tab===name;$('tab-'+tab).setAttribute('aria-selected',String(selected));$('tab-'+tab).tabIndex=selected?0:-1;$('notes-'+tab).hidden=!selected;}
  $('notes').scrollTop=0;
}
function renderNotes(session,state) {
  const summary=$('notes-summary'),actions=$('notes-actions'),questions=$('notes-questions');
  for(const content of [summary,actions,questions])content.replaceChildren();
  if(!session?.notes){
    for(const content of [summary,actions,questions]){const empty=node('div','','empty');empty.append(node('h3',state.busy==='notes'?'Preparing your meeting notes…':'Notes follow the conversation'),node('p','Stop the recording to generate the summary, action items, and open questions.'));content.append(empty);}return;
  }
  const notes=session.notes;
  renderSummary(summary,notes.summary);
  if(session.notesEdited)summary.append(node('p','Includes your saved corrections.','muted'));
  actions.append(node('h3','Action items','section-title'));
  if(!notes.actions.length)actions.append(node('p','No explicit action items.','muted'));
  for(const [index,action]of notes.actions.entries()){
    const card=node('div','',action.done?'action-card completed':'action-card'),label=node('label','','action-title'),check=node('input','','action-check');check.type='checkbox';check.checked=!!action.done;
    check.addEventListener('change',()=>act(async()=>{try{await window.meeting.actionDone(index,check.checked);}finally{check.checked=!!current.session?.notes?.actions[index]?.done;}}));
    label.append(check,node('span',action.task));card.append(label,node('p',`${action.owner||'Owner not specified'} · ${action.due||'Due date not specified'}`,'muted'));evidence(card,action.evidence,session);actions.append(card);
  }
  questions.append(node('h3','Open questions','section-title'));
  if(!notes.questions.length)questions.append(node('p','No open questions identified.','muted'));
  for(const question of notes.questions){
    const card=node('div','','question-card'),answer=session.answers.find(value=>value.questionId===question.id);
    const button=node('button',answer?'Research again ↗':'Research answer ↗','small research');button.addEventListener('click',()=>act(()=>window.meeting.research(question.id)));
    card.append(node('p',question.question,'question-title'));evidence(card,question.evidence,session);card.append(button);
    if(answer){
      card.append(node('span',answer.status==='answered'?'RECOMMENDED ANSWER':'UNRESOLVED','answer-label'),node('p',answer.answer||'No supported answer available.','answer'));
      for(const source of answer.sources){
        const link=node('a',source.title||source.url,'source');link.href=source.url;link.addEventListener('click',event=>{event.preventDefault();act(()=>window.meeting.source(source.url));});card.append(link);
      }
      if(answer.gaps.length)card.append(node('p',answer.gaps.join(' '),'muted gaps'));
    }
    questions.append(card);
  }
}
function render(state) {
  current=state;const session=state.session,locked=!!state.busy||state.active||state.closing||state.testing||starting||stopping;
  const labels={notes:'AI is generating notes…',research:'AI is researching…',finishing:'Finishing transcription…',recovering:'Recovering saved audio…',diagnostics:'Testing AI connections…',opening:'Opening session…',saving:'Saving changes…',preparing:'Preparing recording…'};
  $('status').textContent=state.closing?'Finishing before closing…':labels[state.busy]|| (state.active?(state.paused?'Paused':'Recording'):state.testing?'Testing audio':state.ready?'Ready':state.error?'Setup needs attention':'Preparing speech model…');
  $('status-dot').classList.toggle('recording',state.active&&!state.paused);
  $('start').disabled=locked; $('stop').disabled=!state.active||stopping||starting;
  $('microphone').disabled=locked;
  $('cancel').hidden=!['notes','research','diagnostics'].includes(state.busy);
  $('mute').disabled=!state.active||stopping; $('pause').disabled=!state.active||stopping;
  $('mute').textContent=muted?'Unmute mic':'Mute mic';$('mute').setAttribute('aria-pressed',String(muted));
  $('pause').textContent=state.paused?'Resume':'Pause';$('pause').setAttribute('aria-pressed',String(state.paused));
  $('audio-test').textContent=state.testing?'Stop audio test':'Test audio';$('audio-test').disabled=state.active||!!state.busy||state.closing||starting||stopping;
  $('calibrate').disabled=!state.testing||!!calibration||stopping;
  $('queue').textContent=state.pending?`${state.pending} audio chunk${state.pending===1?'':'s'} pending`:state.active?'Listening':'Saved locally';
  const metrics=(!state.active&&!state.busy&&!state.pending?session?.metrics:null)||state.metrics;
  $('metrics').textContent=metrics?`Inference ${(metrics.inferenceMs/1000).toFixed(1)}s · p95 ${(metrics.p95InferenceMs/1000).toFixed(1)}s · queue ${metrics.pendingSeconds.toFixed(1)}s / ${(metrics.pendingBytes/1024).toFixed(0)} KB · RTF ${metrics.rtf.toFixed(2)} · p95 lag ${(metrics.p95LatencyMs/1000).toFixed(1)}s`:'Speech recognition runs on this PC.';
  for(const format of ['txt','md'])$('export-'+format).disabled=!session||!!state.busy||state.closing;
  $('notes-retry').hidden=!session||!session.transcript.length;$('notes-retry').disabled=locked;$('notes-retry').textContent=session?.notes?'Regenerate notes':'Generate notes';$('notes-retry').title=session?.notes?'Replace the notes and clear researched answers':'Generate meeting notes';
  $('edit-notes').hidden=!session?.notes;$('edit-notes').disabled=locked;
  $('open-session').disabled=locked||!$('history').value;$('history').disabled=locked;
  $('recover').hidden=!state.recovery.count;$('recover').disabled=locked;
  $('recovery-info').textContent=state.recovery.legacyCount?`${state.recovery.legacyCount} audio file(s) lack usable timing metadata and are preserved.`:state.recovery.count?`${state.recovery.count} pending audio record(s)` : '';
  for(const id of ['save-settings','pick-codex','diagnostics','threads','vad','codex-path','noise-threshold'])$(id).disabled=locked;
  for(const id of ['mic-gain','system-gain'])$(id).disabled=state.active||!!state.busy||state.closing||!!calibration;
  for(const id of ['summary-agent','summary-model','summary-effort','answer-agent','answer-model','answer-effort','transcript-folder','pick-transcript-folder','import-transcript','rescan','transcript-file'])$(id).disabled=locked;
  $('load-transcript').disabled=locked||!$('transcript-file').value;
  if(state.agents){const key=JSON.stringify(state.agents);if(key!==shownAgents){shownAgents=key;for(const prefix of ['summary','answer']){const selected=$(prefix+'-agent').value;$(prefix+'-agent').replaceChildren(...state.agents.map(agent=>{const option=node('option',agent.label+(agent.available?'':' (not found)'));option.value=agent.id;option.disabled=!agent.available;return option;}));$(prefix+'-agent').value=selected;}}}
  const settingsKey=JSON.stringify(state.settings);
  if(settingsKey!==shownSettings){
    const value=state.settings;shownSettings=settingsKey;
    $('mic-gain').value=value.micGain;$('system-gain').value=value.systemGain;$('noise-threshold').value=value.noiseThreshold;
    $('threads').value=value.threads;$('vad').checked=value.vad;$('codex-path').value=value.codexExecutable;$('transcript-folder').value=value.transcriptFolder||'';
    for(const prefix of ['summary','answer']){$(prefix+'-agent').value=value[prefix+'Agent'];modelControls(prefix);$(prefix+'-model').value=value[prefix+'Model'];$(prefix+'-effort').value=value[prefix+'Effort'];}gains();
  }
  $('transcript-folder').placeholder=state.scriptsDirectory||'';
  if(state.scriptFiles){const key=JSON.stringify(state.scriptFiles);if(key!==shownScripts){shownScripts=key;const selected=$('transcript-file').value;$('transcript-file').replaceChildren(...state.scriptFiles.map(name=>{const option=node('option',name);option.value=name;return option;}));if(state.scriptFiles.includes(selected))$('transcript-file').value=selected;}}
  $('load-transcript').disabled=locked||!$('transcript-file').value;
  const historyKey=JSON.stringify(state.history);
  if(historyKey!==shownHistory){
    const selected=$('history').value;shownHistory=historyKey;
    $('history').replaceChildren(...state.history.map(item=>new Option(`${new Date(item.startedAt).toLocaleString()} · ${item.status} · ${item.segments} segments`,item.id)));
    if(state.history.some(item=>item.id===selected))$('history').value=selected;
  }
  $('open-session').disabled=locked||!$('history').value;
  if(state.diagnostic)$('diagnostic-result').textContent=`${state.diagnostic.version}\nNotes: ${state.diagnostic.notesOk?'OK':'Failed'} · Search: ${state.diagnostic.searchOk?'OK':'Failed'}\n${state.diagnostic.details}`;
  showError([state.error,state.scriptSaveError,session?.status==='incomplete'?(session.incompleteReason||session.interruption||'This session is incomplete. Recover pending audio if available.'):''].filter(Boolean).join('\n'));elapsed();
  if(session&&(shownSession!==session.id||shownRevision!==(session.transcriptRevision||0))){$('transcript').replaceChildren();shownSession=session.id;shownRevision=session.transcriptRevision||0;shownSegments=0;$('history').value=session.id;}
  if(session?.transcript.length){
    const container=$('transcript'),follow=container.scrollHeight-container.scrollTop-container.clientHeight<100;
    if(shownSegments===0)container.replaceChildren();
    for(let index=shownSegments;index<session.transcript.length;index++){
      const segment=session.transcript[index],row=node('div','','transcript-row'),button=node('button','Edit','small edit-segment');button.setAttribute('aria-label',`Edit transcript at ${time(segment.start)}`);button.addEventListener('click',()=>editSegment(index));
      row.append(node('span',time(segment.start),'timestamp'),node('p',segment.text),button);container.append(row);
    }
    shownSegments=session.transcript.length;if(follow)container.scrollTop=container.scrollHeight;
  }else if(session&&!$('transcript').childNodes.length){
    const empty=node('div','','empty');empty.append(node('h3',state.active?'Listening to the conversation…':'No speech recorded yet'),node('p','Short audio chunks appear here after recognition finishes.'));$('transcript').append(empty);
  }
  const notesKey=JSON.stringify([session?.id,session?.notes,session?.answers,shownRevision,state.busy==='notes',session?.notesEdited]);
  if(notesKey!==shownNotes){shownNotes=notesKey;renderNotes(session,state);}
  document.querySelectorAll('.research,.edit-segment,.action-check').forEach(button=>{button.disabled=locked;});
  if(state.captureError&&state.active&&capturing&&!stopping)stop(false);
}
async function act(action){try{return await action();}catch(error){showError(error.message);}}
async function microphones(){
  const selected=$('microphone').value,devices=(await navigator.mediaDevices.enumerateDevices()).filter(device=>device.kind==='audioinput'&&device.deviceId!=='default');
  $('microphone').replaceChildren(new Option('System default microphone',''));devices.forEach((device,index)=>$('microphone').append(new Option(device.label||`Microphone ${index+1}`,device.deviceId)));$('microphone').value=selected;
}
async function release(){
  capturing=false;calibration=null;
  for(const stream of [systemStream,micStream])stream?.getTracks().forEach(track=>track.stop());
  if(context&&context.state!=='closed')await context.close();
  systemStream=null;micStream=null;context=null;worklet=null;
  $('mic-level').value=0;$('system-level').value=0;
}
function meterFrame(frame){
  $('mic-level').value=Math.min(1,frame.mic*5);$('system-level').value=Math.min(1,frame.system*5);
  $('audio-status').textContent=frame.peak>=.98?'Audio is clipping. Lower the gains.':`Raw mic ${(frame.rawMic*100).toFixed(1)}% · PC ${(frame.rawSystem*100).toFixed(1)}% · mixed peak ${(Math.min(frame.peak,9)*100).toFixed(0)}%`;
  $('audio-status').classList.toggle('clipping',frame.peak>=.98);
  if(calibration){
    calibration.push(frame.mixed);
    if(calibration.length>=30){
      const sorted=calibration.sort((a,b)=>a-b),measured=sorted[Math.ceil(sorted.length*.9)-1]*2.5;
      $('noise-threshold').value=Math.max(.0005,Math.min(.05,measured)).toFixed(4);calibration=null;
      $('settings-status').textContent='Silence measured. Stop the audio test, then save settings.';render(current);
    }
  }
}
async function start(test=false){
  if(starting||capturing)return;let failureMessage='';starting=true;render(current);showError('');
  try{
    systemStream=await navigator.mediaDevices.getDisplayMedia({audio:true,video:{frameRate:1,width:16,height:16}});
    if(!systemStream.getAudioTracks().length)throw new Error('Windows did not provide system audio. Check your output device.');
    for(const track of systemStream.getVideoTracks())track.enabled=false;
    const device=$('microphone').value;
    micStream=await navigator.mediaDevices.getUserMedia({audio:{...(device?{deviceId:{exact:device}}:{}),echoCancellation:true,noiseSuppression:true,autoGainControl:false,channelCount:1},video:false});
    if([...systemStream.getAudioTracks(),...micStream.getAudioTracks()].some(track=>track.readyState!=='live'))throw new Error('An audio device disconnected before recording started.');
    context=new AudioContext({sampleRate:16000});if(context.sampleRate!==16000)throw new Error('The audio device could not provide a 16-kHz recording context.');
    await context.audioWorklet.addModule(new URL('./audio-worklet.js',import.meta.url));
    worklet=new AudioWorkletNode(context,'meeting-audio',{numberOfInputs:2,numberOfOutputs:1,outputChannelCount:[1]});
    testMode=test;muted=false;paused=false;
    render(await (test?window.meeting.audioTest(true):window.meeting.start()));
    if(current.closing)throw new Error('The app is closing.');
    const values=test?settingsValue():current.settings;worklet.port.postMessage({micGain:values.micGain,systemGain:values.systemGain,muted,paused});
    worklet.port.onmessage=event=>{
      if(event.data.flushed){flushResolve?.();flushResolve=null;return;}
      if(event.data.pcm){if(!testMode)window.meeting.pcm(event.data.pcm);meterFrame(event.data);}
    };
    context.createMediaStreamSource(micStream).connect(worklet,0,0);context.createMediaStreamSource(new MediaStream(systemStream.getAudioTracks())).connect(worklet,0,1);
    worklet.connect(context.destination);await context.resume();capturing=true;
    for(const track of [...systemStream.getAudioTracks(),...micStream.getAudioTracks()])track.onended=()=>{if(capturing&&!stopping)act(async()=>{if(!testMode)await window.meeting.captureFailed('An audio device disconnected. This transcript may be incomplete.');await stop(false);});};
    await microphones();if(!test)await window.meeting.compact();
  }catch(error){
    const message=error.message||'Audio capture failed. Check Windows microphone permissions.';failureMessage=message;
    if(testMode)await window.meeting.audioTest(false).catch(()=>{});
    else if((await window.meeting.state()).active){await window.meeting.captureFailed(message);await window.meeting.stop(false).catch(()=>{});}
    await release();testMode=false;render(await window.meeting.state());showError(message);
  }finally{starting=false;render(await window.meeting.state());if(failureMessage)showError(failureMessage);}
}
async function stop(generateNotes=true){
  if(stopping)return;stopping=true;render(current);
  try{
    if(worklet&&!testMode)await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{flushResolve=null;reject(new Error('The final audio buffer did not finish. The transcript may be incomplete.'));},2000);
      flushResolve=()=>{clearTimeout(timer);resolve();};worklet.port.postMessage('flush');
    }).catch(error=>window.meeting.captureFailed(error.message));
    await release();
    if(testMode)await window.meeting.audioTest(false);else await window.meeting.stop(generateNotes);
  }catch(error){showError(error.message);}
  finally{testMode=false;muted=false;paused=false;stopping=false;$('audio-status').textContent='Audio capture stopped.';try{render(await window.meeting.state());}catch{}}
}
function field(parent,label,value,{multiline=false,max=8000}={}){
  const wrapper=node('label',label),input=document.createElement(multiline?'textarea':'input');input.value=value||'';input.maxLength=max;wrapper.append(input);parent.append(wrapper);return input;
}
function openEditor(title,help,build){
  $('edit-title').textContent=title;$('edit-help').textContent=help;$('edit-error').textContent='';$('edit-fields').replaceChildren();editSave=build($('edit-fields'));$('edit-dialog').showModal();
}
function editSegment(index){
  const segment=current.session.transcript[index];openEditor(`Edit transcript at ${time(segment.start)}`,'Saving a transcript correction clears generated notes and answers so they can be regenerated from the corrected text.',parent=>{
    const input=field(parent,'Transcript',segment.text,{multiline:true});input.required=true;return ()=>window.meeting.editTranscript(index,input.value);
  });
}
$('edit-notes').addEventListener('click',()=>{
  const notes=current.session.notes;openEditor('Edit notes','Evidence timestamps stay attached. Editing a question clears its previous recommended answer.',parent=>{
    const summary=field(parent,'Summary',notes.summary,{multiline:true});
    const actions=notes.actions.map((action,index)=>{const group=node('fieldset','');group.append(node('legend',`Action ${index+1}`));parent.append(group);return {task:field(group,'Task',action.task,{multiline:true}),owner:field(group,'Owner (blank if unspecified)',action.owner,{max:200}),due:field(group,'Due date (blank if unspecified)',action.due,{max:200})};});
    const questions=notes.questions.map((question,index)=>({id:question.id,input:field(parent,`Question ${index+1}`,question.question,{multiline:true})}));
    return ()=>window.meeting.editNotes({summary:summary.value,actions:actions.map(action=>({task:action.task.value,owner:action.owner.value||null,due:action.due.value||null})),questions:questions.map(question=>({id:question.id,question:question.input.value}))});
  });
});
$('edit-cancel').addEventListener('click',()=>$('edit-dialog').close());
$('edit-form').addEventListener('submit',async event=>{event.preventDefault();$('edit-save').disabled=true;try{await editSave();$('edit-dialog').close();}catch(error){$('edit-error').textContent=error.message;}finally{$('edit-save').disabled=false;}});
$('start').addEventListener('click',()=>start(false));$('stop').addEventListener('click',()=>stop(true));
$('audio-test').addEventListener('click',()=>testMode?stop(false):start(true));
$('calibrate').addEventListener('click',()=>{calibration=[];$('settings-status').textContent='Measuring 3 seconds of quiet audio. Keep silent and pause PC playback.';render(current);});
for(const name of ['mic','system'])$(name+'-gain').addEventListener('input',gains);
$('mute').addEventListener('click',()=>{muted=!muted;worklet?.port.postMessage({muted});render(current);});
$('pause').addEventListener('click',()=>act(async()=>{const value=!paused;await window.meeting.paused(value);paused=value;worklet?.port.postMessage({paused});}));
$('cancel').addEventListener('click',()=>act(()=>window.meeting.cancel()));$('notes-retry').addEventListener('click',()=>act(()=>{const regenerate=!!current.session?.notes;if(regenerate&&(current.session.notesEdited||current.session.answers.length||current.session.notes.actions.some(action=>action.done))&&!window.confirm('Regenerating replaces saved notes, resets checked actions and clears researched answers. Continue?'))return;return window.meeting.notes(regenerate);}));
$('history').addEventListener('change',()=>render(current));$('open-session').addEventListener('click',()=>act(()=>window.meeting.open($('history').value)));
$('recover').addEventListener('click',()=>act(()=>window.meeting.recover()));
$('settings-form').addEventListener('submit',event=>{event.preventDefault();act(async()=>{await window.meeting.settings(settingsValue());$('settings-status').textContent='Settings saved.';$('diagnostic-result').textContent='';});});
$('pick-codex').addEventListener('click',()=>act(async()=>{const path=await window.meeting.pickCodex();if(path)$('codex-path').value=path;}));
for(const prefix of ['summary','answer'])$(prefix+'-agent').addEventListener('change',()=>{$(prefix+'-model').value='';$(prefix+'-effort').value='';modelControls(prefix);});
$('pick-transcript-folder').addEventListener('click',()=>act(async()=>{const folder=await window.meeting.pickTranscriptFolder();if(folder)$('transcript-folder').value=folder;}));
$('transcript-file').addEventListener('change',()=>render(current));$('load-transcript').addEventListener('click',()=>act(()=>window.meeting.loadTranscript($('transcript-file').value)));
$('import-transcript').addEventListener('click',()=>act(()=>window.meeting.importTranscript()));$('rescan').addEventListener('click',()=>act(()=>window.meeting.rescan()));
$('diagnostics').addEventListener('click',()=>act(async()=>{$('diagnostic-result').textContent='Testing saved configuration…';await window.meeting.diagnostics();}));
for(const format of ['txt','md'])$('export-'+format).addEventListener('click',()=>act(async()=>{if(await window.meeting.export(format))$('saved-status').textContent=`Saved ${format==='txt'?'TXT':'Markdown'} export.`;}));
for(const tab of noteTabs){
  const button=$('tab-'+tab);button.addEventListener('click',()=>selectNotesTab(tab));
  button.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const index=noteTabs.indexOf(activeNotesTab);
    const next=event.key==='Home'?0:event.key==='End'?noteTabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+noteTabs.length)%noteTabs.length;
    selectNotesTab(noteTabs[next]);$('tab-'+noteTabs[next]).focus();
  });
}
window.meeting.onState(render);window.meeting.onClose(()=>stop(false));
window.meeting.onStop(()=>stop(true));
navigator.mediaDevices.addEventListener('devicechange',()=>microphones().catch(()=>{}));setInterval(elapsed,1000);
try{render(await window.meeting.state());await microphones();}catch(error){showError(error.message);}
