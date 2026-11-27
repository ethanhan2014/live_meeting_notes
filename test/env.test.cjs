const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {loadApiEnv,saveApiEnv,loadApiConfig}=require('../lib/env.cjs');
test('API details round-trip in a private dotenv file and preserve unrelated variables',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-env-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'.env');await fs.writeFile(file,'CUSTOM_VALUE=keep-me\n');
 const config={apiProvider:'proxy',apiBaseUrl:'http://127.0.0.1:4000/v1',apiKey:'synthetic_"key#',summaryModel:'local-model',answerModel:''};
 await saveApiEnv(file,config);assert.deepEqual(await loadApiEnv(file),config);assert.match(await fs.readFile(file,'utf8'),/CUSTOM_VALUE=keep-me/);
 if(process.platform!=='win32')assert.equal((await fs.stat(file)).mode&0o777,0o600);
});
test('packaged API defaults seed .env once and preserve later user changes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-default-env-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'profile','.env'),defaultsFile=path.join(root,'default.env');
 const defaults={apiProvider:'proxy',apiBaseUrl:'http://localhost:6655/openai/v1',apiKey:'synthetic-key',summaryModel:'gpt-6-luna',answerModel:'gpt-6-luna'};
 await saveApiEnv(defaultsFile,defaults);assert.deepEqual(await loadApiConfig(file,defaultsFile),defaults);
 await saveApiEnv(file,{...defaults,summaryModel:'chosen-model'});assert.equal((await loadApiConfig(file,defaultsFile)).summaryModel,'chosen-model');
});
