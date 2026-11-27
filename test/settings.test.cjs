const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {defaults,validateSettings,loadSettings,saveSettings}=require('../lib/settings.cjs');

test('settings validate audio, API URLs and models before saving',()=>{
 assert.equal(validateSettings({...defaults,threads:4}).threads,4);
 assert.throws(()=>validateSettings({...defaults,apiBaseUrl:'http://example.org/v1'}),/HTTPS/);
 assert.equal(validateSettings({...defaults,apiBaseUrl:'http://localhost:4000/v1'}).apiProvider,'proxy');
 for(const change of [{threads:0},{micGain:4},{noiseThreshold:NaN},{apiProvider:'codex'},{apiBaseUrl:'file:///tmp/key'},{apiBaseUrl:'https://key:secret@example.org/v1'},{apiKey:'key\nheader'},{summaryModel:'model\nflag'}])assert.throws(()=>validateSettings({...defaults,...change}));
});
test('old inference-device preferences migrate without losing the other settings',()=>{
 for(const platform of ['win32','darwin','linux']){
  const settings=validateSettings({...defaults,speechDevice:'cuda',threads:4},platform);
  assert.equal(settings.threads,4);assert.equal(Object.hasOwn(settings,'speechDevice'),false);
 }
});
test('old CLI settings migrate while retaining audio and transcript folders',()=>{
 const next=validateSettings({threads:4,codexExecutable:'old-cli',summaryAgent:'codex',summaryEffort:'medium',vad:false});
 assert.equal(next.threads,4);assert.equal(next.apiProvider,'proxy');assert.equal(Object.hasOwn(next,'codexExecutable'),false);
});
test('settings round-trip and invalid saves leave prior settings intact', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-settings-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'settings.json');assert.deepEqual(await loadSettings(file),defaults);
  const next={...defaults,micGain:1.5,threads:4};await saveSettings(file,next);
  await assert.rejects(saveSettings(file,{...next,systemGain:-1}));assert.deepEqual(await loadSettings(file),next);
});
