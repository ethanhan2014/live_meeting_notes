const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {AIJobs}=require('../lib/ai.cjs');
const path=require('node:path');

test('a capture failure during initial persistence stops and marks the session incomplete',async()=>{
 for(const kind of ['device','worker']){
 let options,stops=0;const handlers=new Map();
 const recording={active:false,session:null,start:async()=>{if(kind==='device')options.onCaptureError('Device disconnected');else options.onState({failure:new Error('Worker disconnected')});recording.session={};recording.active=true;},stop:async()=>{stops++;recording.active=false;recording.session.status='incomplete';}};
 const speech={startCapture:async()=>{},stopCapture:async()=>{}};
 const context=vm.createContext({SpeechEngine:class{constructor(_resources,value){options=value;}},resources:'unused',settings:{},speechState(){},testing:false,safeError:String,recording,speech,changed(){},idle(){},ensureSpeech:async()=>{},refresh:async()=>{},finishClose(){},state:()=>({}),handle:(name,action)=>handlers.set(name,action),closing:false});
 const source=fs.readFileSync(require.resolve('../main.cjs'),'utf8');
 vm.runInContext(source.slice(source.indexOf('function speechState('),source.indexOf('async function ensureSpeech('))+source.slice(source.indexOf('function makeSpeech()'),source.indexOf('async function initialize()'))+source.slice(source.indexOf("  handle('meeting-devices'"),source.indexOf("  handle('meeting-capture-failed'")),context);
 vm.runInContext('makeSpeech()',context);
 await assert.rejects(handlers.get('meeting-start')({microphone:''}),/disconnected/);
 assert.equal(stops,1);assert.equal(recording.session.status,'incomplete');assert.match(recording.failure.message,/disconnected/);
 }
});
test('worker death while quiet marks capture failed even without a queued chunk',()=>{
 const context=vm.createContext({error:null,captureFailure:null,safeError:String,testing:false,recording:{active:true,session:{}},changed(){}});
 const source=fs.readFileSync(require.resolve('../main.cjs'),'utf8');vm.runInContext(source.slice(source.indexOf('function speechState('),source.indexOf('async function ensureSpeech(')),context);
 context.failure={failure:new Error('Worker exited')};vm.runInContext('speechState(failure)',context);
 assert.equal(context.captureFailure,'Worker exited');assert.match(context.recording.failure.message,/Worker exited/);
});

test('Cancel during the initial session save prevents the notes job from sending context', async () => {
  let release,started,runs=0,saves=0;
  const saving=new Promise(resolve => {started=resolve;});
  const jobs=new AIJobs({});
  jobs.run=async () => {runs++;return {value:{summary:'Notes',actions:[],questions:[]}};};
  const context=vm.createContext({jobs,root:'unused',recording:{session:{status:'complete',notes:null,transcript:[{start:0,end:1,text:'Test'}]}},
    changed(){},finishClose(){},saveSession:async () => {if (++saves === 1) {started();await new Promise(resolve => {release=resolve;});}},
    commitSession:async (_root,session,changes) => Object.assign(session,changes)});
  const source=fs.readFileSync(require.resolve('../main.cjs'),'utf8');
  const noteFunction=source.slice(source.indexOf('async function notes('),source.indexOf('\nfunction makeSpeech()'));
  vm.runInContext(noteFunction,context);
  const pending=vm.runInContext('notes()',context);
  await saving;jobs.cancel();release();
  await assert.rejects(pending,/cancelled/);assert.equal(runs,0);assert.equal(jobs.cancelled,true);
});
test('saving settings or edits excludes recording start and other mutations until persistence finishes',async()=>{
  let release;const context=vm.createContext({busy:null,closing:false,testing:false,recording:{active:false},error:null,
    changed(){},finishClose(){},refresh:async()=>{},state:()=>({}),save:()=>new Promise(resolve=>{release=resolve;})});
  const source=fs.readFileSync(require.resolve('../main.cjs'),'utf8');
  vm.runInContext(source.slice(source.indexOf('function idle()'),source.indexOf('async function refresh()'))+source.slice(source.indexOf('async function mutation('),source.indexOf('function speechState(')),context);
  const saving=vm.runInContext('mutation(save)',context);assert.throws(()=>vm.runInContext('idle()',context),/Finish/);
  release();await saving;assert.doesNotThrow(()=>vm.runInContext('idle()',context));
});
test('regeneration preserves saved notes and answers on failure, then replaces them only after a successful save',async()=>{
 const oldNotes={summary:'Reviewed summary',actions:[],questions:[]},answers=[{questionId:'q1',answer:'Reviewed answer'}],saves=[];
 const session={status:'complete',notes:oldNotes,answers,transcript:[{start:0,end:1,text:'Test.'}]};
 const jobs={cancelled:false,notes:async()=>{throw new Error('provider unavailable');}};
 const context=vm.createContext({jobs,root:'unused',recording:{session},changed(){},finishClose(){},saveSession:async(_root,value)=>saves.push(structuredClone(value)),commitSession:async(_root,value,changes)=>Object.assign(value,changes)});
 const source=fs.readFileSync(require.resolve('../main.cjs'),'utf8');vm.runInContext(source.slice(source.indexOf('async function notes('),source.indexOf('\nfunction makeSpeech()')),context);
 await assert.rejects(vm.runInContext('notes(true)',context),/unavailable/);
 assert.equal(session.notes,oldNotes);assert.equal(session.answers,answers);assert.equal(saves.at(-1).status,'complete');
 jobs.notes=async()=>({summary:'New summary',actions:[],questions:[]});await vm.runInContext('notes(true)',context);
 assert.equal(session.notes.summary,'New summary');assert.equal(session.answers.length,0);assert.equal(session.status,'complete');
});
test('automatic TXT saves serialize snapshots and a folder failure leaves recording intact',async()=>{
 const session=structuredClone(require('./fixtures/meeting.json')),writes=[];
 const context=vm.createContext({structuredClone,recording:{session,active:true},scriptKey:'',scriptWrites:Promise.resolve(),scriptFiles:[],send(){},
  transcriptDirectory:()=>'/scripts',state:()=>({}),listTranscripts:async()=>[],safeError:String,saveTranscript:async(_folder,value)=>{writes.push(value);throw new Error('folder unavailable');}});
 const source=fs.readFileSync(require.resolve('../main.cjs'),'utf8');vm.runInContext(source.slice(source.indexOf('function broadcast()'),source.indexOf('function finishClose(')),context);
 await vm.runInContext('changed();scriptWrites',context);assert.equal(context.recording.active,true);assert.match(context.scriptSaveError,/folder unavailable/);assert.equal(session.notes.actions[0].done,undefined);
 context.saveTranscript=async(_folder,value)=>writes.push(value);session.notes.actions[0].done=true;await vm.runInContext('changed();scriptWrites',context);
 assert.equal(writes[0].notes.actions[0].done,undefined);assert.equal(writes[1].notes.actions[0].done,true);assert.equal(context.scriptSaveError,null);
});
