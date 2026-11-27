const fs=require('node:fs/promises');
const path=require('node:path');
const {atomicWrite}=require('./session.cjs');

const defaults=Object.freeze({threads:6,micGain:1,systemGain:1,noiseThreshold:.004,
  pythonExecutable:'',speechModel:'base.en',batchSize:4,
  apiProvider:'proxy',apiBaseUrl:'http://127.0.0.1:4000/v1',apiKey:'',summaryModel:'',answerModel:'',transcriptFolder:''});
function validateSettings(value,platform=process.platform) {
  if(value&&Object.hasOwn(value,'vad')){if(typeof value.vad!=='boolean')throw new Error('Invalid audio settings.');const {vad,...current}=value;value=current;}
  if(value&&Object.hasOwn(value,'speechDevice')){if(!['cpu','cuda'].includes(value.speechDevice))throw new Error('Invalid audio settings.');const {speechDevice,...current}=value;value=current;}
  if(value&&typeof value==='object'&&!Array.isArray(value)){value={...value};for(const key of ['codexExecutable','summaryAgent','summaryEffort','answerAgent','answerEffort'])delete value[key];}
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!Object.hasOwn(defaults,key))) throw new Error('Invalid app settings.');
  const settings={...defaults,...value};
  if (!Number.isInteger(settings.threads) || settings.threads<1 || settings.threads>16 ||
      ![settings.micGain,settings.systemGain].every(gain=>Number.isFinite(gain)&&gain>=0&&gain<=3) ||
      !Number.isFinite(settings.noiseThreshold) || settings.noiseThreshold<.0005 || settings.noiseThreshold>.05 ||
      !['base.en','small.en','medium.en','large-v3'].includes(settings.speechModel)||
      !Number.isInteger(settings.batchSize)||settings.batchSize<1||settings.batchSize>32) throw new Error('Invalid audio settings.');
  if(typeof settings.pythonExecutable!=='string'||settings.pythonExecutable.length>4096||/[\r\n\0]/.test(settings.pythonExecutable)||(settings.pythonExecutable&&!(platform==='win32'?path.win32:path.posix).isAbsolute(settings.pythonExecutable)))throw new Error('Choose an absolute Python interpreter path.');
  if(!['proxy','gemini'].includes(settings.apiProvider))throw new Error('Choose Local proxy or Gemini API.');
  if(typeof settings.apiBaseUrl!=='string'||settings.apiBaseUrl.length>2048)throw new Error('Invalid AI API base URL.');
  let url;try{url=new URL(settings.apiBaseUrl);}catch{throw new Error('Enter a valid AI API base URL.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Use an HTTP(S) API base URL without credentials or query parameters.');
  if(url.protocol==='http:'&&!['localhost','[::1]'].includes(url.hostname)&&!/^127(?:\.\d{1,3}){3}$/.test(url.hostname))throw new Error('Use HTTPS for remote APIs. HTTP is supported for loopback proxies only.');
  if(typeof settings.apiKey!=='string'||settings.apiKey.length>4096||/[\r\n\0]/.test(settings.apiKey))throw new Error('Invalid API key.');
  for(const prefix of ['summary','answer']){
    const model=settings[prefix+'Model'];
    if(typeof model!=='string'||model.length>200||/[\r\n\0]/.test(model))throw new Error('Invalid AI model.');
  }
  const folder=settings.transcriptFolder;
  if(typeof folder!=='string'||folder.length>4096||/[\r\n\0]/.test(folder)||(folder&&!(platform==='win32'?path.win32:path.posix).isAbsolute(folder)))throw new Error('Choose an absolute transcript folder path.');
  return settings;
}
async function loadSettings(file) {
  try {return validateSettings(JSON.parse(await fs.readFile(file,'utf8')));}
  catch(error){if(error.code==='ENOENT')return {...defaults};throw error;}
}
async function saveSettings(file,settings){const value=validateSettings(settings);const {apiKey,apiProvider,apiBaseUrl,summaryModel,answerModel,...audio}=value;await atomicWrite(file,JSON.stringify(audio,null,2)+'\n');return value;}
module.exports={defaults,validateSettings,loadSettings,saveSettings};
