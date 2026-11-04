const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');

async function main() {
  const targets=await (await fetch(`http://127.0.0.1:${process.env.MEETING_SMOKE_PORT||9236}/json/list`)).json();
  const target=targets.find(value => value.type === 'page' && value.title === 'Live Meeting Notes');
  assert.ok(target,'Launch the app with --remote-debugging-port=9236 first.');
  const socket=new WebSocket(target.webSocketDebuggerUrl);let id=0;const requests=new Map();
  await new Promise((resolve,reject) => {socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event => {
    const value=JSON.parse(event.data);const request=requests.get(value.id);
    if (request) {requests.delete(value.id);value.error ? request.reject(new Error(value.error.message)) : request.resolve(value.result);}
  });
  function call(method,params={},sessionId) {
    return new Promise((resolve,reject) => {const key=++id;requests.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method,params,...(sessionId?{sessionId}:{})}));});
  }
  async function evaluate(expression,sessionId) {
    const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true},sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  try {
    let state;
    for (let attempt=0;attempt < 80;attempt++) {
      state=await evaluate('window.meeting.state()');
      if (state.ready) break;
      if (state.error) throw new Error(state.error);
      await new Promise(resolve => setTimeout(resolve,250));
    }
    assert.equal(state.ready,true,'Speech model did not become ready.');
    if(process.env.MEETING_SMOKE_SCRIPTS){assert.equal(state.settings.transcriptFolder,process.env.MEETING_SMOKE_SCRIPTS,'The app did not use isolated test settings.');assert.equal(state.session,null,'Packaged startup unexpectedly loaded a meeting.');}
    assert.equal(await evaluate('document.querySelector("h1").textContent'),'Live Meeting Notes');
    assert.equal(await evaluate('document.getElementById("start").disabled'),false);
    const screenshot=await call('Page.captureScreenshot',{format:'png'});
    await fs.writeFile(path.resolve('ui-startup.png'),Buffer.from(screenshot.data,'base64'));
    console.log('Native UI ready; startup screenshot saved.');
    if(process.argv.includes('--synthetic')){
      const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-speech-'));
      let wav;
      try{
        const output=path.join(temporary,'speech.wav').replaceAll("'","''");
        const command=`Add-Type -AssemblyName System.Speech; $meetingVoice=New-Object System.Speech.Synthesis.SpeechSynthesizer; $meetingVoice.SetOutputToWaveFile('${output}'); $meetingVoice.Speak('This is a test meeting. Alex will check the release date. The due date has not been decided. We need to confirm the latest Node release.'); $meetingVoice.Dispose()`;
        const execute=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true},error=>error?reject(error):resolve()));
        if(process.platform==='darwin'){
          const aiff=path.join(temporary,'speech.aiff');
          await execute('say',['-o',aiff,'This is a test meeting. Alex will check the release date. The due date has not been decided. We need to confirm the latest Node release.']);
          await execute('afconvert',['-f','WAVE','-d','LEI16','-c','1',aiff,path.join(temporary,'speech.wav')]);
        }else await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',command]);
        wav=(await fs.readFile(path.join(temporary,'speech.wav'))).toString('base64');
      }finally{await fs.rm(temporary,{recursive:true,force:true});}
      await evaluate(`window.__syntheticContexts=[];
        navigator.mediaDevices.getDisplayMedia=async()=>{
          const ctx=new AudioContext(),destination=ctx.createMediaStreamDestination(),source=ctx.createBufferSource();window.__syntheticContexts.push(ctx);
          source.buffer=await ctx.decodeAudioData(Uint8Array.from(atob(${JSON.stringify(wav)}),c=>c.charCodeAt(0)).buffer);source.loop=true;source.connect(destination);source.start(ctx.currentTime+1);
          const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;canvas.getContext('2d').fillRect(0,0,16,16);
          return new MediaStream([...destination.stream.getAudioTracks(),...canvas.captureStream(1).getVideoTracks()]);
        };
        navigator.mediaDevices.getUserMedia=async()=>{
          const ctx=new AudioContext(),destination=ctx.createMediaStreamDestination(),source=ctx.createConstantSource();window.__syntheticContexts.push(ctx);source.offset.value=0;source.connect(destination);source.start();return destination.stream;
        };`);
    }
    const originalSession=state.session?.id;let overlaySession;
    if(process.argv.includes('--updates')){
      assert.ok(process.env.MEETING_SMOKE_DATA,'Use an isolated smoke profile for --updates.');
      assert.ok(state.session?.notes?.actions.length,'Seed the isolated profile with the meeting fixture.');
      assert.deepEqual(state.agents.map(agent=>agent.id),['codex','claude','opencode','gemini']);
      const originalSettings=state.settings;
      await evaluate(`document.querySelector('.configuration').open=true;document.getElementById('summary-agent').value='claude';document.getElementById('summary-agent').dispatchEvent(new Event('change'));document.getElementById('summary-model').value='sonnet';document.getElementById('summary-effort').value='low';document.getElementById('answer-model').value='gpt-6-luna';document.getElementById('answer-effort').value='high';document.getElementById('settings-form').requestSubmit()`);
      for(let i=0;i<60;i++){state=await evaluate('window.meeting.state()');if(!state.busy&&state.settings.summaryAgent==='claude')break;await new Promise(resolve=>setTimeout(resolve,100));}
      assert.equal(state.settings.summaryModel,'sonnet');assert.equal(state.settings.summaryEffort,'low');assert.equal(state.settings.answerModel,'gpt-6-luna');assert.equal(state.settings.answerEffort,'high');
      await evaluate(`document.getElementById('tab-actions').click();document.querySelector('.action-check').click()`);
      for(let i=0;i<60;i++){state=await evaluate('window.meeting.state()');if(!state.busy&&state.session.notes.actions[0].done)break;await new Promise(resolve=>setTimeout(resolve,100));}
      assert.equal(state.session.notes.actions[0].done,true);assert.equal(state.session.answers.length,2);
      let file;for(let i=0;i<60;i++){state=await evaluate('window.meeting.state()');file=state.scriptFiles.find(name=>name.includes(originalSession));if(file&&(await fs.readFile(path.join(state.scriptsDirectory,file),'utf8')).includes('[x]'))break;await new Promise(resolve=>setTimeout(resolve,100));}
      assert.ok(file);assert.match(await fs.readFile(path.join(state.scriptsDirectory,file),'utf8'),/\[x\]/);
      await evaluate(`document.getElementById('transcript-file').value=${JSON.stringify(file)};document.getElementById('transcript-file').dispatchEvent(new Event('change'));document.getElementById('load-transcript').click()`);
      for(let i=0;i<60;i++){state=await evaluate('window.meeting.state()');if(!state.busy&&state.session.id===originalSession)break;await new Promise(resolve=>setTimeout(resolve,100));}
      assert.equal(state.session.notes.actions[0].done,true);
      await fs.writeFile(path.join(state.scriptsDirectory,'external-smoke.txt'),'First imported point.\r\nSecond imported point.');await evaluate('window.meeting.rescan()');
      await evaluate(`document.getElementById('transcript-file').value='external-smoke.txt';document.getElementById('transcript-file').dispatchEvent(new Event('change'));document.getElementById('load-transcript').click()`);
      for(let i=0;i<60;i++){state=await evaluate('window.meeting.state()');if(!state.busy&&state.session.id!==originalSession)break;await new Promise(resolve=>setTimeout(resolve,100));}
      assert.deepEqual(state.session.transcript.map(row=>row.text),['First imported point.','Second imported point.']);assert.equal(state.session.notes,null);
      assert.equal(await evaluate(`window.meeting.loadTranscript('../outside.txt').then(()=>false,()=>true)`),true);
      await evaluate(`window.meeting.open(${JSON.stringify(originalSession)})`);await evaluate(`window.meeting.settings(${JSON.stringify(originalSettings)})`);
      await evaluate(`document.querySelector('.configuration').open=false;document.getElementById('tab-summary').click()`);state=await evaluate('window.meeting.state()');
      console.log('Agent/model/effort controls, action completion, automatic TXT saves and transcript loading passed.');
    }
    if(process.argv.includes('--features')){
      await evaluate('document.getElementById("audio-test").click()');
      for(let i=0;i<80;i++){state=await evaluate('window.meeting.state()');if(state.testing)break;await new Promise(resolve=>setTimeout(resolve,250));}
      assert.equal(state.testing,true);assert.equal(state.session?.id,originalSession,'Audio test created a session.');
      await new Promise(resolve=>setTimeout(resolve,300));
      await evaluate('document.getElementById("calibrate").click()');await new Promise(resolve=>setTimeout(resolve,3300));
      assert.match(await evaluate('document.getElementById("settings-status").textContent'),/measured/);
      await evaluate('document.getElementById("audio-test").click()');
      for(let i=0;i<40;i++){state=await evaluate('window.meeting.state()');if(!state.testing)break;await new Promise(resolve=>setTimeout(resolve,100));}
      assert.equal(state.testing,false);assert.equal(state.session?.id,originalSession);
      // Keep the user's gains/thresholds after exercising the form, rather than saving ambient test conditions.
      await evaluate(`document.getElementById('noise-threshold').value=${JSON.stringify(state.settings.noiseThreshold)};document.getElementById('settings-form').requestSubmit()`);
      for(let i=0;i<40;i++){if((await evaluate('document.getElementById("settings-status").textContent'))==='Settings saved.')break;await new Promise(resolve=>setTimeout(resolve,100));}
      assert.equal(await evaluate('document.getElementById("settings-status").textContent'),'Settings saved.');
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".audio-levels")).display'),'flex');
      console.log('Audio test, calibration, settings and persistent meters passed.');
    }
    if (process.argv.includes('--capture')) {
      await evaluate(`window.__smokeTracks=[];
        for (const method of ['getDisplayMedia','getUserMedia']) {
          const original=navigator.mediaDevices[method].bind(navigator.mediaDevices);
          navigator.mediaDevices[method]=async (...args) => {
            const stream=await original(...args);window.__smokeTracks.push(...stream.getTracks());return stream;
          };
        }`);
      await evaluate('document.getElementById("start").click()');
      for (let attempt=0;attempt < 80;attempt++) {
        state=await evaluate('window.meeting.state()');
        const error=await evaluate('document.getElementById("error").hidden ? null : document.getElementById("error").textContent');
        if (error) throw new Error(error);
        if (state.active) break;
        await new Promise(resolve => setTimeout(resolve,250));
      }
      assert.equal(state.active,true,'Audio capture did not start.');
      assert.equal(await evaluate('window.__smokeTracks.filter(track => track.kind === "audio" && track.readyState === "live").length'),2);
      if(process.argv.includes('--features')){
        await evaluate('document.getElementById("mute").click()');assert.equal(await evaluate('document.getElementById("mute").getAttribute("aria-pressed")'),'true');
        await evaluate('document.getElementById("pause").click()');await new Promise(resolve=>setTimeout(resolve,300));assert.equal((await evaluate('window.meeting.state()')).paused,true);
        await evaluate('document.getElementById("pause").click();document.getElementById("mute").click()');await new Promise(resolve=>setTimeout(resolve,200));assert.equal((await evaluate('window.meeting.state()')).paused,false);
      }
      const powershell='$meetingVoice = New-Object System.Speech.Synthesis.SpeechSynthesizer; $meetingVoice.Volume=30; $meetingVoice.Speak("This is a test meeting. Alex will check the release date. The due date has not been decided. We need to confirm the latest Node release."); $meetingVoice.Dispose();';
      if(!process.argv.includes('--synthetic'))await new Promise((resolve,reject) => execFile(process.platform==='darwin'?'say':'powershell.exe',process.platform==='darwin'?['This is a test meeting. Alex will check the release date.']:['-NoProfile','-NonInteractive','-Command','Add-Type -AssemblyName System.Speech; '+powershell],{windowsHide:true},error => error ? reject(error) : resolve()));
      await new Promise(resolve=>setTimeout(resolve,process.argv.includes('--synthetic')?14000:1500));
      if(process.argv.includes('--updates')){
        const targets=await(await fetch(`http://127.0.0.1:${process.env.MEETING_SMOKE_PORT||9236}/json/list`)).json(),panel=targets.find(target=>target.type==='page'&&target.title==='Live transcript');assert.ok(panel,'Recording panel did not open.');
        overlaySession=(await call('Target.attachToTarget',{targetId:panel.id,flatten:true})).sessionId;
        const panelState=await evaluate(`({width:outerWidth,height:outerHeight,right:screenX+outerWidth,screenRight:screen.availLeft+screen.availWidth,top:screenY,screenTop:screen.availTop,rows:document.querySelectorAll('article').length})`,overlaySession);
        assert.equal(panelState.width,340);assert.equal(panelState.right,panelState.screenRight);assert.equal(panelState.top,panelState.screenTop);assert.ok(panelState.rows>0,'Minimized capture did not update the live panel.');
        const shot=await call('Page.captureScreenshot',{format:'png'},overlaySession);await fs.writeFile(path.resolve('ui-recording-panel.png'),Buffer.from(shot.data,'base64'));
        await evaluate(`document.getElementById('stop').click()`,overlaySession);
      }else await evaluate('document.getElementById("stop").click()');
      for(let attempt=0;attempt<1200;attempt++){
        state=await evaluate('window.meeting.state()');if(!state.active&&!state.busy)break;await new Promise(resolve=>setTimeout(resolve,500));
      }
      assert.equal(state.busy,null);assert.equal(state.error,null);assert.ok(state.session.notes?.summary);
      assert.equal(await evaluate('document.getElementById("mic-level").value'),0);assert.equal(await evaluate('document.getElementById("system-level").value'),0);
      assert.equal(await evaluate('window.__smokeTracks.every(track=>track.readyState==="ended")'),true,'Stop did not release capture devices.');
      assert.equal(state.active,false);assert.equal(state.session.status,'complete');
      if(process.argv.includes('--updates')){const targets=await(await fetch(`http://127.0.0.1:${process.env.MEETING_SMOKE_PORT||9236}/json/list`)).json();assert.ok(!targets.some(target=>target.title==='Live transcript'));assert.equal(await evaluate('document.hidden'),false);console.log('Right-edge recording panel, minimized live transcription, overlay Stop and full-window restoration passed.');}
      assert.ok(state.session.transcript.some(segment => /Alex|release|meeting/i.test(segment.text)),'System speech did not reach the transcript.');
      assert.equal(await evaluate('document.querySelectorAll(".transcript-row").length'),state.session.transcript.length);
      const captured=await call('Page.captureScreenshot',{format:'png'});
      await fs.writeFile(path.resolve('ui-transcript.png'),Buffer.from(captured.data,'base64'));
      console.log(JSON.stringify({capture:'passed',sessionId:state.session.id,segments:state.session.transcript.length,pending:state.pending}));
    }
    if(process.argv.includes('--features')&&process.argv.includes('--capture')){
      const recordingId=state.session.id;
      await evaluate('document.querySelector(".edit-segment").click()');assert.equal(await evaluate('document.getElementById("edit-dialog").open'),true);
      await evaluate('document.querySelector("#edit-fields textarea").value += " Reviewed transcript.";document.getElementById("edit-form").requestSubmit()');
      for(let i=0;i<50;i++){if(!await evaluate('document.getElementById("edit-dialog").open'))break;await new Promise(resolve=>setTimeout(resolve,100));}
      state=await evaluate('window.meeting.state()');assert.equal(state.session.notes,null);assert.equal(state.session.answers.length,0);assert.match(state.session.transcript[0].text,/Reviewed transcript/);
      await evaluate('window.meeting.notes()');state=await evaluate('window.meeting.state()');assert.ok(state.session.notes?.summary);
      await evaluate('document.getElementById("edit-notes").click()');
      await evaluate('document.querySelector("#edit-fields textarea").value += " Reviewed notes.";document.getElementById("edit-form").requestSubmit()');
      for(let i=0;i<50;i++){if(!await evaluate('document.getElementById("edit-dialog").open'))break;await new Promise(resolve=>setTimeout(resolve,100));}
      state=await evaluate('window.meeting.state()');assert.match(state.session.notes.summary,/Reviewed notes/);assert.equal(state.session.notesEdited,true);
      if(originalSession){await evaluate(`window.meeting.open(${JSON.stringify(originalSession)})`);assert.equal((await evaluate('window.meeting.state()')).session.id,originalSession);}
      await evaluate(`window.meeting.open(${JSON.stringify(recordingId)})`);state=await evaluate('window.meeting.state()');assert.match(state.session.notes.summary,/Reviewed notes/);
      assert.ok(await evaluate('document.querySelectorAll(".evidence-quote").length')>0);console.log('Transcript and notes corrections, evidence quotes and history reopen passed.');
    }
    if (process.argv.includes('--research')) {
      const questions=state.session.notes?.questions || [];
      const question=questions.find(value => /node.*release|release.*node/i.test(value.question)) || questions[0];
      assert.ok(question,'No open question available for the research check.');
      await evaluate(`window.meeting.research(${JSON.stringify(question.id)})`);
      state=await evaluate('window.meeting.state()');
      assert.equal(state.error,null);assert.equal(state.busy,null);
      assert.ok(state.session.answers.some(answer => answer.status === 'answered' && answer.sources.length));
      const researched=await call('Page.captureScreenshot',{format:'png'});
      await fs.writeFile(path.resolve('ui-notes.png'),Buffer.from(researched.data,'base64'));
      console.log('Notes and cited research displayed successfully.');
    }
    if(process.argv.includes('--diagnostics')){
      const result=await evaluate('window.meeting.diagnostics()');assert.equal(result.notesOk,true);assert.equal(result.searchOk,true);console.log(JSON.stringify({diagnostics:result}));
    }
    if(process.argv.includes('--recovery')){
      const {newSession,saveSession}=require('../lib/session.cjs'),{encodeWav}=require('../lib/audio.cjs');
      const restoreId=state.session?.id,fixture=newSession(),chunkId=newSession().id;
      fixture.status='incomplete';fixture.transcript=[{start:0,end:1,text:'Synthetic recovery baseline.'}];
      const root=path.join(process.env.MEETING_SMOKE_DATA||path.join(process.env.APPDATA,'Live Meeting Notes'),'sessions'),audioDir=path.join(root,fixture.id+'.audio');
      await saveSession(root,fixture);await fs.mkdir(audioDir);const wav=encodeWav(new Float32Array(16000));
      await fs.writeFile(path.join(audioDir,chunkId+'.wav'),wav);
      await fs.writeFile(path.join(audioDir,chunkId+'.json'),JSON.stringify({version:1,id:chunkId,sessionId:fixture.id,start:2,end:3,overlapUntil:0,wav:chunkId+'.wav',bytes:wav.length,queuedAt:new Date().toISOString()}));
      await evaluate(`window.meeting.open(${JSON.stringify(fixture.id)})`);assert.equal((await evaluate('window.meeting.state()')).recovery.count,1);
      await evaluate('document.getElementById("recover").click()');
      for(let i=0;i<300;i++){state=await evaluate('window.meeting.state()');if(!state.busy)break;await new Promise(resolve=>setTimeout(resolve,100));}
      assert.equal(state.session.processedChunks.length,1);assert.equal(state.recovery.count,0);assert.equal(state.session.transcript[0].text,'Synthetic recovery baseline.');
      const count=state.session.transcript.length;await evaluate('window.meeting.recover()');state=await evaluate('window.meeting.state()');assert.equal(state.session.transcript.length,count);
      if(restoreId)await evaluate(`window.meeting.open(${JSON.stringify(restoreId)})`);
      console.log('Native journal recovery, UI refresh and repeat-recovery deduplication passed.');
    }
    if (process.argv.includes('--close')) await evaluate('window.close()');
  } finally {if(process.argv.includes('--synthetic'))await evaluate('Promise.all(window.__syntheticContexts.map(ctx=>ctx.close()))').catch(()=>{});socket.close();}
}
main().catch(error => {console.error(error.message);process.exitCode=1;});
