const {test} = require('node:test');
const assert = require('node:assert/strict');
const {encodeWav, AudioChunker, mergeSegments} = require('../lib/audio.cjs');

test('PCM WAV carries the final sample and clips to signed 16 bit', () => {
  const wav = encodeWav(new Float32Array([0, 2, -2]));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), 6);
  assert.equal(wav.readInt16LE(48), -32768);
});
test('silence does not create audio jobs', () => {
  const chunker = new AudioChunker();
  assert.deepEqual(chunker.push(new Float32Array(16000 * 8)), []);
  assert.deepEqual(chunker.flush(), []);
});
test('Stop flushes a final short utterance', () => {
  const chunker = new AudioChunker();
  assert.equal(chunker.push(new Float32Array(16000).fill(.1)).length, 0);
  const chunks = chunker.flush();
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].end, 1);
  assert.equal(chunks[0].pcm.length, 16000);
});
test('continuous speech creates bounded jobs with overlap', () => {
  const chunker = new AudioChunker();
  const chunks = chunker.push(new Float32Array(16000 * 12).fill(.1));
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[0].end, 6);
  assert.equal(chunks[1].start, 5.5);
  assert.ok(chunks.every(chunk => chunk.pcm.length <= 16000 * 6));
});
test('token timing removes overlap while retaining intentional repeated words', () => {
  const previous = [{start:0,end:6,text:'Please confirm the date.'}];
  const result = mergeSegments(previous, [{start:5.5,end:8,text:'the date. Please confirm the date.',words:[
    {start:5.5,end:5.8,word:' the'}, {start:5.8,end:6,word:' date.'},
    {start:6.2,end:6.5,word:' Please'}, {start:6.5,end:7,word:' confirm'},
    {start:7,end:7.3,word:' the'}, {start:7.3,end:8,word:' date.'}
  ]}], 6);
  assert.equal(result.length, 2);
  assert.equal(result[1].text, 'Please confirm the date.');
  assert.equal(result[1].start, 6.2);
});
test('decoder letter loops and exact duplicate rows are removed without losing repeated speech or numbers',()=>{
  const junk=[{start:1250.4,end:1251.89,text:'a'+'w'.repeat(56)},...Array.from({length:6},()=>({start:1251.89,end:1251.89,text:'w'.repeat(60)})),{start:1251.89,end:1280.4,text:'w'.repeat(16)}];
  const speech=[{start:1251.9,end:1254.3,text:'Fiscal year.'},{start:1254.3,end:1255,text:'No, no, no.'},{start:1255,end:1256,text:'No, no, no.'},{start:1256,end:1256,text:"It's an 8%"},{start:1256.1,end:1256.5,text:'ID '+ '0'.repeat(20)},{start:1257,end:1257.5,text:'Visit www.example.com. Shhhh.'}];
  const original=structuredClone([...junk,...speech,speech[0]]);
  assert.deepEqual(mergeSegments([],original,1250.4,1258),speech);
  assert.deepEqual(original,[...junk,...speech,speech[0]]);
  assert.deepEqual(mergeSegments([speech[0]],[speech[0],speech[1]],1250.4,1258),speech.slice(0,2));
});
test('segment and word timestamps stay within the audio chunk and preserve valid words',()=>{
  const incoming=[{start:99,end:99.5,text:'Before audio.'},{start:100,end:102,text:'Valid words.'},{start:105,end:130,text:'A late word.'},{start:106,end:130,text:'After audio.'},{start:107,end:108,text:'Outside audio.'},{start:106,end:106,text:'8%'},
    {start:99.8,end:130,text:'before valid late after',words:[{start:99.8,end:100,word:' before'},{start:100.2,end:100.5,word:' valid'},{start:105.5,end:105.9,word:' late'},{start:107,end:108,word:' after'}]}];
  assert.deepEqual(mergeSegments([],incoming,100,106),[{start:100,end:102,text:'Valid words.'},{start:105,end:106,text:'A late word.'},{start:106,end:106,text:'8%'},{start:100.2,end:105.9,text:'valid late'}]);
  assert.deepEqual(mergeSegments([],[{start:99.8,end:100.2,text:'straddling',words:[{start:99.8,end:100.2,word:' straddling'}]}],100,106),[{start:100,end:100.2,text:'straddling'}]);
  assert.deepEqual(mergeSegments([],[{start:105,end:130,text:'Only previously captured audio.'}],106,106),[]);
});
test('bad PCM and invalid timestamps fail at the processing boundary', () => {
  assert.throws(() => encodeWav(new Float32Array([NaN])), /PCM/);
  assert.throws(() => mergeSegments([], [{start:-1,end:2,text:'bad'}], 0), /timestamp/);
});
test('calibrated gate ignores low noise but preserves quiet speech above threshold', () => {
  const chunker=new AudioChunker({threshold:.01});
  assert.deepEqual(chunker.push(new Float32Array(16000).fill(.009)),[]);
  assert.deepEqual(chunker.flush(),[]);
  chunker.push(new Float32Array(16000).fill(.02));
  assert.equal(chunker.flush().length,1);
  for(const threshold of [NaN,0,.1])assert.throws(()=>new AudioChunker({threshold}),/threshold/);
});
