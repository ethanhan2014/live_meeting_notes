const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {newSession, saveSession, commitSession, loadLatestSession, loadSession, listSessions, atomicWrite, exportSession} = require('../lib/session.cjs');
const meeting = require('./fixtures/meeting.json');

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-session-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}

test('new sessions have unique IDs, ISO start times, and empty recording state', () => {
  const first = newSession();
  const second = newSession();
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(new Date(first.startedAt).toISOString(), first.startedAt);
  assert.deepEqual({...first, id: null, startedAt: null}, {
    id: null, startedAt: null, endedAt: null, status: 'recording', transcript: [], notes: null, answers: []
  });
});

test('both exports retain complete meeting content and source URLs in the same section order', () => {
  const txt = exportSession(meeting, 'txt');
  const md = exportSession(meeting, 'md');
  for (const text of [txt, md]) {
    for (const value of [meeting.id, meeting.startedAt, meeting.endedAt, 'complete',
      ...meeting.transcript.map(segment => segment.text), meeting.notes.summary,
      'Confirm the release date', 'Alex', 'Due: Not specified',
      ...meeting.notes.questions.map(question => question.question),
      ...meeting.answers.map(answer => answer.answer), 'Release calendar',
      'https://example.com/release', 'unresolved', 'No published approval policy was found.']) {
      assert.ok(text.includes(value), `Missing ${value}`);
    }
    assert.ok(!text.includes('undefined'));
    const headings = ['Metadata', 'Transcript', 'Summary', 'Actions', 'Open questions', 'Researched answers and sources'];
    const positions = headings.map(heading => text.indexOf(heading));
    assert.ok(positions.every((position, i) => position >= 0 && (!i || position > positions[i - 1])));
    assert.ok(text.includes('00:00:03.250'));
    assert.ok(text.includes('Evidence: 00:00:06.500'));
    assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text);
  }
  assert.ok(!/(?<!\r)\n/.test(txt), 'TXT must use CRLF');
  assert.match(md, /^# Meeting notes\n/);
  assert.equal(txt.replaceAll('\r\n', '\n'), md.replace(/^#{1,2} /gm, ''));
});

test('missing notes and research, unanswered questions, and incomplete status remain explicit', () => {
  const session = {...meeting, status: 'incomplete', endedAt: null, notes: null, answers: [],incompleteReason:'Audio could not be recovered.'};
  for (const format of ['txt', 'md']) {
    const text = exportSession(session, format);
    assert.ok(text.includes('Status: incomplete'));
    assert.ok(text.includes('Incomplete reason: Audio could not be recovered.'));
    assert.ok(text.includes('Ended: Not ended'));
    assert.equal((text.match(/Not generated/g) || []).length, 3);
    assert.ok(text.includes('Not researched'));
    assert.ok(text.includes(meeting.transcript[0].text));
    const unanswered = exportSession({...meeting, answers: []}, format);
    assert.ok(unanswered.includes('Unanswered'));
    assert.ok(unanswered.includes(meeting.notes.questions[0].question));
  }
  assert.throws(() => exportSession(meeting, 'pdf'), /format/i);
});

test('sessions round-trip and startup loads the newest meeting by start time', async t => {
  const root = path.join(await temporaryRoot(t), 'sessions');
  assert.equal(await loadLatestSession(root), null);
  await saveSession(root, meeting);
  assert.deepEqual(await loadLatestSession(root), meeting);
  const newer = {...meeting, id: newSession().id, startedAt: '2026-11-04T15:00:00.000Z', endedAt: '2026-11-04T15:05:00.000Z'};
  await saveSession(root, newer);
  await fs.utimes(path.join(root, `${meeting.id}.json`), new Date('2026-01-01'), new Date('2026-01-01'));
  assert.deepEqual(await loadLatestSession(root), newer);
  const updated = {...meeting, status: 'incomplete'};
  await saveSession(root, updated);
  await fs.utimes(path.join(root, `${meeting.id}.json`), new Date('2027-01-01'), new Date('2027-01-01'));
  assert.deepEqual(await loadLatestSession(root), newer);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, `${meeting.id}.json`), 'utf8')), updated);
  assert.deepEqual((await fs.readdir(root)).sort(), [`${meeting.id}.json`, `${newer.id}.json`].sort());
});

test('failed atomic replacement preserves saved and in-memory transcripts and removes the temporary file', async t => {
  const root = await temporaryRoot(t);
  await saveSession(root, meeting);
  const saved = await fs.readFile(path.join(root, `${meeting.id}.json`), 'utf8');
  const incoming = {...meeting, transcript: [...meeting.transcript, {start: 9, end: 10, text: 'Keep this new text.'}]};
  const before = structuredClone(incoming);
  const originalRename = fs.rename;
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === path.join(root, `${meeting.id}.json`)) {
      throw Object.assign(new Error('Injected disk failure'), {code: 'EIO'});
    }
    return originalRename(source, destination);
  });
  await assert.rejects(saveSession(root, incoming), {code: 'EIO'});
  assert.equal(await fs.readFile(path.join(root, `${meeting.id}.json`), 'utf8'), saved);
  assert.deepEqual(incoming, before);
  assert.deepEqual(await fs.readdir(root), [`${meeting.id}.json`]);
});

