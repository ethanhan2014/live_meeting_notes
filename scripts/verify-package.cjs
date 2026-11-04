const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const asar=require('@electron/asar');

const root=path.resolve(__dirname,'..'),resources=path.resolve(process.argv[2]||'dist/win-unpacked/resources');
const archive=path.join(resources,'app.asar'),metadata=require('../package.json');
const sourceFiles=['main.cjs','preload.cjs','LICENSE','THIRD-PARTY-NOTICES.txt',...['lib','renderer'].flatMap(directory=>fs.readdirSync(path.join(root,directory)).map(name=>directory+'/'+name))];
for(const file of sourceFiles)assert.deepEqual(asar.extractFile(archive,file),fs.readFileSync(path.join(root,file)),file);
const allowed=new Set([...sourceFiles.map(name=>'/'+name),'/package.json','/lib','/renderer','/node_modules','/node_modules/smol-toml']);
for(const entry of asar.listPackage(archive)){
  const file=entry.split(path.sep).join('/');
  assert.ok(allowed.has(file)||file.startsWith('/node_modules/smol-toml/'),'Unexpected bundled file: '+file);
}
const packaged=JSON.parse(asar.extractFile(archive,'package.json'));
assert.equal(packaged.version,metadata.version);assert.deepEqual(packaged.dependencies,metadata.dependencies);
for(const name of ['notes.json','answer.json'])assert.deepEqual(fs.readFileSync(path.join(resources,'schemas',name)),fs.readFileSync(path.join(root,'schemas',name)));
const speechRoot=path.join(resources,'resources'),manifest=JSON.parse(fs.readFileSync(path.join(speechRoot,'manifest.json')));
assert.equal(manifest.platform,process.platform);assert.equal(manifest.arch,process.arch);
for(const [name,digest]of Object.entries(manifest.files))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(speechRoot,name))).digest('hex'),digest,name);
const binaryNames=fs.readdirSync(path.join(speechRoot,'whisper'));
assert.deepEqual(binaryNames.sort(),Object.keys(manifest.files).filter(name=>name.startsWith('whisper/')).map(name=>name.slice('whisper/'.length)).sort());
if(process.platform==='darwin'){
  const executable=fs.readFileSync(path.join(speechRoot,'whisper','whisper-server'));
  assert.equal(executable.readUInt32LE(0),0xfeedfacf);
  assert.equal(executable.readUInt32LE(4),process.arch==='arm64'?0x0100000c:0x01000007);
}
console.log(JSON.stringify({verification:'passed',platform:process.platform,arch:process.arch,version:metadata.version,sourceFiles:sourceFiles.length,speechResources:Object.keys(manifest.files).length}));
