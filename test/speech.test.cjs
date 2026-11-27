const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {SpeechEngine}=require('../lib/speech.cjs');
const fixture=path.join(__dirname,'fixtures','whisperx-worker.py');
function engine(t,options={}){const value=new SpeechEngine(path.dirname(fixture),{worker:fixture,pythonExecutable:process.platform==='win32'?'python':'python3',...options});t.after(()=>value.close());return value;}
test('WhisperX starts once, transcribes aligned words, and restarts after close',async t=>{
 const value=engine(t);await Promise.all([value.start(),value.start()]);assert.equal(value.ready,true);
 assert.equal((await value.transcribe('sample.wav'))[0].words[0].word,' Hello world');
 value.close();assert.equal(value.ready,false);await value.start();assert.equal(value.ready,true);
});
test('capture stop delivers the last audio frame before acknowledging Stop',async t=>{
 const frames=[],value=engine(t,{onAudio:frame=>frames.push(frame)});
 assert.equal((await value.devices())[0].id,'mic');await value.stopCapture();assert.deepEqual(frames[0].pcm,[.1,.2]);
});
test('a missing Python interpreter fails clearly and permits retry',async t=>{
 const value=engine(t,{pythonExecutable:path.join(__dirname,'missing-python')});
 await assert.rejects(value.start(),/Python|ENOENT/);await assert.rejects(value.start(),/Python|ENOENT/);assert.equal(value.ready,false);
});
test('closing the worker rejects pending requests',async t=>{
 const value=engine(t);const pending=value.start();value.close();await assert.rejects(pending,/closed/);
});
test('speech validates inference configuration',()=>{
 for(const options of [{threads:0},{threads:17},{batchSize:0},{speechModel:'../../model'}])assert.throws(()=>new SpeechEngine('unused',options),/settings/);
});
test('portable speech uses its bundled model cache',async t=>{
 const previous=process.env.MEETING_MODEL_CACHE;process.env.MEETING_MODEL_CACHE=path.join(__dirname,'portable-models');
 t.after(()=>{if(previous===undefined)delete process.env.MEETING_MODEL_CACHE;else process.env.MEETING_MODEL_CACHE=previous;});
 const value=new SpeechEngine('unused');let options;
 value.request=(method,input)=>{options=input;return Promise.resolve();};
 await value.start();assert.equal(options.cache,process.env.MEETING_MODEL_CACHE);
});
