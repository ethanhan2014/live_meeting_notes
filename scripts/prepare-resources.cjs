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
  const archive = path.join(root, '.downloads', 'whisper-bin-x64.zip');
  await download('https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip', archive, archiveHash);
  const staging = path.join(root, '.downloads', 'unpacked');
  fs.rmSync(staging, {recursive:true,force:true});
  if (process.platform === 'win32') {
    const quote = value => `'${value.replace(/'/g, "''")}'`;
    const command = `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(staging)} -Force`;
    execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')], {windowsHide:true});
  } else execFileSync('unzip', ['-q',archive,'-d',staging]);
  const binaries = path.join(root, 'whisper'); fs.mkdirSync(binaries, {recursive:true});
  for (const name of fs.readdirSync(path.join(staging, 'Release'))) {
    if (['whisper-server.exe','whisper-cli.exe','whisper.dll'].includes(name) || /^ggml.*\.dll$/.test(name)) {
      fs.copyFileSync(path.join(staging,'Release',name), path.join(binaries,name));
    }
  }
  const model = path.join(root,'models','ggml-base.en.bin');
  await download('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin', model, modelHash);
  if (!fs.existsSync(path.join(binaries,'whisper-server.exe')) || await hash(model) !== modelHash) throw new Error('Speech resources incomplete.');
  const vadModel=path.join(root,'models','ggml-silero-v6.2.0.bin');
  await download('https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin',vadModel,vadHash);
  const files = {};
  for (const name of fs.readdirSync(binaries)) files['whisper/' + name] = await hash(path.join(binaries,name));
  files['models/ggml-base.en.bin'] = modelHash;
  files['models/ggml-silero-v6.2.0.bin'] = vadHash;
  fs.writeFileSync(path.join(root,'manifest.json'), JSON.stringify({whisperBuild:'b5454',archiveSHA256:archiveHash,files},null,2));
  fs.rmSync(path.join(root,'.downloads'), {recursive:true,force:true});
  console.log('Verified Windows speech binaries, English model and Silero VAD model prepared.');
}
if (require.main === module) prepare().catch(error => { console.error(error.message); process.exitCode=1; });
module.exports = {prepare};
