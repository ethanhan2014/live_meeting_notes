const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');

const root = path.resolve(__dirname, '..', 'resources');
const archiveHash = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb';
const modelHash = 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002';
const vadHash = '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987';
const sourceHash = '9aa617f410d9c7f0dae952eb2b77eafdcfb310c2d622cca1f83633fd89a213bc';
async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function download(url, destination, expected) {
  if (fs.existsSync(destination) && await hash(destination) === expected) return;
  fs.mkdirSync(path.dirname(destination), {recursive:true});
  const temporary = destination + '.part';
  try {
    const response = await fetch(url, {signal:AbortSignal.timeout(300000)});
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, {flags:'w'}));
    if (await hash(temporary) !== expected) throw new Error('Downloaded speech resource checksum does not match upstream.');
    fs.renameSync(temporary, destination);
  } catch (error) { fs.rmSync(temporary, {force:true}); throw error; }
}
async function prepare() {
  const mac=process.platform==='darwin';
  if(mac&&!['arm64','x64'].includes(process.arch))throw new Error('macOS speech resources require Apple Silicon or Intel x64.');
  const archive = path.join(root, '.downloads', mac?'whisper-b5454.tar.gz':'whisper-bin-x64.zip');
  await download(mac?'https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/b5454':'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip', archive, mac?sourceHash:archiveHash);
  const staging = path.join(root, '.downloads', 'unpacked');
  fs.rmSync(staging, {recursive:true,force:true});
  let sourceDirectory,names;
  if(mac){
    fs.mkdirSync(staging,{recursive:true});
    execFileSync('tar',['-xzf',archive,'-C',staging]);
    const source=path.join(staging,'whisper.cpp-b5454'),build=path.join(staging,'build');
    try{
      execFileSync('cmake',['-S',source,'-B',build,'-DCMAKE_BUILD_TYPE=Release','-DBUILD_SHARED_LIBS=OFF','-DGGML_NATIVE=OFF','-DGGML_METAL=OFF','-DGGML_BLAS=ON','-DGGML_BLAS_VENDOR=Apple','-DGGML_OPENMP=OFF','-DWHISPER_BUILD_TESTS=OFF','-DWHISPER_BUILD_SERVER=ON','-DCMAKE_OSX_DEPLOYMENT_TARGET=14.2','-DCMAKE_OSX_ARCHITECTURES='+(process.arch==='arm64'?'arm64':'x86_64')],{stdio:'inherit'});
      execFileSync('cmake',['--build',build,'--config','Release','--target','whisper-server','whisper-cli','--parallel','4'],{stdio:'inherit'});
    }catch(error){if(error.code==='ENOENT')throw new Error('Install CMake and Xcode Command Line Tools, then prepare resources again.');throw error;}
    sourceDirectory=path.join(build,'bin');names=['whisper-server','whisper-cli'];
  }else if (process.platform === 'win32') {
    const quote = value => `'${value.replace(/'/g, "''")}'`;
    const command = `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(staging)} -Force`;
    execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')], {windowsHide:true});
  } else execFileSync('unzip', ['-q',archive,'-d',staging]);
  if(!mac){sourceDirectory=path.join(staging,'Release');names=fs.readdirSync(sourceDirectory).filter(name=>['whisper-server.exe','whisper-cli.exe','whisper.dll'].includes(name)||/^ggml.*\.dll$/.test(name));}
  for(const name of names)if(!fs.existsSync(path.join(sourceDirectory,name)))throw new Error('Speech binaries are incomplete.');
  const binaries = path.join(root, 'whisper');
  fs.rmSync(binaries,{recursive:true,force:true});fs.mkdirSync(binaries, {recursive:true});
  for (const name of names) {
    const destination=path.join(binaries,name);fs.copyFileSync(path.join(sourceDirectory,name),destination);
    if(mac){fs.chmodSync(destination,0o755);execFileSync('codesign',['--force','--sign','-',destination],{stdio:'inherit'});}
  }
  const model = path.join(root,'models','ggml-base.en.bin');
  await download('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin', model, modelHash);
  if (!fs.existsSync(path.join(binaries,mac?'whisper-server':'whisper-server.exe')) || await hash(model) !== modelHash) throw new Error('Speech resources incomplete.');
  const vadModel=path.join(root,'models','ggml-silero-v6.2.0.bin');
  await download('https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin',vadModel,vadHash);
  const files = {};
  for (const name of fs.readdirSync(binaries)) files['whisper/' + name] = await hash(path.join(binaries,name));
  files['models/ggml-base.en.bin'] = modelHash;
  files['models/ggml-silero-v6.2.0.bin'] = vadHash;
  fs.writeFileSync(path.join(root,'manifest.json'), JSON.stringify({whisperBuild:'b5454',platform:mac?'darwin':'win32',arch:mac?process.arch:'x64',...(mac?{sourceSHA256:sourceHash}:{archiveSHA256:archiveHash}),files},null,2));
  fs.rmSync(path.join(root,'.downloads'), {recursive:true,force:true});
  console.log(`Verified ${mac?'macOS '+process.arch:'Windows x64'} speech binaries, English model and Silero VAD model prepared.`);
}
if (require.main === module) prepare().catch(error => { console.error(error.message); process.exitCode=1; });
module.exports = {prepare};
