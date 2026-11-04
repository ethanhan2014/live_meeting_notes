async function drainForShutdown(recording,speech,save,{reason='',timeoutMs=15000}={}) {
  let timer;
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>{
    recording.failure=new Error('Shutdown deadline reached. Pending audio is available for recovery.');
    speech.close();resolve();
  },timeoutMs);});
  try {
    await Promise.race([(recording.recovering || recording.stop()).catch(error=>{recording.failure??=error;}),deadline]);
  } finally {clearTimeout(timer);}
  if(recording.session&&(reason||recording.failure)){
    recording.session.status='incomplete';
    recording.session.incompleteReason=[reason,recording.failure?.message].filter(Boolean).join(' ').slice(0,4096);
    recording.session.interruption=recording.session.incompleteReason;
    let saveTimer;
    try {await Promise.race([save().catch(()=>{}),new Promise(resolve=>{saveTimer=setTimeout(resolve,1000);})]);}
    finally {clearTimeout(saveTimer);}
  }
}
module.exports={drainForShutdown};
