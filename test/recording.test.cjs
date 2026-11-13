const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {Recording} = require('../lib/recording.cjs');
const {newSession,saveSession,loadSession}=require('../lib/session.cjs');
const {encodeWav}=require('../lib/audio.cjs');

async function pending(t,{start=30,end=31,overlapUntil=0,committed=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-replay-'));t.after(() => fs.rm(root,{recursive:true,force:true}));
  const session=newSession();session.status='incomplete';const id=newSession().id;
  if(committed) {session.processedChunks=[id];session.transcript=[{start,end,text:'Already saved.'}];}
  await saveSession(root,session);const dir=path.join(root,session.id+'.audio');await fs.mkdir(dir);
  const wav=encodeWav(new Float32Array(Math.round((end-start)*16000)).fill(.1));
  const manifest={version:1,id,sessionId:session.id,start,end,overlapUntil,wav:id+'.wav',bytes:wav.length,queuedAt:'2026-11-04T15:00:00.000Z'};
  await fs.writeFile(path.join(dir,id+'.wav'),wav);await fs.writeFile(path.join(dir,id+'.json'),JSON.stringify(manifest));
  return {root,session,id,dir,manifest};
}

test('Stop waits for the last accepted utterance and saves it before deleting audio', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-drain-'));t.after(() => fs.rm(root,{recursive:true,force:true}));
  let finish;
  const engine={start:async()=>{},transcribe:() => new Promise(resolve => {finish=resolve;})};
  const recording=new Recording(root,engine,()=>{});
  await recording.start();recording.push(new Float32Array(16000).fill(.1));
  let stopped=false;const stopping=recording.stop().then(() => {stopped=true;});
  while (!finish) await new Promise(resolve => setTimeout(resolve,5));
  assert.equal(stopped,false);
  finish([{start:0,end:1,text:'The final words.'}]);await stopping;
  const stored=JSON.parse(await fs.readFile(path.join(root,recording.session.id+'.json'),'utf8'));
  assert.equal(stored.transcript[0].text,'The final words.');assert.equal(stored.status,'complete');
  assert.deepEqual(await fs.readdir(path.join(root,recording.session.id+'.audio')),[]);
});
test('recording saves and exports filtered, bounded recognition results before cleaning up audio',async t=>{
  const {root,session,id,dir}=await pending(t,{start:1250.4,end:1256.4});
  const segments=[{start:0,end:1.49,text:'a'+'w'.repeat(56)},...Array.from({length:6},()=>({start:1.49,end:1.49,text:'w'.repeat(60)})),{start:1.49,end:30,text:'w'.repeat(16)},
    {start:1.5,end:3.9,text:'Fiscal year.'},{start:1.5,end:3.9,text:'Fiscal year.'},{start:4,end:30,text:'Confirm the date.'},{start:31,end:32,text:'Outside audio.'}];
  const recording=new Recording(root,{start:async()=>{},transcribe:async()=>segments},()=>{});recording.session=session;
  await recording.recover();const saved=await loadSession(root,session.id);
  assert.deepEqual(saved.transcript,[{start:1251.9,end:1254.3000000000002,text:'Fiscal year.'},{start:1254.4,end:1256.4,text:'Confirm the date.'}]);
  assert.deepEqual(saved.processedChunks,[id]);assert.deepEqual(await fs.readdir(dir),[]);
  const {exportSession}=require('../lib/session.cjs');
  for(const format of ['txt','md']){const exported=exportSession(saved,format);assert.equal(exported.split('Fiscal year.').length,2);assert.ok(!exported.includes('wwww'));assert.ok(!exported.includes('Outside audio.'));}
});
test('recognition failure preserves pending audio and marks the transcript incomplete', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-failure-'));t.after(() => fs.rm(root,{recursive:true,force:true}));
  const recording=new Recording(root,{start:async()=>{},transcribe:async()=>{throw new Error('speech unavailable');}},()=>{});
  await recording.start();recording.push(new Float32Array(16000).fill(.1));
  await assert.rejects(recording.stop(),/speech unavailable/);
  const stored=JSON.parse(await fs.readFile(path.join(root,recording.session.id+'.json'),'utf8'));
  assert.equal(stored.status,'incomplete');
  assert.equal((await fs.readdir(path.join(root,recording.session.id+'.audio'))).length,2);
  const previous=recording.session.id;
  await recording.start();
  assert.notEqual(recording.session.id,previous);
  assert.equal((await fs.readdir(path.join(root,previous+'.audio'))).length,2);
});

