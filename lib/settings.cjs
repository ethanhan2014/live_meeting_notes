const fs=require('node:fs/promises');
const path=require('node:path');
const {atomicWrite}=require('./session.cjs');
const {validateExecutable}=require('./executables.cjs');

const defaults=Object.freeze({codexExecutable:'',threads:6,micGain:1,systemGain:1,noiseThreshold:.004,vad:false,
  summaryAgent:'codex',summaryModel:'gpt-6-luna',summaryEffort:'medium',answerAgent:'codex',answerModel:'',answerEffort:'',transcriptFolder:''});
function validateSettings(value,platform=process.platform) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!Object.hasOwn(defaults,key))) throw new Error('Invalid app settings.');
  const settings={...defaults,...value};
  if (!Number.isInteger(settings.threads) || settings.threads<1 || settings.threads>16 ||
      ![settings.micGain,settings.systemGain].every(gain=>Number.isFinite(gain)&&gain>=0&&gain<=3) ||
      !Number.isFinite(settings.noiseThreshold) || settings.noiseThreshold<.0005 || settings.noiseThreshold>.05 || typeof settings.vad!=='boolean') throw new Error('Invalid audio settings.');
  const executable=settings.codexExecutable;
  if(typeof executable!=='string')throw new Error('Choose an absolute path to the native Codex executable.');
  if(executable)validateExecutable(executable,platform);
  for(const prefix of ['summary','answer']){
    if(!['codex','claude','opencode','gemini'].includes(settings[prefix+'Agent']))throw new Error('Invalid AI agent.');
    const model=settings[prefix+'Model'],effort=settings[prefix+'Effort'];
    if(typeof model!=='string'||model.length>200||/[\r\n\0]/.test(model)||typeof effort!=='string'||!['','minimal','low','medium','high','xhigh','max'].includes(effort))throw new Error('Invalid model or effort settings.');
    const supported={codex:['','minimal','low','medium','high','xhigh'],claude:['','low','medium','high','xhigh','max'],opencode:['','low','medium','high','max'],gemini:['','low','medium','high']};
    if(!supported[settings[prefix+'Agent']].includes(effort))throw new Error('The selected effort is not supported by this agent.');
  }
  const folder=settings.transcriptFolder;
  if(typeof folder!=='string'||folder.length>4096||/[\r\n\0]/.test(folder)||(folder&&!(platform==='win32'?path.win32:path.posix).isAbsolute(folder)))throw new Error('Choose an absolute transcript folder path.');
  return settings;
}
async function loadSettings(file) {
  try {return validateSettings(JSON.parse(await fs.readFile(file,'utf8')));}
  catch(error){if(error.code==='ENOENT')return {...defaults};throw error;}
}
async function saveSettings(file,settings){const value=validateSettings(settings);await atomicWrite(file,JSON.stringify(value,null,2)+'\n');return value;}
module.exports={defaults,validateSettings,loadSettings,saveSettings};
