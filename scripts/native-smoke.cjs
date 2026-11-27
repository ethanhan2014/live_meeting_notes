const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const {SpeechEngine} = require('../lib/speech.cjs');

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
if (require.main === module) {
  speech(process.argv[2])
    .catch(error => {console.error(error.message); process.exitCode=1;});
}
module.exports = {speech};
