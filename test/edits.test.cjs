const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {editTranscript,editNotes,setActionDone}=require('../lib/edits.cjs');
const {saveSession,loadLatestSession}=require('../lib/session.cjs');
const fixture=require('./fixtures/meeting.json');
async function setup(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-edit-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const session=structuredClone(fixture);await saveSession(root,session);return {root,session};}
test('transcript corrections invalidate derived notes only after successful persistence',async t=>{
 const {root,session}=await setup(t);const before=structuredClone(session);
 t.mock.method(fs,'rename',async()=>{throw new Error('disk failure');});
 await assert.rejects(editTranscript(root,session,0,'Corrected name'),/disk failure/);assert.deepEqual(session,before);
 t.mock.restoreAll();await editTranscript(root,session,0,'Corrected name');
 assert.equal(session.notes,null);assert.deepEqual(session.answers,[]);assert.equal(session.transcript[0].text,'Corrected name');
 assert.equal((await loadLatestSession(root)).transcriptRevision,1);
});
test('notes corrections preserve evidence and answers for unchanged questions',async t=>{
 const {root,session}=await setup(t);
 const edits={summary:'Reviewed summary',actions:session.notes.actions.map(a=>({task:a.task,owner:'Reviewer',due:a.due})),questions:session.notes.questions.map(q=>({id:q.id,question:q.question}))};
 await editNotes(root,session,edits);assert.equal(session.notes.actions[0].owner,'Reviewer');assert.deepEqual(session.answers,fixture.answers);
 edits.questions[0].question='Revised question';await editNotes(root,session,edits);
 assert.ok(!session.answers.some(a=>a.questionId===edits.questions[0].id));assert.deepEqual(session.notes.actions[0].evidence,fixture.notes.actions[0].evidence);
 await assert.rejects(editTranscript(root,session,-1,'invalid'),/segment/);
});
test('action checkboxes persist, survive note editing, and preserve data on failed saves',async t=>{
 const {root,session}=await setup(t);const before=structuredClone(session);
 t.mock.method(fs,'rename',async()=>{throw new Error('disk failure');});
 await assert.rejects(setActionDone(root,session,0,true),/disk failure/);assert.deepEqual(session,before);t.mock.restoreAll();
 await setActionDone(root,session,0,true);assert.equal((await loadLatestSession(root)).notes.actions[0].done,true);assert.deepEqual(session.answers,fixture.answers);
 await editNotes(root,session,{summary:session.notes.summary,actions:session.notes.actions,questions:session.notes.questions});assert.equal(session.notes.actions[0].done,true);
 await setActionDone(root,session,0,false);assert.equal(session.notes.actions[0].done,false);
 await assert.rejects(setActionDone(root,session,0,'true'),/Invalid/);await assert.rejects(setActionDone(root,session,-1,true),/Invalid/);
});
