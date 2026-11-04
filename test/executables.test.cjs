const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const {once}=require('node:events');
const {setTimeout:delay}=require('node:timers/promises');
const {validateExecutable,cliEnvironment,findExecutables}=require('../lib/executables.cjs');
const {CodexJobs}=require('../lib/codex.cjs');

test('native Mac executable paths need no extension and reject shell input',()=>{
 assert.equal(validateExecutable('/opt/homebrew/bin/codex','darwin'),'/opt/homebrew/bin/codex');
 for(const value of ['codex','./codex','C:\\Tools\\codex.exe','/opt/codex\n--flag','/opt/codex\0'])assert.throws(()=>validateExecutable(value,'darwin'));
});
test('Finder CLI environments retain existing settings and add absolute installation paths',()=>{
 const environment={HOME:'/Users/example',PATH:'/usr/bin:.:/bin:/usr/bin',CUSTOM_SETTING:'preserved'},before={...environment};
 const value=cliEnvironment('darwin',environment),directories=value.PATH.split(':');
 assert.deepEqual(environment,before);assert.equal(value.CUSTOM_SETTING,'preserved');assert.equal(value.HOME,environment.HOME);
 assert.equal(directories[0],'/usr/bin');assert.ok(!directories.includes('.'));assert.equal(new Set(directories).size,directories.length);
 for(const directory of ['/opt/homebrew/bin','/usr/local/bin','/Users/example/.local/bin','/Users/example/.opencode/bin'])assert.ok(directories.includes(directory));
 assert.deepEqual(cliEnvironment('win32',environment),environment);
});
test('POSIX CLI discovery respects PATH order, follows symlinks and skips non-executable files and directories',{skip:process.platform==='win32'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-cli-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const first=path.join(root,'first'),second=path.join(root,'second'),local=path.join(root,'.local','bin');
 for(const directory of [first,second,local])await fs.mkdir(directory,{recursive:true});
 const name='meeting-fixture-agent';await fs.writeFile(path.join(first,name),'not executable',{mode:0o644});
 await fs.writeFile(path.join(second,name),'#!/bin/sh\nexit 0\n',{mode:0o755});await fs.symlink(path.join(second,name),path.join(local,name));
 let found=await findExecutables(name,'darwin',{HOME:root,PATH:first+':'+second});assert.deepEqual(found,[path.join(second,name),path.join(local,name)]);
 await fs.rm(path.join(first,name));await fs.mkdir(path.join(first,name));found=await findExecutables(name,'darwin',{HOME:root,PATH:first+':'+second});assert.deepEqual(found,[path.join(second,name),path.join(local,name)]);
});
test('all four agents can be detected from a user bin directory without a login shell',{skip:process.platform==='win32'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-agents-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const directory=path.join(root,'.local','bin');await fs.mkdir(directory,{recursive:true});
 for(const name of ['codex','claude','opencode','gemini'])await fs.writeFile(path.join(directory,name),'#!/bin/sh\nexit 0\n',{mode:0o755});
 const source="require("+JSON.stringify(require.resolve('../lib/agents.cjs'))+").detectAgents().then(value=>console.log(JSON.stringify(value)))";
 const {stdout}=await promisify(execFile)(process.execPath,['-e',source],{env:{...process.env,HOME:root,PATH:'/usr/bin:/bin'}});
 const detected=JSON.parse(stdout);assert.equal(detected.length,4);
 for(const agent of detected){assert.equal(agent.available,true);assert.equal(agent.command,path.join(directory,agent.id));assert.deepEqual(agent.prefix,[]);}
});
test('Finder discovery also finds npm CLIs installed through nvm',{skip:process.platform==='win32'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-nvm-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const version of ['v22.20.0','v24.1.0']){const directory=path.join(root,'.nvm','versions','node',version,'bin');await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'meeting-nvm-agent'),'#!/bin/sh\nexit 0\n',{mode:0o755});}
 const files=await findExecutables('meeting-nvm-agent','darwin',{HOME:root,PATH:'/usr/bin:/bin'});
 assert.deepEqual(files,['v24.1.0','v22.20.0'].map(version=>path.join(root,'.nvm','versions','node',version,'bin','meeting-nvm-agent')));
});
test('POSIX cancellation stops nested CLI processes',{skip:process.platform==='win32',timeout:5000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-cancel-')),heartbeat=path.join(root,'heartbeat');
 const grandchild="const fs=require('node:fs');let count=0;setInterval(()=>fs.writeFileSync("+JSON.stringify(heartbeat)+",String(++count)),25)";
 const parent="const child=require('node:child_process').spawn(process.execPath,['-e',"+JSON.stringify(grandchild)+"],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000)";
 const child=spawn(process.execPath,['-e',parent],{detached:true,stdio:['ignore','pipe','ignore']});let descendant;
 t.after(async()=>{for(const pid of [descendant,child.pid])if(pid)try{process.kill(pid,'SIGKILL');}catch{}await fs.rm(root,{recursive:true,force:true});});
 const [data]=await once(child.stdout,'data');descendant=Number(String(data).trim());assert.ok(Number.isInteger(descendant)&&descendant>0);
 for(let attempt=0;attempt<40;attempt++){try{await fs.access(heartbeat);break;}catch{await delay(25);}}
 const exited=once(child,'exit'),jobs=new CodexJobs('unused');jobs.child=child;jobs.cancel();await exited;await delay(100);
 const value=await fs.readFile(heartbeat,'utf8');await delay(150);assert.equal(await fs.readFile(heartbeat,'utf8'),value);assert.equal(jobs.cancelled,true);
});
