const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {setTimeout:delay}=require('node:timers/promises');
const run=promisify(execFile);

async function main(){
  assert.ok(process.argv[2],'Supply the packaged application executable.');
  const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'meeting-packaged-smoke-'));
  const scripts=path.join(profile,'scripts');
  fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({...require('../lib/settings.cjs').defaults,transcriptFolder:scripts}));
  const port=await new Promise((resolve,reject)=>{const probe=net.createServer();probe.on('error',reject);probe.listen(0,'127.0.0.1',()=>{const selected=probe.address().port;probe.close(()=>resolve(selected));});});
  const child=spawn(path.resolve(process.argv[2]),['--user-data-dir='+profile,'--remote-debugging-port='+port],{cwd:root,stdio:'ignore'});
  let launchError;child.on('error',error=>{launchError=error;});
  try{
    let target;
    for(let attempt=0;attempt<240;attempt++){
      if(launchError)throw launchError;
      try{const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(1000)})).json();target=targets.find(value=>value.type==='page'&&value.title==='Live Meeting Notes');if(target)break;}catch{}
      await delay(250);
    }
    assert.ok(target,'Packaged application did not open its test window within 60 seconds.');
    assert.ok(target.url.includes('/app.asar/'),'Startup did not use the packaged application.');
    const result=await run(process.execPath,[path.join(__dirname,'gui-smoke.cjs'),'--close'],{cwd:root,env:{...process.env,MEETING_SMOKE_PORT:String(port),MEETING_SMOKE_DATA:profile,MEETING_SMOKE_SCRIPTS:scripts},timeout:60000,maxBuffer:1024*1024});
    process.stdout.write(result.stdout);
    for(let attempt=0;attempt<40&&child.exitCode===null;attempt++)await delay(250);
    assert.notEqual(child.exitCode,null,'Packaged app did not shut down.');
    console.log('Packaged startup, isolated settings, English speech readiness and shutdown passed.');
  }finally{
    if(child.pid&&child.exitCode===null){if(process.platform==='win32')await run('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});else child.kill();}
    fs.rmSync(profile,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
