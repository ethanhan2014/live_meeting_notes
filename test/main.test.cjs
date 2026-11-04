const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {CodexJobs}=require('../lib/codex.cjs');

test('Cancel during the initial session save prevents the notes job from sending context', async () => {
  let release,started,runs=0,saves=0;
  const saving=new Promise(resolve => {started=resolve;});
  const jobs=new CodexJobs('unused');
  jobs.run=async () => {runs++;return {value:{summary:'Notes',actions:[],questions:[]}};};
  const context=vm.createContext({jobs,root:'unused',recording:{session:{status:'complete',notes:null,transcript:[{start:0,end:1,text:'Test'}]}},
    changed(){},finishClose(){},saveSession:async () => {if (++saves === 1) {started();await new Promise(resolve => {release=resolve;});}},
    commitSession:async (_root,session,changes) => Object.assign(session,changes)});
  const source=fs.readFileSync(require.resolve('../main.cjs'),'utf8');
  const noteFunction=source.slice(source.indexOf('async function notes('),source.indexOf('\napp.whenReady()'));
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
 const source=fs.readFileSync(require.resolve('../main.cjs'),'utf8');vm.runInContext(source.slice(source.indexOf('async function notes('),source.indexOf('\napp.whenReady()')),context);
 await assert.rejects(vm.runInContext('notes(true)',context),/unavailable/);
 assert.equal(session.notes,oldNotes);assert.equal(session.answers,answers);assert.equal(saves.at(-1).status,'complete');
 jobs.notes=async()=>({summary:'New summary',actions:[],questions:[]});await vm.runInContext('notes(true)',context);
 assert.equal(session.notes.summary,'New summary');assert.equal(session.answers.length,0);assert.equal(session.status,'complete');
});
test('automatic TXT saves serialize snapshots and a folder failure leaves recording intact',async()=>{
 const session=structuredClone(require('./fixtures/meeting.json')),writes=[];
 const context=vm.createContext({structuredClone,recording:{session,active:true},scriptKey:'',scriptWrites:Promise.resolve(),scriptFiles:[],window:null,overlay:null,
  transcriptDirectory:()=>'/scripts',state:()=>({}),listTranscripts:async()=>[],safeError:String,saveTranscript:async(_folder,value)=>{writes.push(value);throw new Error('folder unavailable');}});
 const source=fs.readFileSync(require.resolve('../main.cjs'),'utf8');vm.runInContext(source.slice(source.indexOf('function broadcast()'),source.indexOf('function trusted(')),context);
 await vm.runInContext('changed();scriptWrites',context);assert.equal(context.recording.active,true);assert.match(context.scriptSaveError,/folder unavailable/);assert.equal(session.notes.actions[0].done,undefined);
 context.saveTranscript=async(_folder,value)=>writes.push(value);session.notes.actions[0].done=true;await vm.runInContext('changed();scriptWrites',context);
 assert.equal(writes[0].notes.actions[0].done,undefined);assert.equal(writes[1].notes.actions[0].done,true);assert.equal(context.scriptSaveError,null);
});
test('compact recording panel fits at the right edge of the current monitor',()=>{
 const context=vm.createContext({});const source=fs.readFileSync(require.resolve('../main.cjs'),'utf8');vm.runInContext(source.slice(source.indexOf('function compactBounds('),source.indexOf('function restoreWindow(')),context);
 context.area={x:-1920,y:40,width:1920,height:1040};const bounds=vm.runInContext('compactBounds(area)',context);
 assert.equal(bounds.x+bounds.width,0);assert.equal(bounds.width,340);assert.equal(bounds.y,40);assert.equal(bounds.height,1040);
 context.area={x:100,y:0,width:300,height:600};assert.equal(vm.runInContext('compactBounds(area).width',context),300);
});
