const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const {SpeechEngine}=require('../lib/speech.cjs');

function wavSeconds(wav) {
  if(wav.length<44 || wav.toString('ascii',0,4)!=='RIFF' || wav.toString('ascii',8,12)!=='WAVE' || wav.readUInt32LE(4)+8!==wav.length)throw new Error('Supply an intact PCM WAV file.');
  let format=false,bytes=0;
  for(let offset=12;offset+8<=wav.length;){
    const name=wav.toString('ascii',offset,offset+4),size=wav.readUInt32LE(offset+4),start=offset+8;
    if(start+size>wav.length)throw new Error('Truncated WAV chunk.');
    if(name==='fmt '){
      if(size<16 || wav.readUInt16LE(start)!==1 || wav.readUInt16LE(start+2)!==1 || wav.readUInt32LE(start+4)!==16000 || wav.readUInt16LE(start+14)!==16)throw new Error('Use mono, 16-kHz, signed 16-bit PCM WAV.');
      format=true;
    }
    if(name==='data')bytes+=size;
    offset=start+size+(size%2);
  }
  if(!format || !bytes || bytes%2 || bytes>6*32000 || wav.length>200000)throw new Error('Supply a nonempty WAV of at most six seconds.');
  return bytes/32000;
}
function percentile(values,p) {return [...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]||0;}
function replay(inferenceMs,intervalSeconds,logicalSeconds) {
  let finish=0,maxBacklogSeconds=0,waitingMs=[];
  const jobs=Math.ceil(logicalSeconds/intervalSeconds);
  for(let i=0;i<jobs;i++) {
    const arrival=i*intervalSeconds*1000,wait=Math.max(0,finish-arrival);
    waitingMs.push(wait);maxBacklogSeconds=Math.max(maxBacklogSeconds,wait/1000);
    finish=Math.max(finish,arrival)+inferenceMs[i%inferenceMs.length];
  }
  return {mode:'simulation cycling measured inference timings; no live capture or long-running inference',logicalSeconds,jobs,intervalSeconds,
    maxBacklogSeconds,p95QueueWaitMs:percentile(waitingMs,.95),drainSeconds:Math.max(0,finish/1000-logicalSeconds)};
}
function selfCheck() {
  const assert=require('node:assert/strict');
  const {encodeWav}=require('../lib/audio.cjs');
  assert.equal(wavSeconds(encodeWav(new Float32Array(16000))),1);
  assert.throws(()=>wavSeconds(Buffer.alloc(44)),/WAV/);
  const stereo=encodeWav(new Float32Array(16000));stereo.writeUInt16LE(2,22);assert.throws(()=>wavSeconds(stereo),/mono/);
  assert.equal(percentile([9,1,3,5],.5),3);
  assert.equal(replay([500],1,1800).maxBacklogSeconds,0);
  assert.equal(replay([2000],1,3).maxBacklogSeconds,2);
  assert.equal(replay([2000],1,3).drainSeconds,3);
  console.log(JSON.stringify({selfCheck:'passed'}));
}
async function main(args) {
  if(args.length===1 && args[0]==='--self-check'){selfCheck();return;}
  if(args.includes('--help')){console.log('node scripts/benchmark.cjs --wav short-english-16k.wav [--threads 2,4,6] [--vad on|off|both] [--runs 5] [--logical-seconds 1800] [--json results.json]\nMeasures repeated inference, then simulates arrivals by cycling measured durations. It is not a live meeting soak test.');return;}
  const options={threads:'6',vad:'both',runs:'5','logical-seconds':'1800'};
  for(let i=0;i<args.length;i+=2){
    const key=args[i]?.slice(2);
    if(!args[i]?.startsWith('--') || !['wav','threads','vad','runs','logical-seconds','json'].includes(key) || !args[i+1] || args[i+1].startsWith('--'))throw new Error('Invalid benchmark arguments; use --help.');
    options[key]=args[i+1];
  }
  const threads=options.threads.split(',').map(Number),runs=Number(options.runs),logicalSeconds=Number(options['logical-seconds']);
  if(!options.wav || !threads.length || threads.some(n=>!Number.isInteger(n)||n<1||n>16) || !Number.isInteger(runs)||runs<1||runs>1000 || !Number.isFinite(logicalSeconds)||logicalSeconds<=0||logicalSeconds>86400 || !['on','off','both'].includes(options.vad))throw new Error('Invalid benchmark options; use --help.');
  const wavPath=path.resolve(options.wav),durationSeconds=wavSeconds(await fs.readFile(wavPath));
  const results={mode:'repeated short fixture inference plus simulated logical replay',sample:path.basename(wavPath),durationSeconds,
    machine:{platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,logicalCPUs:os.cpus().length,node:process.version},runs:[]};
  for(const count of threads)for(const vad of options.vad==='both'?[false,true]:[options.vad==='on']){
    const engine=new SpeechEngine(path.resolve(__dirname,'..','resources'),{threads:count,vad});
    try{
      const startup=performance.now();await engine.start();const startupMs=performance.now()-startup;
      const measurements=[];let segments=[];
      for(let i=0;i<runs;i++){
        const started=performance.now();segments=await engine.transcribe(wavPath);measurements.push(performance.now()-started);
        process.stderr.write(`threads=${engine.threads} vad=${vad} run=${i+1}/${runs} inferenceMs=${Math.round(measurements.at(-1))}\n`);
      }
      const total=measurements.reduce((sum,value)=>sum+value,0);
      results.runs.push({threads:engine.threads,vad,startupMs,inferences:runs,p50InferenceMs:percentile(measurements,.5),p95InferenceMs:percentile(measurements,.95),
        rtf:total/(runs*durationSeconds*1000),inferenceMs:measurements,text:segments.map(s=>s.text).join(' ').trim(),segments,
        replay:replay(measurements,durationSeconds===6?5.5:durationSeconds,logicalSeconds)});
    }finally{engine.close();}
  }
  const json=JSON.stringify(results,null,2)+'\n';
  if(options.json)await fs.writeFile(path.resolve(options.json),json,{flag:'wx'});
  console.log(json);
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={wavSeconds,percentile,replay};
