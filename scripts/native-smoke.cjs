const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const {SpeechEngine} = require('../lib/speech.cjs');
const {CodexJobs} = require('../lib/codex.cjs');

async function speech(sample) {
  assert.ok(sample, 'Supply a short English 16-kHz WAV file.');
  const engine = new SpeechEngine(path.resolve(__dirname, '..', 'resources'));
  try {
    await engine.start();
    const started = Date.now();
    const segments = await engine.transcribe(path.resolve(sample));
    assert.ok(segments.some(segment => segment.text.trim().length > 3), 'No English speech recognized.');
    assert.ok(segments.every(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end)));
    console.log(JSON.stringify({elapsedMs:Date.now() - started,text:segments.map(segment => segment.text).join(' '),tokenTiming:segments.some(segment => segment.words?.some(word => Number.isFinite(word.start)))}));
  } catch(error) { console.error(engine.log); throw error; }
  finally { engine.close(); }
}
async function codex() {
  const jobs=new CodexJobs(path.join(os.tmpdir(),'live-meeting-notes-smoke-jobs'));
  const session={transcript:[{start:0,end:8,text:'Alex will confirm the release date. We need to know the current Node.js LTS release.'}]};
  const notes=await jobs.notes(session);
  assert.ok(notes.summary.length > 5);
  assert.ok(notes.actions.some(action => action.owner === 'Alex' && action.due === null));
  const answer=await jobs.research(session,{id:'q1',question:'What is the current Node.js LTS release?',evidence:[0]});
  assert.equal(answer.status,'answered');assert.ok(answer.sources.length > 0);
  console.log(JSON.stringify({notes,answer}));
}
if (require.main === module) {
  (process.argv[2] === 'codex' ? codex() : speech(process.argv[2]))
    .catch(error => {console.error(error.message); process.exitCode=1;});
}
module.exports = {speech,codex};
