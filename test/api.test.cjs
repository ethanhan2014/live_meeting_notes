const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {AIJobs}=require('../lib/ai.cjs');
const notes={summary:'Summary\nDiscussed the release.\nKey findings\nNone identified.\nKey points\nRelease timing.',actions:[{task:'Send the report',owner:'Alex',due:null,evidence:[0]}],questions:[]};
const session={transcript:[{start:0,end:5,text:'Alex will send the report.'}]};
async function server(t,handler){const value=http.createServer(handler);await new Promise(resolve=>value.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>value.close(resolve)));return 'http://127.0.0.1:'+value.address().port;}
async function request(req){let data='';for await(const part of req)data+=part;return JSON.parse(data);}
test('local proxy receives HTTP JSON with the saved model and key, and produces grounded notes',async t=>{
 const url=await server(t,async(req,res)=>{const body=await request(req);assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer synthetic-key');assert.equal(body.model,'local-model');assert.equal(body.stream,false);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(notes)}}]}));});
 const jobs=new AIJobs({apiProvider:'proxy',apiBaseUrl:url+'/v1',apiKey:'synthetic-key',summaryModel:'local-model',answerModel:''});
 assert.equal((await jobs.notes(session)).actions[0].owner,'Alex');
});
test('Gemini calls generateContent with an API-key header and JSON output',async t=>{
 const url=await server(t,async(req,res)=>{const body=await request(req);assert.equal(req.url,'/v1beta/models/gemini-2.5-flash:generateContent');assert.equal(req.headers['x-goog-api-key'],'synthetic-key');assert.equal(body.generationConfig.responseMimeType,'application/json');res.end(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(notes)}]}}]}));});
 const jobs=new AIJobs({apiProvider:'gemini',apiBaseUrl:url+'/v1beta',apiKey:'synthetic-key',summaryModel:'gemini-2.5-flash',answerModel:''});
 assert.equal((await jobs.notes(session)).summary,notes.summary);
});
test('provider failures do not echo keys or meeting text',async t=>{
 const url=await server(t,(_req,res)=>{res.statusCode=401;res.end('synthetic-key secret meeting text');});
 const jobs=new AIJobs({apiProvider:'proxy',apiBaseUrl:url,apiKey:'synthetic-key',summaryModel:'model',answerModel:''});
 await assert.rejects(jobs.notes(session),error=>/401/.test(error.message)&&!error.message.includes('synthetic-key')&&!error.message.includes('secret meeting'));
});
test('proxy answers include API-generated text and stay unverified without search sources',async t=>{
 const url=await server(t,async(req,res)=>{await request(req);res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({status:'answered',answer:'Alex will send the report.',sources:[],gaps:[]})}}]}));});
 const jobs=new AIJobs({apiProvider:'proxy',apiBaseUrl:url,apiKey:'',summaryModel:'model',answerModel:''});
 const answer=await jobs.research(session,{id:'q1',question:'Who sends the report?',evidence:[0]});
 assert.equal(answer.status,'unresolved');assert.equal(answer.answer,'Alex will send the report.');assert.deepEqual(answer.sources,[]);
});
test('Gemini research enables search and accepts only grounding URLs',async t=>{
 const answer={status:'answered',answer:'Use the supported release.',sources:[{title:'Official docs',url:'https://example.org/docs'}],gaps:[]};
 const url=await server(t,async(req,res)=>{const body=await request(req);assert.deepEqual(body.tools,[{googleSearch:{}}]);assert.equal(body.generationConfig,undefined);res.end(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(answer)}]},groundingMetadata:{groundingChunks:[{web:{uri:'https://example.org/docs',title:'Official docs'}}]}}]}));});
 const jobs=new AIJobs({apiProvider:'gemini',apiBaseUrl:url,apiKey:'synthetic-key',summaryModel:'gemini-2.5-flash',answerModel:''});
 assert.equal((await jobs.research(session,{id:'q1',question:'Which release?',evidence:[0]})).status,'answered');
});
test('cancellation aborts an in-flight HTTP request',async t=>{
 let arrived;const waiting=new Promise(resolve=>{arrived=resolve;});
 const url=await server(t,(_req,res)=>{arrived();res.on('close',()=>{});});
 const jobs=new AIJobs({apiProvider:'proxy',apiBaseUrl:url,apiKey:'',summaryModel:'model',answerModel:''});
 const pending=jobs.notes(session);await waiting;const rejected=assert.rejects(pending,/cancelled/);jobs.cancel();await rejected;
});
