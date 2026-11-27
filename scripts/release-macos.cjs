const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const assert=require('node:assert/strict');
function assertArm64MachO(bytes){
  assert.ok(bytes.length>=32&&bytes.readUInt32LE(0)===0xfeedfacf,'Expected a 64-bit Mach-O executable.');
  assert.equal(bytes.readUInt32LE(4),0x100000c,'The Mac release requires Apple Silicon binaries.');
}
function run(command,args,options={}){
  const result=spawnSync(command,args,{encoding:'utf8',timeout:30000,maxBuffer:1024*1024,...options});
  if(result.error||result.status!==0)throw new Error(command+' failed: '+(result.error?.message||result.stderr||result.stdout));
  return result.stdout;
}
async function main(){
  assert.equal(process.platform,'darwin','Build Mac releases on macOS.');
  assert.equal(process.arch,'arm64','WhisperX releases support Apple Silicon.');
  const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
  const bundle=path.join(root,'src-tauri','target','release','bundle');
  const app=path.join(bundle,'macos','Live Meeting Notes.app'),runtime=path.join(app,'Contents','Resources','runtime');
  for(const file of [path.join(app,'Contents','MacOS','live-meeting-notes'),path.join(runtime,'node')])assertArm64MachO(await fs.readFile(file));
  const manifest=JSON.parse(await fs.readFile(path.join(runtime,'manifest.json'),'utf8'));
  assert.equal(manifest.platform,'darwin');assert.equal(manifest.arch,'arm64');
  assert.equal(await fs.readFile(path.join(runtime,'main.cjs'),'utf8'),await fs.readFile(path.join(root,'main.cjs'),'utf8'));
  // Bundled defaults can contain private API keys.
  assert.equal((await fs.readdir(runtime)).includes('.env'),false,'Public releases must not bundle private API defaults.');
  run('codesign',['--verify','--deep','--strict',app]);
  assert.ok(run('/usr/libexec/PlistBuddy',['-c','Print :NSMicrophoneUsageDescription',path.join(app,'Contents','Info.plist')]).trim());
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'meeting-mac-release-'));
  try{
    const output=run(path.join(runtime,'node'),['main.cjs'],{cwd:runtime,input:JSON.stringify({id:1,method:'meeting-state-get',args:[]})+'\n',env:{...process.env,MEETING_DATA_DIR:data}});
    const state=output.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).find(item=>item.id===1)?.value;
    assert.equal(state?.platform,'darwin');assert.equal(state.session,null);assert.equal(state.settings.apiKey,'');
  }finally{await fs.rm(data,{recursive:true,force:true});}
  const output=path.join(root,'dist','releases');await fs.mkdir(output,{recursive:true});
  const prefix='Live-Meeting-Notes-'+version+'-mac-arm64';
  const images=(await fs.readdir(path.join(bundle,'dmg'))).filter(name=>name.endsWith('.dmg'));assert.equal(images.length,1);
  const dmg=prefix+'.dmg',zip=prefix+'.zip';
  await fs.copyFile(path.join(bundle,'dmg',images[0]),path.join(output,dmg));
  run('ditto',['-c','-k','--sequesterRsrc','--keepParent',app,path.join(output,zip)],{timeout:120000});
  const hashes=[];for(const name of [dmg,zip])hashes.push(createHash('sha256').update(await fs.readFile(path.join(output,name))).digest('hex')+'  '+name);
  await fs.writeFile(path.join(output,'SHA256SUMS.txt'),hashes.join('\n')+'\n');
  console.log('Verified Mac release: '+dmg+' and '+zip);
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={assertArm64MachO};
