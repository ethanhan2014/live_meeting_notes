const fs=require('node:fs/promises');
const {constants,readdirSync}=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');

function validateExecutable(value,platform=process.platform){
  const paths=platform==='win32'?path.win32:path.posix;
  if(typeof value!=='string'||value.length>4096||!paths.isAbsolute(value)||/[\r\n\0]/.test(value)||(platform==='win32'&&!/\.exe$/i.test(value)))throw new Error('Choose an absolute path to the native Codex executable.');
  return value;
}
function cliEnvironment(platform=process.platform,environment=process.env){
  if(platform==='win32')return {...environment};
  const userDirectory=environment.HOME||os.homedir();
  const directories=[...(environment.PATH||'').split(':'),path.posix.join(userDirectory,'.local','bin'),path.posix.join(userDirectory,'.opencode','bin'),path.posix.join(userDirectory,'.bun','bin'),path.posix.join(userDirectory,'.volta','bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'];
  const versions=path.posix.join(userDirectory,'.nvm','versions','node');
  try{directories.push(...readdirSync(versions).filter(name=>/^v\d+\.\d+\.\d+$/.test(name)).sort((a,b)=>b.localeCompare(a,'en',{numeric:true})).map(name=>path.posix.join(versions,name,'bin')));}catch{}
  return {...environment,PATH:[...new Set(directories.filter(directory=>path.posix.isAbsolute(directory)))].join(':')};
}
async function findExecutables(name,platform=process.platform,environment=process.env){
  if(platform==='win32')return new Promise(resolve=>execFile('where.exe',[name],{windowsHide:true,timeout:5000,maxBuffer:16000},(error,stdout)=>resolve(error?[]:stdout.trim().split(/\r?\n/).filter(Boolean))));
  const files=[];
  for(const directory of cliEnvironment(platform,environment).PATH.split(':')){
    const file=path.posix.join(directory,name);
    try{await fs.access(file,constants.X_OK);if((await fs.stat(file)).isFile())files.push(file);}catch{}
  }
  return files;
}
module.exports={validateExecutable,cliEnvironment,findExecutables};
