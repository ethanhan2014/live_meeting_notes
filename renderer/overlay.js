const $=id=>document.getElementById(id);let transcriptKey='';
function render(state){
  $('status').textContent=state.busy==='finishing'?'Finishing transcription…':state.paused?'Paused':state.pending?`${state.pending} audio chunks pending`:'Listening…';
  $('stop').disabled=!state.active||!!state.busy;$('error').hidden=!state.error;$('error').textContent=state.error||'';
  const session=state.session;if(!session)return;
  const container=$('transcript'),follow=container.scrollHeight-container.scrollTop-container.clientHeight<100;
  const key=JSON.stringify([session.id,session.transcript]);if(key===transcriptKey)return;transcriptKey=key;
  const scroll=container.scrollTop;container.replaceChildren();
  for(const segment of session.transcript){
    const row=document.createElement('article'),time=document.createElement('time'),text=document.createElement('p');
    const seconds=Math.floor(segment.start);time.textContent=[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(value=>String(value).padStart(2,'0')).join(':');
    text.textContent=segment.text;row.append(time,text);container.append(row);
  }
  container.scrollTop=follow?container.scrollHeight:scroll;
}
async function control(command){try{await window.meeting.compactControl(command);}catch(error){$('error').textContent=error.message;$('error').hidden=false;}}
$('stop').addEventListener('click',()=>{ $('stop').disabled=true;control('stop');});$('restore').addEventListener('click',()=>control('restore'));
window.meeting.onState(render);window.meeting.state().then(render).catch(error=>{$('error').textContent=error.message;$('error').hidden=false;});
