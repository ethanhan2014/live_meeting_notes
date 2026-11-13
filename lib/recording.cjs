const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {newSession,saveSession,commitSession,atomicWrite,validateSession,SESSION_ID,readRegular} = require('./session.cjs');
const {AudioChunker,encodeWav,mergeSegments} = require('./audio.cjs');
const MAX_WAV_BYTES=44+16000*6*2;

function percentile(values) {
  return values.length ? [...values].sort((a,b) => a-b)[Math.ceil(values.length*.95)-1] : 0;
}

function validateManifest(value,filename,sessionId) {
  if(!value || value.version!==1 || typeof value.id!=='string' || !SESSION_ID.test(value.id) ||
    filename!==value.id+'.json' || value.sessionId!==sessionId || value.wav!==value.id+'.wav' ||
    !Number.isFinite(value.start) || value.start<0 || !Number.isFinite(value.end) || value.end<=value.start ||
    value.end-value.start>6.000001 || !Number.isFinite(value.overlapUntil) || value.overlapUntil<0 ||
    (value.overlapUntil!==0 && (value.overlapUntil<value.start || value.overlapUntil>value.end)) ||
    !Number.isInteger(value.bytes) || value.bytes<46 || value.bytes>MAX_WAV_BYTES ||
    typeof value.queuedAt!=='string' || !Number.isFinite(Date.parse(value.queuedAt)) ||
    new Date(value.queuedAt).toISOString()!==value.queuedAt) throw new Error('Invalid pending audio manifest.');
  return value;
}

function validateWav(wav,chunk) {
  if(wav.length!==chunk.bytes || wav.length<44 || wav.toString('ascii',0,4)!=='RIFF' ||
    wav.readUInt32LE(4)!==wav.length-8 || wav.toString('ascii',8,16)!=='WAVEfmt ' ||
    wav.readUInt32LE(16)!==16 || wav.readUInt16LE(20)!==1 || wav.readUInt16LE(22)!==1 ||
    wav.readUInt32LE(24)!==16000 || wav.readUInt32LE(28)!==32000 ||
    wav.readUInt16LE(32)!==2 || wav.readUInt16LE(34)!==16 || wav.toString('ascii',36,40)!=='data' ||
    wav.readUInt32LE(40)!==wav.length-44 || wav.length!==44+Math.round((chunk.end-chunk.start)*16000)*2) {
    throw new Error('Missing or corrupt pending audio; original files were preserved.');
  }
}