test('persistence rejects unsafe IDs before writing and ignores mismatched and corrupt files', async t => {
  const root = await temporaryRoot(t);
  for (const id of ['../escaped', '/tmp/escaped', '..\\escaped', '', null]) {
    await assert.rejects(saveSession(root, {...meeting, id}), /session ID/i);
  }
  assert.deepEqual(await fs.readdir(root), []);
  await saveSession(root, meeting);
  const otherId = newSession().id;
  await fs.writeFile(path.join(root, `${otherId}.json`), JSON.stringify(meeting));
  await fs.writeFile(path.join(root, `${newSession().id}.json`), '{corrupt');
  await fs.writeFile(path.join(root, 'not-a-session.json'), JSON.stringify(meeting));
  assert.deepEqual(await loadLatestSession(root), meeting);
});

test('startup ignores symlinked session files', async t => {
  const root = await temporaryRoot(t);
  const outside = path.join(await temporaryRoot(t), 'outside.json');
  await fs.writeFile(outside, JSON.stringify(meeting));
  try {
    await fs.symlink(outside, path.join(root, `${meeting.id}.json`), 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows user cannot create symlinks');
      return;
    }
    throw error;
  }
  assert.equal(await loadLatestSession(root), null);
});

test('invalid persisted transcript data and filesystem errors are not accepted silently', async t => {
  const root = await temporaryRoot(t);
  const invalid = {...meeting, transcript: [{start: -1, end: 0, text: 'Invalid time'}]};
  await assert.rejects(saveSession(root, invalid), /transcript/i);
  await fs.writeFile(path.join(root, `${meeting.id}.json`), JSON.stringify(invalid));
  assert.equal(await loadLatestSession(root), null);
  const file = path.join(root, 'file');
  await fs.writeFile(file, 'not a directory');
  await assert.rejects(loadLatestSession(file), {code: 'ENOTDIR'});
  await assert.rejects(saveSession(file, meeting), {code: 'EEXIST'});
});

test('malformed persisted notes, answers, and ISO times are rejected before replacing valid data', async t => {
  const root = await temporaryRoot(t);
  await saveSession(root, meeting);
  for (const invalid of [
    {...meeting, startedAt: '2026'},
    {...meeting, endedAt: '2026-11-02T15:00:00.000Z'},
    {...meeting, notes: {...meeting.notes, actions: [{task: 'Missing owner, due, and evidence'}]}},
    {...meeting, notes: {...meeting.notes, questions: [{id: 'q1', question: 'Question', evidence: [-1]}]}},
    {...meeting, answers: [{questionId: 'q1', status: 'answered', answer: 'Missing source and gap arrays'}]},
    {...meeting, answers: [{...meeting.answers[0], sources: [{title: 'Missing URL'}]}]},
    {...meeting, answers: [{...meeting.answers[0], gaps: [null]}]}
  ]) {
    await assert.rejects(saveSession(root, invalid), /session/i);
    assert.deepEqual(await loadLatestSession(root), meeting);
  }
});
test('notes and answers are published only after their atomic save succeeds', async t => {
  const root=await temporaryRoot(t);const session=structuredClone(meeting);
  await saveSession(root,session);const original=structuredClone(session);
  t.mock.method(fs,'rename',async () => {throw new Error('Injected disk failure');});
  for (const changes of [
    {notes:{...session.notes,summary:'New notes'}},
    {answers:[{...session.answers[0],answer:'New recommended answer'}]}
  ]) {
    await assert.rejects(commitSession(root,session,changes),/disk failure/);
    assert.deepEqual(session,original);assert.deepEqual(await loadLatestSession(root),original);
  }
});

test('shared atomic writer preserves exports on failed replacement and cleans temporary data', async t => {
  const root=await temporaryRoot(t);const destination=path.join(root,'meeting.md');
  await fs.writeFile(destination,'original export');
  t.mock.method(fs,'rename',async () => {throw new Error('export disk failure');});
  await assert.rejects(atomicWrite(destination,'replacement export'),/export disk failure/);
  assert.equal(await fs.readFile(destination,'utf8'),'original export');
  assert.deepEqual(await fs.readdir(root),['meeting.md']);
});