test('manifest replay retains offsets and overlap and commits IDs before deleting audio', async t => {
  const {root,session,id,dir}=await pending(t,{start:30,end:31,overlapUntil:30.5});
  const recording=new Recording(root,{start:async()=>{},transcribe:async()=>[
    {start:0,end:.4,text:'Overlapping words.'},{start:.6,end:1,text:'Recovered words.'}]},()=>{});
  recording.session=await loadSession(root,session.id);
  assert.deepEqual(await recording.recoverable(),{count:1,bytes:32044,legacyCount:0});
  const originalRm=fs.rm;
  t.mock.method(fs,'rm',async (target,options) => {
    if(target===path.join(dir,id+'.wav')) {
      const saved=await loadSession(root,session.id);assert.deepEqual(saved.processedChunks,[id]);
      assert.deepEqual(saved.transcript,[{start:30.6,end:31,text:'Recovered words.'}]);
    }
    return originalRm(target,options);
  });
  await recording.recover();assert.equal(recording.session.status,'complete');
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('crash after commit and before deletion replays cleanup without duplicate inference or transcript', async t => {
  const {root,session,id,dir}=await pending(t);
  const engine={start:async()=>{},transcribe:async()=>[{start:0,end:1,text:'Saved once.'}]};
  const recording=new Recording(root,engine,()=>{});recording.session=session;
  const originalRm=fs.rm;
  const mock=t.mock.method(fs,'rm',async (target,options) => {
    if(target===path.join(dir,id+'.wav')) throw new Error('crash before cleanup');
    return originalRm(target,options);
  });
  await assert.rejects(recording.recover(),/crash before cleanup/);mock.mock.restore();
  const restarted=new Recording(root,{start:async()=>{throw new Error('must not start');},
    transcribe:async()=>{throw new Error('must not infer');}},()=>{});
  restarted.session=await loadSession(root,session.id);await restarted.recover();
  assert.deepEqual(restarted.session.transcript,[{start:30,end:31,text:'Saved once.'}]);
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('failed transcript save preserves in-memory state and durable chunk for later retry', async t => {
  const {root,session,dir}=await pending(t);
  const recording=new Recording(root,{start:async()=>{},transcribe:async()=>[{start:0,end:1,text:'Retry me.'}]},()=>{});
  recording.session=session;const originalRename=fs.rename;
  const mock=t.mock.method(fs,'rename',async (source,destination) => {
    if(destination===path.join(root,session.id+'.json')) throw new Error('session disk failure');
    return originalRename(source,destination);
  });
  await assert.rejects(recording.recover(),/session disk failure/);
  assert.deepEqual(session.transcript,[]);assert.equal((await fs.readdir(dir)).length,2);
  mock.mock.restore();await recording.recover();assert.equal(session.transcript.length,1);
});

test('missing or corrupt audio, unsafe manifests, and legacy WAVs remain incomplete and preserved', async t => {
  for(const problem of ['missing','corrupt','traversal','legacy','oversized','symlink']) {
    const {root,session,id,dir,manifest}=await pending(t);
    if(problem==='missing') await fs.rm(path.join(dir,id+'.wav'));
    if(problem==='corrupt') await fs.writeFile(path.join(dir,id+'.wav'),'not a WAV');
    if(problem==='traversal') await fs.writeFile(path.join(dir,id+'.json'),JSON.stringify({...manifest,wav:'../outside.wav'}));
    if(problem==='legacy') await fs.rename(path.join(dir,id+'.wav'),path.join(dir,'1.wav'));
    if(problem==='oversized') await fs.writeFile(path.join(dir,id+'.json'),' '.repeat(8192));
    if(problem==='symlink') {
      await fs.rm(path.join(dir,id+'.wav'));
      try {await fs.symlink(path.join(root,session.id+'.json'),path.join(dir,id+'.wav'),'file');}
      catch(error) {if(process.platform==='win32' && error.code==='EPERM') continue;throw error;}
    }
    const before=await fs.readdir(dir);
    const recording=new Recording(root,{start:async()=>{},transcribe:async()=>{throw new Error('must not infer invalid data');}},()=>{});
    recording.session=session;await assert.rejects(recording.recover(),/audio|manifest|legacy|regular file/i);
    assert.equal(session.status,'incomplete');assert.ok(session.incompleteReason);
    assert.deepEqual(session.transcript,[]);assert.deepEqual(await fs.readdir(dir),before);
  }
});

test('queue duration, inference p95, end-to-end latency and real-time factor use measured work', async t => {
  const {root,session,dir}=await pending(t,{start:0,end:2});
  const manifestName=(await fs.readdir(dir)).find(name => name.endsWith('.json'));
  const manifest=JSON.parse(await fs.readFile(path.join(dir,manifestName),'utf8'));
  manifest.queuedAt=new Date(1000).toISOString();await fs.writeFile(path.join(dir,manifestName),JSON.stringify(manifest));
  let now=2000;t.mock.method(Date,'now',()=>now);let finish;
  const recording=new Recording(root,{start:async()=>{},transcribe:()=>new Promise(resolve => {finish=resolve;})},()=>{});
  recording.session=session;const recovering=recording.recover();
  while(!finish) await new Promise(resolve => setTimeout(resolve,5));
  assert.equal(recording.metrics.pendingSeconds,2);assert.equal(recording.metrics.pendingBytes,64044);
  now=2500;finish([{start:0,end:2,text:'Measured speech.'}]);await recovering;
  assert.deepEqual(recording.metrics,{inferenceMs:500,p95InferenceMs:500,p95LatencyMs:1500,
    pendingSeconds:0,pendingBytes:0,rtf:.25,processedChunks:1});
});

test('p95 uses all measured chunks and replay of an empty spool keeps incomplete capture state', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-metrics-'));t.after(() => fs.rm(root,{recursive:true,force:true}));
  let now=1000;const durations=[100,300,200];
  const recording=new Recording(root,{start:async()=>{},transcribe:async()=>{
    now+=durations.shift();return [{start:0,end:2,text:'Measured chunk.'}];}},()=>{});
  await recording.start();t.mock.method(Date,'now',()=>now);
  for(let start=0;start<6;start+=2) recording.enqueue({start,end:start+2,overlapUntil:0,pcm:new Float32Array(32000).fill(.1)});
  await recording.stop();
  assert.deepEqual(recording.metrics,{inferenceMs:200,p95InferenceMs:300,p95LatencyMs:600,
    pendingSeconds:0,pendingBytes:0,rtf:.1,processedChunks:3});
  const incomplete={...recording.session,status:'incomplete',incompleteReason:'Capture ended unexpectedly.'};
  recording.session=incomplete;await recording.recover();
  assert.equal(recording.session.status,'incomplete');assert.equal(recording.session.incompleteReason,'Capture ended unexpectedly.');
  assert.equal(recording.metrics.inferenceMs,0,'changing sessions resets runtime metrics');
});

test('journal is durable before WAV replacement and failed audio writes keep known timestamps', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-spool-write-'));t.after(() => fs.rm(root,{recursive:true,force:true}));
  const recording=new Recording(root,{start:async()=>{},transcribe:async()=>{throw new Error('must not infer');}},()=>{});
  await recording.start();const originalRename=fs.rename;
  t.mock.method(fs,'rename',async(source,destination)=>{
    if(destination.endsWith('.wav')) {
      const journal=JSON.parse(await fs.readFile(destination.slice(0,-4)+'.json','utf8'));
      assert.equal(journal.start,0);assert.equal(journal.end,1);throw new Error('audio disk failure');
    }
    return originalRename(source,destination);
  });
  recording.push(new Float32Array(16000).fill(.1));await assert.rejects(recording.stop(),/audio disk failure/);
  assert.deepEqual(await recording.recoverable(),{count:1,bytes:0,legacyCount:0});
  assert.match(recording.session.incompleteReason,/audio disk failure/);
});

test('recovery keeps earlier repaired chunks in timeline order and preserves unknown spool data', async t => {
  const {root,session,dir,manifest}=await pending(t,{start:30,end:31});
  session.transcript=[{start:60,end:61,text:'Already recovered later words.'}];
  await fs.writeFile(path.join(dir,'abandoned.tmp'),'preserve me');
  const recording=new Recording(root,{start:async()=>{},transcribe:async()=>[{start:0,end:1,text:'Earlier words.'}]},()=>{});
  recording.session=session;assert.equal((await recording.recoverable()).legacyCount,1);
  await assert.rejects(recording.recover(),/Unrecognized pending audio/);
  assert.deepEqual(session.transcript,[{start:30,end:31,text:'Earlier words.'},{start:60,end:61,text:'Already recovered later words.'}]);
  assert.equal(await fs.readFile(path.join(dir,'abandoned.tmp'),'utf8'),'preserve me');
  assert.deepEqual(session.processedChunks,[manifest.id]);
});

test('committed journal cleanup succeeds after a crash already removed its WAV', async t => {
  const {root,session,id,dir}=await pending(t,{committed:true});await fs.rm(path.join(dir,id+'.wav'));
  const recording=new Recording(root,{start:async()=>{throw new Error('must not infer');}},()=>{});
  recording.session=session;await recording.recover();assert.equal(session.transcript.length,1);
  assert.deepEqual(await fs.readdir(dir),[]);
});
test('shutdown cancellation during recovery startup preserves pending audio and prevents late inference',async t=>{
 const {root,session,dir}=await pending(t);let release,started,inferences=0;
 const starting=new Promise(resolve=>{started=resolve;});
 const recording=new Recording(root,{start:()=>{started();return new Promise(resolve=>{release=resolve;});},transcribe:async()=>{inferences++;return [];}},()=>{});recording.session=session;
 const recovering=recording.recover();await starting;recording.failure=new Error('Shutdown deadline reached.');release();
 await assert.rejects(recovering,/deadline/);assert.equal(inferences,0);assert.equal((await fs.readdir(dir)).length,2);
});
test('recovering audio refreshes transcript revisions and retains known capture gaps',async t=>{
 const {root,session}=await pending(t);session.interruption='The final capture buffer was lost.';
 const recording=new Recording(root,{start:async()=>{},transcribe:async()=>[{start:0,end:1,text:'Recovered.'}]},()=>{});recording.session=session;
 await recording.recover();assert.equal(session.status,'incomplete');assert.match(session.incompleteReason,/buffer/);assert.equal(session.transcriptRevision,1);
});
