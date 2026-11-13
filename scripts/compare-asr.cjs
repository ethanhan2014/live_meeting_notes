const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {performance}=require('node:perf_hooks');
const {createHash}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const {encodeWav,mergeSegments}=require('../lib/audio.cjs');
const {SpeechEngine}=require('../lib/speech.cjs');
const {Recording}=require('../lib/recording.cjs');
const {loadSettings}=require('../lib/settings.cjs');
const {percentile,wavSeconds}=require('./benchmark.cjs');
const run=promisify(execFile),RATE=16000;

function words(text){return text.toLowerCase().normalize('NFKC').replaceAll('%',' percent ').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\bper cent\b/gu,'percent').trim().split(/\s+/).filter(Boolean);}
function wordErrors(reference,hypothesis){
  const expected=words(reference),actual=words(hypothesis);let previous=Array.from({length:actual.length+1},(_,i)=>i);
  for(let i=0;i<expected.length;i++){
    const current=[i+1];
    for(let j=0;j<actual.length;j++)current.push(Math.min(current[j]+1,previous[j+1]+1,previous[j]+Number(expected[i]!==actual[j])));
    previous=current;
  }
  return {errors:previous.at(-1),referenceWords:expected.length,wer:expected.length?previous.at(-1)/expected.length:null};
}
function* chunks(samples){
  for(let start=0;start<samples.length;start+=RATE*5.5){
    const end=Math.min(samples.length,start+RATE*6);yield {start,end,samples:samples.subarray(start,end)};
    if(end===samples.length)break;
  }
}
function containsPhrase(text,phrase){return (' '+words(text).join(' ')+' ').includes(' '+words(phrase).join(' ')+' ');}
function normalizeTerms(text,terms){
  let normalized=' '+words(text).join(' ')+' ';
  for(const term of terms)for(const variant of term.variants){
    // Normalized tokens contain only letters, digits and spaces, so no regex escaping is needed.
    const phrase=words(variant).join(' ');assert.ok(phrase);
    normalized=normalized.replace(new RegExp('(?<= )'+phrase+'(?= )','gu'),words(term.label).join(' '));
  }
  return normalized.trim();
}
function scoreTranscript(fixture,text,providerText){
  const terms=fixture.terms??[],reference=fixture.reference;
  return {...(reference==null?{errors:null,referenceWords:0,wer:null}:wordErrors(reference,text)),
    termNormalized:reference==null?null:wordErrors(normalizeTerms(reference,terms),normalizeTerms(text,terms)),
    falseWords:fixture.noSpeech?words(text).length:null,providerFalseWords:fixture.noSpeech?words(providerText).length:null,
    terms:terms.map(term=>({label:term.label,matched:term.variants.some(p=>containsPhrase(text,p))}))};
}
async function processStats(pid){
  assert.ok(Number.isInteger(pid)&&pid>0);
  // shortcut: child CPU sampling uses Windows, add platform sampling before running this comparison on macOS.
  const command=`$asrProcess=Get-Process -Id ${pid}; @{cpuMs=$asrProcess.TotalProcessorTime.TotalMilliseconds} | ConvertTo-Json -Compress`;
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true});return JSON.parse(stdout);
}
function sherpaConfig(workspace,threads,hotwords,endpoint=false){
  const model=path.join(workspace,'model'),suffix='-epoch-99-avg-1-chunk-16-left-128.int8.onnx';
  return {modelConfig:{transducer:{encoder:path.join(model,'encoder'+suffix),decoder:path.join(model,'decoder'+suffix),joiner:path.join(model,'joiner'+suffix)},
    tokens:path.join(model,'tokens.txt'),numThreads:threads,provider:'cpu',debug:false,modelingUnit:'bpe',bpeVocab:path.join(model,'bpe.vocab')},
    decodingMethod:hotwords?'modified_beam_search':'greedy_search',maxActivePaths:4,enableEndpoint:endpoint,rule2MinTrailingSilence:1.2,
    ...(hotwords?{hotwordsFile:path.join(workspace,'hotwords.txt'),hotwordsScore:1.5}:{})};
}
async function whisperRecognize(engine,workspace,wave){
  let transcript=[],overlapUntil=0;const raw=[];let elapsedMs=0;
  // Stress tests bypass capture's silence gate so false speech remains observable.
  for(const chunk of chunks(wave.samples)){
    const file=path.join(workspace,'inference.wav');await fs.writeFile(file,encodeWav(chunk.samples));
    const started=performance.now(),segments=await engine.transcribe(file);elapsedMs+=performance.now()-started;
    const offset=chunk.start/RATE,end=chunk.end/RATE;raw.push(...segments.map(s=>s.text));
    const shifted=segments.map(s=>({...s,start:offset+s.start,end:offset+s.end,words:s.words?.map(w=>({...w,start:offset+w.start,end:offset+w.end}))}));
    transcript=mergeSegments(transcript,shifted,Math.max(offset,overlapUntil),end);overlapUntil=end;
  }
  return {text:transcript.map(s=>s.text).join(' '),providerText:raw.join(' '),elapsedMs};
}
function sherpaRecognize(recognizer,wave){
  const stream=recognizer.createStream(),started=performance.now();let firstPartialAfterAudioSeconds=null;
  for(let start=0;start<wave.samples.length;start+=1600){
    const samples=wave.samples.subarray(start,start+1600);stream.acceptWaveform({samples,sampleRate:RATE});
    while(recognizer.isReady(stream))recognizer.decode(stream);
    if(firstPartialAfterAudioSeconds===null&&recognizer.getResult(stream).text.trim())firstPartialAfterAudioSeconds=(start+samples.length)/RATE;
  }
  stream.acceptWaveform({samples:new Float32Array(RATE*.4),sampleRate:RATE});stream.inputFinished();
  while(recognizer.isReady(stream))recognizer.decode(stream);
  const result=recognizer.getResult(stream),elapsedMs=performance.now()-started;
  assert.equal(typeof result.text,'string');assert.ok(Array.isArray(result.timestamps));
  const transcript=mergeSegments([],[{start:0,end:wave.samples.length/RATE,text:result.text}],0,wave.samples.length/RATE);
  return {text:transcript.map(s=>s.text).join(' '),providerText:result.text,elapsedMs,firstPartialAfterAudioSeconds,
    tokenTimestamps:result.timestamps,outOfRangeTokenTimestamps:result.timestamps.filter(t=>!Number.isFinite(t)||t<0||t>wave.samples.length/RATE).length};
}
async function measureFixtures(fixtures,recognize){
  const results=[];
  for(const fixture of fixtures){
    const outputs=[];for(let i=0;i<3;i++)outputs.push(await recognize(fixture.wave));
    const last=outputs.at(-1),timings=outputs.map(o=>o.elapsedMs),durationSeconds=fixture.wave.samples.length/RATE;
    results.push({name:fixture.name,kind:fixture.kind,voice:fixture.voice,sha256:fixture.sha256,reference:fixture.reference??null,durationSeconds,runs:outputs,
      ...scoreTranscript(fixture,last.text,last.providerText),p50InferenceMs:percentile(timings,.5),maxInferenceMs:Math.max(...timings),
      rtf:timings.reduce((a,b)=>a+b,0)/(3*durationSeconds*1000),
    });
    console.log(JSON.stringify({fixture:fixture.name,text:last.text,rtf:results.at(-1).rtf}));
  }
  return results;
}
async function pace(samples,feed){
  const started=performance.now();
  for(let i=0;i<samples.length;i+=1600){await delay(Math.max(0,started+i/RATE*1000-performance.now()));await feed(samples.subarray(i,i+1600),started);}
}
async function pacedWhisper(resources,settings,workspace,samples){
  const engine=new SpeechEngine(resources,{threads:settings.threads,vad:settings.vad});let firstSavedTextMs=null,started;
  const recording=new Recording(path.join(workspace,'paced-whisper-sessions'),engine,()=>{if(started&&firstSavedTextMs===null&&recording.session.transcript.length)firstSavedTextMs=performance.now()-started;});
  recording.threshold=settings.noiseThreshold;
  try{
    await recording.start();await pace(samples,(frame,origin)=>{started=origin;recording.push(frame);});await recording.stop();
    return {mode:'paced PCM replay through the current Recording pipeline; no microphone capture',firstSavedTextMs,totalMs:performance.now()-started,text:recording.session.transcript.map(s=>s.text).join(' ')};
  }finally{engine.close();}
}
async function pacedSherpa(sherpa,config,samples){
  const recognizer=new sherpa.OnlineRecognizer({...config,enableEndpoint:true}),stream=recognizer.createStream(),final=[];
  let firstPartialMs=null,firstEndpointMs=null,started;
  await pace(samples,(frame,origin)=>{
    started=origin;stream.acceptWaveform({samples:frame,sampleRate:RATE});while(recognizer.isReady(stream))recognizer.decode(stream);
    const result=recognizer.getResult(stream);
    if(firstPartialMs===null&&result.text.trim())firstPartialMs=performance.now()-started;
    if(recognizer.isEndpoint(stream)){if(result.text.trim()){final.push(result.text);firstEndpointMs??=performance.now()-started;}recognizer.reset(stream);}
  });
  stream.inputFinished();while(recognizer.isReady(stream))recognizer.decode(stream);
  const result=recognizer.getResult(stream);if(result.text.trim())final.push(result.text);
  return {mode:'paced PCM replay through a standalone streaming prototype; partial text is provisional',firstPartialMs,firstEndpointMs,totalMs:performance.now()-started,text:final.join(' ')};
}
function selfCheck(){
  assert.deepEqual(words('ACDOCA, 8%'),['acdoca','8','percent']);
  assert.deepEqual(wordErrors('one two three four','one two five four'),{errors:1,referenceWords:4,wer:.25});
  assert.equal(wordErrors('one two','one two three').errors,1);assert.equal(wordErrors('one two','one').errors,1);
  assert.equal(wordErrors('','noise').wer,null);assert.equal(wordErrors('','noise').errors,1);
  assert.ok(containsPhrase('The discount is 8%.','8 percent'));assert.ok(!containsPhrase('The discount is 88%.','8 percent'));
  const percentage={reference:'The discount is eight percent.',terms:[{label:'8 percent',variants:['eight percent','8%']}]};
  assert.equal(scoreTranscript(percentage,'The discount is 8%.','').termNormalized.errors,0);
  assert.equal(scoreTranscript(percentage,'The discount is EIGHT PER CENT.','').errors,0);
  assert.equal(scoreTranscript(percentage,'The discount is 88%.','').termNormalized.errors,1);
  assert.equal(scoreTranscript(percentage,'The discount is 88%.','').terms[0].matched,false);
  assert.equal(normalizeTerms('eight percent eight percent',percentage.terms),'8 percent 8 percent');
  assert.equal(percentage.reference,'The discount is eight percent.');
  assert.equal(scoreTranscript({reference:null},'unknown','').errors,null);
  assert.equal([...chunks(new Float32Array(RATE*6))].length,1);
  const split=[...chunks(new Float32Array(RATE*6.625))];assert.equal(split.length,2);assert.equal(split[1].start/RATE,5.5);
  assert.ok(split.every(c=>wavSeconds(encodeWav(c.samples))<=6));console.log('ASR comparison self-check passed.');
}
async function main(workspace,fixtureFile='fixtures.json',resultFile='results.json'){
  if(workspace==='--self-check'){selfCheck();return;}
  if(!workspace||process.platform!=='win32')throw new Error('Run on Windows: node --expose-gc scripts/compare-asr.cjs <benchmark-workspace>');
  const sherpa=require(path.join(workspace,'node_modules','sherpa-onnx-node')),root=path.resolve(__dirname,'..'),resources=path.join(root,'resources');
  const settings=await loadSettings(path.join(process.env.APPDATA,'Live Meeting Notes','settings.json'));
  const manifest=JSON.parse(await fs.readFile(path.resolve(workspace,fixtureFile),'utf8'));
  const fixtures=await Promise.all(manifest.map(async f=>{const file=path.resolve(workspace,f.file),wave=sherpa.readWave(file);assert.equal(wave.sampleRate,RATE);assert.ok(wave.samples.length>0&&wave.samples.every(Number.isFinite));return {...f,wave,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')};}));
  const whisperResources=JSON.parse(await fs.readFile(path.join(resources,'manifest.json'),'utf8'));
  const report={createdAt:new Date().toISOString(),mode:'three unpaced recognitions per fixture plus paced PCM latency replay; no live meeting hardware capture',
    machine:{platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,logicalCPUs:os.cpus().length,node:process.version},
    settings:{threads:settings.threads,vad:settings.vad,noiseThreshold:settings.noiseThreshold},
    hotwords:(await fs.readFile(path.join(workspace,'hotwords.txt'),'utf8')).trim().split(/\r?\n/),
    versions:{sherpa:require(path.join(workspace,'node_modules','sherpa-onnx-node','package.json')).version,whisper:whisperResources.whisperBuild,whisperBaseModelSha256:whisperResources.files['models/ggml-base.en.bin']},
    notes:['Lexical WER ignores case/punctuation and normalizes percent symbols and per cent. Term-normalized WER additionally equates only the listed fixture aliases, including eight percent and 8%.',
      'Provider text precedes transcript guards. Whisper uses 6-second windows with 0.5-second overlap; Zipformer processes continuous 100-ms frames.',
      'CPU includes each recognizer and its JavaScript wrapper; model startup is excluded. Silence tests bypass the capture silence gate.',
      'Paced first saved Whisper text and first provisional Zipformer text have different finalization semantics.'],
    modelSource:JSON.parse(await fs.readFile(path.join(workspace,'model-source.json'),'utf8')),engines:[]};
  const engine=new SpeechEngine(resources,{threads:settings.threads,vad:settings.vad});
  try{
    const started=performance.now();await engine.start();const startupMs=performance.now()-started;
    const workerBefore=await processStats(engine.child.pid),nodeBefore=process.cpuUsage();
    const results=await measureFixtures(fixtures,wave=>whisperRecognize(engine,workspace,wave));
    const nodeAfter=process.cpuUsage(nodeBefore),workerAfter=await processStats(engine.child.pid);
    report.engines.push({id:'whisper-base.en',startupMs,cpuMs:(nodeAfter.user+nodeAfter.system)/1000+workerAfter.cpuMs-workerBefore.cpuMs,results});
  }finally{engine.close();}
  for(const hotwords of [false,true]){
    global.gc?.();const started=performance.now(),config=sherpaConfig(workspace,settings.threads,hotwords),recognizer=new sherpa.OnlineRecognizer(config),startupMs=performance.now()-started;
    const before=process.cpuUsage(),results=await measureFixtures(fixtures,wave=>sherpaRecognize(recognizer,wave)),after=process.cpuUsage(before);
    report.engines.push({id:hotwords?'zipformer-hotwords':'zipformer-greedy',config,startupMs,cpuMs:(after.user+after.system)/1000,results});
  }
  const paced=fixtures.find(f=>f.name==='jfk');
  if(paced){
    const samples=new Float32Array(paced.wave.samples.length+RATE*2);samples.set(paced.wave.samples);
    report.pacedWhisper=await pacedWhisper(resources,settings,workspace,samples);global.gc?.();
    report.pacedZipformer=await pacedSherpa(sherpa,sherpaConfig(workspace,settings.threads,true,true),samples);
  }else report.notes.push('Paced latency replay skipped: this manifest has no JFK fixture.');
  const destination=path.resolve(workspace,resultFile);await fs.writeFile(destination,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log('Results saved: '+destination);
}
if(require.main===module)main(...process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={scoreTranscript};
