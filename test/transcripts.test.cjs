const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {parseTranscript,saveTranscript,listTranscripts,readTranscript}=require('../lib/transcripts.cjs');
const {saveSession,exportSession}=require('../lib/session.cjs');
const fixture=require('./fixtures/meeting.json');

test('Markdown saves contain transcript, summary, completed tasks, questions, and answers',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-md-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const session=structuredClone(fixture);session.notes.actions[0].done=true;
 const name=await saveTranscript(folder,session,'md');assert.match(name,/\.md$/);
 const content=await fs.readFile(path.join(folder,name),'utf8');
 for(const heading of ['## Transcript','## Summary','## Actions','## Open questions','## Researched answers and sources'])assert.ok(content.includes(heading));
 assert.match(content,/\[x\] Confirm the release date/);assert.equal(content,exportSession(session,'md'));
});

test('TXT imports retain timed passages and accept untimed English text without invented timing',()=>{
  const timed=parseTranscript(exportSession(fixture,'txt'));assert.deepEqual(timed.transcript,fixture.transcript);assert.notEqual(timed.id,fixture.id);assert.equal(timed.notes,null);
  const plain=parseTranscript('\uFEFFFirst point.\r\nSecond point.');assert.deepEqual(plain.transcript.map(row=>row.text),['First point.','Second point.']);assert.ok(plain.transcript.every(row=>row.start===0&&row.end===0));
  for(const text of ['','\0','[00:99:00 - 01:00:00] Invalid','[00:00:10 - 00:00:00] Invalid'])assert.throws(()=>parseTranscript(text));
});
test('local TXT files round-trip saved notes and completion, while edited external text creates a new session',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-txt-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const root=path.join(directory,'sessions'),folder=path.join(directory,'scripts'),session=structuredClone(fixture);session.notes.actions[0].done=true;
  await saveSession(root,session);const name=await saveTranscript(folder,session);await fs.writeFile(path.join(folder,'helper.cjs'),'helper');await fs.mkdir(path.join(folder,'directory.txt'));
  assert.deepEqual(await listTranscripts(folder),[name]);assert.deepEqual(await readTranscript(path.join(folder,name),root),session);
  const original=await fs.readFile(path.join(folder,name),'utf8');assert.match(original,/\[x\] Confirm the release date/);
  await fs.writeFile(path.join(folder,name),original.replace('Alex will confirm','Alex has confirmed'));
  const imported=await readTranscript(path.join(folder,name),root);assert.notEqual(imported.id,session.id);assert.match(imported.transcript[0].text,/has confirmed/);
  await saveTranscript(folder,session);const backup=(await listTranscripts(folder)).find(name=>name.includes(' edited-'));assert.ok(backup);assert.match(await fs.readFile(path.join(folder,backup),'utf8'),/has confirmed/);
});
