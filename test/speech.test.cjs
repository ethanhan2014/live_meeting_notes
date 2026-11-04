const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const cp=require('node:child_process');
const {EventEmitter}=require('node:events');
function load(t,spawn){t.mock.method(fs,'access',async()=>{});t.mock.method(cp,'spawn',spawn);delete require.cache[require.resolve('../lib/speech.cjs')];t.after(()=>delete require.cache[require.resolve('../lib/speech.cjs')]);return require('../lib/speech.cjs').SpeechEngine;}
function child(){const value=new EventEmitter();value.stderr=new EventEmitter();value.stdout=new EventEmitter();value.kill=()=>{};return value;}
test('speech launch failure clears the failed child so a retry really starts a process',async t=>{
 let launches=0;
 const Engine=load(t,()=>{const value=child();launches++;queueMicrotask(()=>value.emit('error',new Error('denied')));return value;});
 const engine=new Engine('unused',{vad:false});
 await assert.rejects(engine.start(),/denied/);await assert.rejects(engine.start(),/denied/);
 assert.equal(launches,2);assert.equal(engine.ready,false);engine.close();
});
test('concurrent starts wait for readiness and close aborts a pending inference',async t=>{
 let launches=0,allowReady;
 const ready=new Promise(resolve=>{allowReady=resolve;});
 const Engine=load(t,()=>{launches++;return child();});
 t.mock.method(globalThis,'fetch',async(url,options)=>{
   if(url.endsWith('/')){await ready;return {ok:true};}
   return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 });
 t.mock.method(fs,'readFile',async()=>Buffer.alloc(100));
 const engine=new Engine('unused',{vad:false});let secondReady=false;
 const first=engine.start(),second=engine.start().then(()=>{secondReady=true;});
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(secondReady,false);allowReady();await Promise.all([first,second]);assert.equal(launches,1);assert.equal(engine.ready,true);
 const transcribing=engine.transcribe('sample.wav');await new Promise(resolve=>setTimeout(resolve,5));engine.close();
 await assert.rejects(transcribing);assert.equal(engine.ready,false);
});
test('close cancels startup and a fresh start cannot be replaced by stale readiness',async t=>{
 let launches=0,release,started;
 const wait=new Promise(resolve=>{release=resolve;}),fetchStarted=new Promise(resolve=>{started=resolve;});
 const Engine=load(t,()=>{launches++;return child();});
 t.mock.method(globalThis,'fetch',async()=>{if(launches===1){started();await wait;}return {ok:true};});
 const engine=new Engine('unused',{vad:false});const old=engine.start();
 await fetchStarted;engine.close();const rejection=assert.rejects(old,/closed/);
 await engine.start();release();await rejection;assert.equal(launches,2);assert.equal(engine.ready,true);engine.close();
});
test('unexpected exit reports unhealthy state and permits a new process',async t=>{
 const children=[],states=[];let args;
 const Engine=load(t,(_file,options)=>{args=options;const value=child();children.push(value);return value;});
 t.mock.method(globalThis,'fetch',async()=>({ok:true}));
 const engine=new Engine('unused',{threads:4,vad:true,onState:state=>states.push(state)});
 await engine.start();assert.ok(args.includes('--vad'));assert.equal(args[args.indexOf('-t')+1],'4');
 children[0].emit('exit',7);assert.equal(engine.ready,false);assert.match(states.at(-1).failure.message,/7/);
 await engine.start();assert.equal(children.length,2);assert.equal(engine.ready,true);engine.close();
});
test('speech rejects invalid user settings',t=>{
 const Engine=load(t,()=>child());
 for(const options of [{threads:0},{threads:17},{threads:2.5},{vad:'yes'}])assert.throws(()=>new Engine('unused',options),/settings/);
});
test('VAD omits unremapped token times while preserving original timeline segment times',async t=>{
 const Engine=load(t,()=>child());
 t.mock.method(fs,'readFile',async()=>Buffer.alloc(100));
 t.mock.method(globalThis,'fetch',async url=>url.endsWith('/')?{ok:true}:{ok:true,json:async()=>({segments:[{start:2.31,end:5.85,text:'hello',words:[{start:.02,end:.22,word:'hello'}]}]})});
 const engine=new Engine('unused',{vad:true});await engine.start();
 const [segment]=await engine.transcribe('sample.wav');
 assert.equal(segment.start,2.31);assert.equal(segment.end,5.85);assert.equal(segment.words,undefined);engine.close();
});
