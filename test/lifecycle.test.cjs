const {test}=require('node:test');
const assert=require('node:assert/strict');
const {drainForShutdown}=require('../lib/lifecycle.cjs');
test('shutdown drains accepted work and preserves an interruption marker',async()=>{
 const events=[];const recording={session:{status:'recording'},stop:async()=>{events.push('drain');recording.session.status='complete';}};
 await drainForShutdown(recording,{close:()=>events.push('close')},async()=>events.push('save'),{reason:'Renderer crashed',timeoutMs:100});
 assert.equal(recording.session.status,'incomplete');assert.equal(recording.session.interruption,'Renderer crashed');assert.deepEqual(events,['drain','save']);
});
test('shutdown deadline aborts inference and saves incomplete state',async()=>{
 let aborted=false,saved=false;
 const recording={session:{status:'recording'},stop:()=>new Promise(()=>{})};
 await drainForShutdown(recording,{close:()=>{aborted=true;}},async()=>{saved=true;},{timeoutMs:10});
 assert.equal(aborted,true);assert.equal(saved,true);assert.equal(recording.session.status,'incomplete');assert.match(recording.failure.message,/deadline/);
});
test('shutdown waits for recovery and marks a stalled recovery incomplete at the deadline',async()=>{
 const recording={session:{status:'incomplete'},recovering:new Promise(()=>{}),stop:()=>Promise.resolve()};let closed=false,saved=false;
 await drainForShutdown(recording,{close(){closed=true;}},async()=>{saved=true;},{timeoutMs:10});
 assert.equal(closed,true);assert.equal(saved,true);assert.match(recording.session.incompleteReason,/deadline/);
});
test('shutdown deadline cannot erase a committed chunk after its audio has been deleted',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
 const {Recording}=require('../lib/recording.cjs'),{saveSession,loadSession}=require('../lib/session.cjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-shutdown-race-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let release,entered,closed;const held=new Promise(resolve=>{entered=resolve;}),deadline=new Promise(resolve=>{closed=resolve;});
 const engine={start:async()=>{},transcribe:async()=>[{start:0,end:1,text:'Last accepted words.'}],close:()=>closed()};
 const recording=new Recording(root,engine,()=>{});await recording.start();const destination=path.join(root,recording.session.id+'.json');
 const rename=fs.rename;let replacements=0;
 t.mock.method(fs,'rename',async(...args)=>{if(args[1]===destination&&++replacements===1){entered();await new Promise(resolve=>{release=resolve;});}return rename(...args);});
 recording.push(new Float32Array(16000).fill(.1));const stopping=recording.stop().catch(()=>{});await held;
 const shutdown=drainForShutdown(recording,engine,()=>saveSession(root,recording.session),{timeoutMs:10});await deadline;
 assert.equal(replacements,1);release();await shutdown;await stopping;
 const saved=await loadSession(root,recording.session.id);assert.equal(saved.transcript[0].text,'Last accepted words.');assert.equal(saved.processedChunks.length,1);assert.equal(saved.status,'incomplete');
 assert.deepEqual(await fs.readdir(path.join(root,recording.session.id+'.audio')),[]);
});