test('history sorts session metadata by meeting time and load by ID validates paths and content', async t => {
  const root=await temporaryRoot(t);
  const older={...meeting,id:newSession().id,startedAt:'2026-11-01T15:00:00.000Z',endedAt:null,notes:null};
  await saveSession(root,meeting);await saveSession(root,older);
  assert.deepEqual(await loadSession(root,older.id),older);
  assert.deepEqual(await listSessions(root),[meeting,older].map(session => ({id:session.id,
    startedAt:session.startedAt,endedAt:session.endedAt,status:session.status,
    summary:session.notes?.summary ?? '',segments:session.transcript.length})));
  for (const id of ['../escape','..\\escape','',null]) await assert.rejects(loadSession(root,id),/session ID/i);
  const outside=path.join(await temporaryRoot(t),'outside.json');await fs.writeFile(outside,JSON.stringify(meeting));
  const symlinkId=newSession().id;
  try {await fs.symlink(outside,path.join(root,symlinkId+'.json'),'file');}
  catch(error) {if(process.platform==='win32' && error.code==='EPERM') return;throw error;}
  await assert.rejects(loadSession(root,symlinkId),/regular file|symlink/i);
  assert.equal((await listSessions(root)).length,2);
  const corruptId=newSession().id;await fs.writeFile(path.join(root,corruptId+'.json'),'{corrupt');
  await assert.rejects(loadSession(root,corruptId),SyntaxError);
  assert.equal((await listSessions(root)).length,2);
});

test('legacy sessions still load while malformed chunk IDs and metrics cannot replace saved data', async t => {
  const root=await temporaryRoot(t);await saveSession(root,meeting);
  for (const extra of [{processedChunks:['../wav']},{processedChunks:[newSession().id,newSession().id,0]},
    {metrics:{inferenceMs:-1}},{incompleteReason:42},
    {processedChunks:[meeting.id,meeting.id]},
    {metrics:{inferenceMs:0,p95InferenceMs:0,p95LatencyMs:0,pendingSeconds:0,pendingBytes:.5,rtf:0,processedChunks:0}}]) {
    await assert.rejects(saveSession(root,{...meeting,...extra}),/session/i);
    assert.deepEqual(await loadSession(root,meeting.id),meeting);
  }
});

test('atomic partial-write failure preserves previous exports and removes the incomplete temporary file', async t => {
  const root=await temporaryRoot(t);const destination=path.join(root,'export.txt');await fs.writeFile(destination,'existing export');
  const originalOpen=fs.open;
  t.mock.method(fs,'open',async (...args)=>{
    const file=await originalOpen(...args);
    t.mock.method(file,'writeFile',async ()=>{await file.write('partial');throw new Error('write failed');});
    return file;
  });
  await assert.rejects(atomicWrite(destination,'new export'),/write failed/);
  assert.equal(await fs.readFile(destination,'utf8'),'existing export');assert.deepEqual(await fs.readdir(root),['export.txt']);
});

test('load rejects a session path changed to a symlink after opening it', async t => {
  if(process.platform==='win32') {t.skip('Symlink race test requires Unix file replacement semantics');return;}
  const root=await temporaryRoot(t);await saveSession(root,meeting);
  const destination=path.join(root,meeting.id+'.json');const outside=path.join(await temporaryRoot(t),'outside.json');
  await fs.writeFile(outside,JSON.stringify(meeting));const originalOpen=fs.open;
  t.mock.method(fs,'open',async (...args)=>{
    const file=await originalOpen(...args);
    if(args[0]===destination) {await fs.rm(destination);await fs.symlink(outside,destination);}
    return file;
  });
  await assert.rejects(loadSession(root,meeting.id),/regular file|symlink/i);
});
test('a concurrent session save waits for an in-flight commit and includes its published transcript',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-serialize-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const session=newSession();await saveSession(root,session);
 const rename=fs.rename;let release,entered;const blocked=new Promise(resolve=>{entered=resolve;});let calls=0;
 t.mock.method(fs,'rename',async(...args)=>{if(++calls===1){entered();await new Promise(resolve=>{release=resolve;});}return rename(...args);});
 const committing=commitSession(root,session,{transcript:[{start:0,end:1,text:'Final words.'}]});await blocked;
 session.status='incomplete';session.incompleteReason='Shutdown deadline reached.';const saving=saveSession(root,session);
 release();await Promise.all([committing,saving]);const disk=await loadSession(root,session.id);
 assert.equal(disk.transcript[0]?.text,'Final words.');assert.equal(disk.status,'incomplete');assert.match(disk.incompleteReason,/deadline/);
});
test('summary subsections remain complete in both TXT and Markdown exports',()=>{
 const summary='Summary\nRelease planning.\n\nKey findings\n- LTS selected.\n\nKey points\n- Release support.';
 const session={...meeting,notes:{...meeting.notes,summary}};
 for(const format of ['txt','md'])assert.ok(exportSession(session,format).replaceAll('\r\n','\n').includes(summary));
});