class Recording {
  constructor(root,engine,changed) {
    this.root=root;this.engine=engine;this.changed=changed;this.threshold=.004;
    this.session=null;this.active=false;this.queue=Promise.resolve();this.failure=null;
  }
  resetMetrics() {
    this.pending=0;this.chunks=new Map();this.inferences=[];this.latencies=[];this.audioSeconds=0;
  }
  get session() {return this._session;}
  set session(value) {this._session=value;this.resetMetrics();}
  get metrics() {
    const pending=[...this.chunks.values()];
    return {inferenceMs:this.inferences.at(-1) ?? 0,p95InferenceMs:percentile(this.inferences),
      p95LatencyMs:percentile(this.latencies),pendingSeconds:pending.reduce((sum,chunk)=>sum+chunk.end-chunk.start,0),
      pendingBytes:pending.reduce((sum,chunk)=>sum+chunk.bytes,0),
      rtf:this.audioSeconds ? this.inferences.reduce((sum,value)=>sum+value,0)/(1000*this.audioSeconds) : 0,
      processedChunks:this.session?.processedChunks?.length ?? 0};
  }
  async start() {
    if(this.active || this.recovering || this.session?.status==='finishing') throw new Error('Finish the current recording first.');
    await this.engine.start();
    const session=newSession();const chunker=new AudioChunker({threshold:this.threshold});
    const audioDir=path.join(this.root,session.id+'.audio');
    await fs.mkdir(audioDir,{recursive:true});await saveSession(this.root,session);
    this.session=session;this.chunker=chunker;this.audioDir=audioDir;
    this.failure=null;this.queue=Promise.resolve();this.stopping=null;
    this.active=true;this.changed();return this.session;
  }
  push(pcm) {
    if(!this.active) return;
    if(!(pcm instanceof Float32Array) || pcm.length>32000) throw new Error('Invalid audio packet.');
    for(const chunk of this.chunker.push(pcm)) this.enqueue(chunk);
  }
  async markFailure(error) {
    this.failure ??= error;
    this.session.status='incomplete';this.session.incompleteReason=String(this.failure.message).slice(0,4096);
    await saveSession(this.root,this.session).catch(()=>{});
  }
  enqueue(chunk) {
    const id=randomUUID();const wav=encodeWav(chunk.pcm);
    const manifest={version:1,id,sessionId:this.session.id,start:chunk.start,end:chunk.end,
      overlapUntil:chunk.overlapUntil,wav:id+'.wav',bytes:wav.length,queuedAt:new Date(Date.now()).toISOString()};
    this.chunks.set(id,manifest);this.pending=this.chunks.size;
    const spooled=(async () => {
      await atomicWrite(path.join(this.audioDir,id+'.json'),JSON.stringify(manifest)+'\n');
      await atomicWrite(path.join(this.audioDir,manifest.wav),wav);
      return true;
    })().catch(error=>{this.failure ??= error;return false;});
    this.queue=this.queue.then(async () => {
      try {
        if(!await spooled || this.failure) {if(this.failure) await this.markFailure(this.failure);return;}
        await this.processChunk(manifest);
      } catch(error) {await this.markFailure(error);}
      finally {this.changed();}
    });
    this.changed();
  }
  async processChunk(chunk) {
    const destination=path.join(this.audioDir,chunk.wav);
    if(!this.session.processedChunks?.includes(chunk.id)) {
      validateWav(await readRegular(destination,MAX_WAV_BYTES),chunk);
      const began=Date.now();let segments;
      try {segments=await this.engine.transcribe(destination);}
      finally {this.inferences.push(Math.max(0,Date.now()-began));this.audioSeconds+=chunk.end-chunk.start;}
      const shifted=segments.map(segment=>({...segment,start:chunk.start+segment.start,end:chunk.start+segment.end,
        words:segment.words?.map(word=>({...word,start:chunk.start+word.start,end:chunk.start+word.end}))}));
      const transcript=mergeSegments(this.session.transcript,shifted,Math.max(chunk.start,chunk.overlapUntil),chunk.end).sort((a,b)=>a.start-b.start || a.end-b.end);
      const processedChunks=[...(this.session.processedChunks ?? []),chunk.id];
      this.latencies.push(Math.max(0,Date.now()-Date.parse(chunk.queuedAt)));
      const current=this.metrics;
      const metrics={...current,pendingSeconds:Math.max(0,current.pendingSeconds-(chunk.end-chunk.start)),
        pendingBytes:Math.max(0,current.pendingBytes-chunk.bytes),processedChunks:processedChunks.length};
      await commitSession(this.root,this.session,{transcript,processedChunks,metrics,notes:null,answers:[],notesEdited:false,
        ...(this.recovering ? {transcriptRevision:(this.session.transcriptRevision||0)+1} : {})});
    }
    this.chunks.delete(chunk.id);this.pending=this.chunks.size;
    // Commit IDs with text before cleanup so a crash here only repeats deletion.
    await fs.rm(destination,{force:true});
    await fs.rm(path.join(this.audioDir,chunk.id+'.json'),{force:true});
  }
  async audioEntries() {
    if(!this.session) return [];
    validateSession(this.session);this.audioDir=path.join(this.root,this.session.id+'.audio');
    let stat;
    try {stat=await fs.lstat(this.audioDir);} catch(error) {if(error.code==='ENOENT') return [];throw error;}
    if(!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Pending audio directory must not be a symlink.');
    return fs.readdir(this.audioDir,{withFileTypes:true});
  }
  async recoverable() {
    const entries=await this.audioEntries();const names=new Set(entries.map(entry=>entry.name));
    let bytes=0;let legacyCount=0;let count=0;
    for(const entry of entries) {
      if(entry.name.endsWith('.json')) count++;
      if(!entry.name.endsWith('.wav')) {if(!entry.name.endsWith('.json')) legacyCount++;continue;}
      if(!names.has(entry.name.slice(0,-4)+'.json')) legacyCount++;
      if(entry.isFile()) bytes+=(await fs.lstat(path.join(this.audioDir,entry.name))).size;
    }
    return {count,bytes,legacyCount};
  }
  recover() {
    if(this.active || this.session?.status==='finishing') return Promise.reject(new Error('Finish the current recording first.'));
    if(this.recovering) return this.recovering;
    if(!this.session) return Promise.reject(new Error('Open a session before recovering audio.'));
    this.recovering=this.replay().finally(()=>{this.recovering=null;});return this.recovering;
  }
  async replay() {
    this.failure=null;this.stopping=null;this.resetMetrics();const problems=[];
    try {
      const entries=await this.audioEntries();const names=new Set(entries.map(entry=>entry.name));const chunks=[];
      if(!entries.length) return this.session;
      for(const entry of entries) {
        if(!entry.name.endsWith('.wav') && !entry.name.endsWith('.json')) problems.push('Unrecognized pending audio data was preserved.');
        if(entry.name.endsWith('.wav') && !names.has(entry.name.slice(0,-4)+'.json')) {
          problems.push('Legacy audio lacks timestamps and was preserved.');
        }
        if(!entry.name.endsWith('.json')) continue;
        try {
          const manifest=validateManifest(JSON.parse((await readRegular(path.join(this.audioDir,entry.name),4096)).toString('utf8')),
            entry.name,this.session.id);
          chunks.push(manifest);
          if(!this.session.processedChunks?.includes(manifest.id)) this.chunks.set(manifest.id,manifest);
        } catch(error) {problems.push('Invalid audio manifest was preserved: '+error.message);}
      }
      this.pending=this.chunks.size;this.changed();let started=false;
      for(const chunk of chunks.sort((a,b)=>a.start-b.start || a.id.localeCompare(b.id))) {
        if(this.failure) throw this.failure;
        try {
          if(!this.session.processedChunks?.includes(chunk.id)) {
            validateWav(await readRegular(path.join(this.audioDir,chunk.wav),MAX_WAV_BYTES),chunk);
            if(!started) {await this.engine.start();started=true;}
          }
          if(this.failure) throw this.failure;
          await this.processChunk(chunk);
        } catch(error) {problems.push('Pending audio could not be recovered: '+error.message);}
        this.changed();
      }
      if(problems.length) throw new Error(problems.join(' ').slice(0,4096));
      if(this.failure) throw this.failure;
      await commitSession(this.root,this.session,{status:this.session.interruption ? 'incomplete' : 'complete',endedAt:this.session.endedAt ?? new Date().toISOString(),
        incompleteReason:this.session.interruption || '',metrics:this.metrics});this.changed();return this.session;
    } catch(error) {await this.markFailure(error);this.changed();throw error;}
  }
  stop() {
    if(this.stopping) return this.stopping;
    if(!this.active) return Promise.resolve(this.session);
    this.active=false;
    for(const chunk of this.chunker.flush()) this.enqueue(chunk);
    this.session.status=this.failure ? 'incomplete' : 'finishing';this.changed();
    this.stopping=(async () => {
      await this.queue;
      await commitSession(this.root,this.session,{endedAt:new Date().toISOString(),status:this.failure ? 'incomplete' : 'complete',
        metrics:this.metrics,...(this.failure ? {incompleteReason:String(this.failure.message).slice(0,4096)} : {})});this.changed();
      if(this.failure) throw this.failure;
      return this.session;
    })();
    return this.stopping;
  }
}
module.exports={Recording};
