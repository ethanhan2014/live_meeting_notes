const RATE = 16000;

function encodeWav(pcm) {
  if (!(pcm instanceof Float32Array) || pcm.length > RATE * 6 || !pcm.every(Number.isFinite)) {
    throw new TypeError('Invalid PCM audio');
  }
  const wav = Buffer.alloc(44 + pcm.length * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(pcm.length * 2, 40);
  pcm.forEach((sample, index) => {
    const value = Math.max(-1, Math.min(1, sample));
    wav.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + index * 2);
  });
  return wav;
}

class AudioChunker {
  constructor({threshold=.004}={}) {
    if (!Number.isFinite(threshold) || threshold < .0005 || threshold > .05) throw new TypeError('Invalid noise threshold');
    this.threshold=threshold;
    this.samples = []; this.total = 0; this.start = 0;
    this.silence = 0; this.hasSpeech = false; this.overlapUntil = 0;
  }
  push(pcm) {
    if (!(pcm instanceof Float32Array) || !pcm.every(Number.isFinite)) throw new TypeError('Invalid PCM audio');
    const chunks = [];
    for (let offset = 0; offset < pcm.length; offset += 1600) {
      const frame = pcm.subarray(offset, offset + 1600);
      const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length);
      this.samples.push(...frame); this.total += frame.length;
      if (rms > this.threshold) { this.hasSpeech = true; this.silence = 0; }
      else this.silence += frame.length;
      if (!this.hasSpeech) {
        this.samples = this.samples.slice(-4800);
        this.start = (this.total - this.samples.length) / RATE;
      } else if (this.silence >= 9600) {
        chunks.push(this.emit());
        this.samples = []; this.start = this.total / RATE; this.hasSpeech = false;
        this.overlapUntil = 0; this.silence = 0;
      } else if (this.samples.length >= RATE * 6) {
        chunks.push(this.emit(RATE * 6));
        this.samples = this.samples.slice(RATE * 6 - 8000);
        this.start = chunks.at(-1).end - .5;
        this.overlapUntil = chunks.at(-1).end;
      }
    }
    return chunks;
  }
  emit(length = this.samples.length) {
    return {start:this.start, end:this.start + length / RATE,
      overlapUntil:this.overlapUntil, pcm:Float32Array.from(this.samples.slice(0, length))};
  }
  flush() {
    const chunks = this.hasSpeech && this.samples.length ? [this.emit()] : [];
    this.samples = []; this.hasSpeech = false; this.silence = 0;
    return chunks;
  }
}

function mergeSegments(existing, incoming, overlapUntil = 0, chunkEnd = Infinity) {
  const result = [...existing];
  for (const segment of incoming) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
        segment.start < 0 || segment.end < segment.start || typeof segment.text !== 'string') {
      throw new TypeError('Invalid transcript timestamp or text');
    }
    if (segment.end <= overlapUntil || chunkEnd <= overlapUntil) continue;
    if (segment.start > chunkEnd || segment.start === chunkEnd && segment.end > segment.start) continue;
    let {start, end, text} = segment;
    if ((start < overlapUntil || end > chunkEnd) && Array.isArray(segment.words) && segment.words.length) {
      const words = segment.words.filter(word => Number.isFinite(word.start) &&
        Number.isFinite(word.end) && word.end > overlapUntil && word.start < chunkEnd && typeof word.word === 'string');
      if (!words.length) continue;
      start = Math.max(overlapUntil, words[0].start); end = Math.max(start, words.at(-1).end);
      text = words.map(word => word.word).join('').trim();
    } else if (start < overlapUntil) {
      // shortcut: segment-only overlap can repeat boundary text, use token timing when the backend supplies it.
      start = overlapUntil;
    }
    end=Math.min(end,chunkEnd);text=text.trim();
    // shortcut: only long single-letter loops are filtered, use acoustic confidence for subtler hallucinations.
    if (end>=start && text && !/(\p{L})\1{15,}/u.test(text) &&
        !result.some(previous=>previous.start===start&&previous.end===end&&previous.text===text)) result.push({start,end,text});
  }
  return result;
}
module.exports = {encodeWav, AudioChunker, mergeSegments};
