const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {defaults,validateSettings,loadSettings,saveSettings}=require('../lib/settings.cjs');

test('settings validate audio ranges and executable paths before saving', () => {
  assert.equal(validateSettings({...defaults,codexExecutable:'C:\\Tools\\codex.exe'},'win32').threads,6);
  for (const changes of [{threads:0},{threads:1.5},{micGain:4},{noiseThreshold:NaN},{vad:'true'},{codexExecutable:'codex.exe'},{codexExecutable:'C:\\Tools\\codex.cmd'}]) {
    assert.throws(()=>validateSettings({...defaults,...changes}),/settings|executable/i);
  }
});
test('macOS settings accept native CLI paths and reject foreign or relative paths',()=>{
  const value={...defaults,codexExecutable:'/opt/homebrew/bin/codex',transcriptFolder:'/Users/example/Notes'};
  assert.equal(validateSettings(value,'darwin').codexExecutable,value.codexExecutable);
  for(const changes of [{codexExecutable:'codex'},{codexExecutable:'C:\\Tools\\codex.exe'},{transcriptFolder:'C:\\Notes'},{transcriptFolder:'../notes'}])assert.throws(()=>validateSettings({...value,...changes},'darwin'));
});
test('old audio settings gain AI defaults and per-agent efforts are validated',()=>{
  const legacy=validateSettings({threads:4});assert.equal(legacy.summaryModel,'gpt-6-luna');assert.equal(legacy.answerAgent,'codex');assert.equal(legacy.transcriptFolder,'');
  for(const changes of [{summaryAgent:'unknown'},{answerModel:'model\n--flag'},{summaryAgent:'gemini',summaryEffort:'max'},{transcriptFolder:'relative/folder'}])assert.throws(()=>validateSettings({...defaults,...changes}));
  assert.equal(validateSettings({...defaults,summaryAgent:'claude',summaryModel:'sonnet',summaryEffort:'low',answerAgent:'gemini',answerEffort:'high'}).answerEffort,'high');
});
test('settings round-trip and invalid saves leave prior settings intact', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-settings-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'settings.json');assert.deepEqual(await loadSettings(file),defaults);
  const next={...defaults,micGain:1.5,threads:4};await saveSettings(file,next);
  await assert.rejects(saveSettings(file,{...next,systemGain:-1}));assert.deepEqual(await loadSettings(file),next);
});
