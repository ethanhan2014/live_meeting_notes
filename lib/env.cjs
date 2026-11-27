const fs=require('node:fs/promises');
const {atomicWrite}=require('./session.cjs');
const keys={AI_PROVIDER:'apiProvider',AI_BASE_URL:'apiBaseUrl',AI_API_KEY:'apiKey',AI_SUMMARY_MODEL:'summaryModel',AI_ANSWER_MODEL:'answerModel'};
async function loadApiEnv(file){
  let source;try{source=await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return {};throw error;}
  const config={};
  for(const line of source.split(/\r?\n/)){
    const match=line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);if(!match||!keys[match[1]])continue;
    let value=match[2];
    if(value.startsWith('"')){try{value=JSON.parse(value);}catch{throw new Error('Invalid quoted value in the AI .env file.');}}
    else if(value.startsWith("'")){if(!value.endsWith("'"))throw new Error('Invalid quoted value in the AI .env file.');value=value.slice(1,-1);}
    else value=value.split(/\s+#/)[0].trim();
    if(typeof value!=='string')throw new Error('AI .env values must be strings.');config[keys[match[1]]]=value;
  }
  return config;
}
async function saveApiEnv(file,config){
  let source='';try{source=await fs.readFile(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  const preserved=source.split(/\r?\n/).filter(line=>{const match=line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=/);return line.trim()&&!(match&&keys[match[1]]);});
  const lines=Object.entries(keys).map(([key,field])=>key+'='+JSON.stringify(config[field]||''));
  await atomicWrite(file,[...preserved,...lines].join('\n')+'\n',0o600);
}
async function loadApiConfig(file,defaultsFile){
  try{await fs.access(file);return await loadApiEnv(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  const config=await loadApiEnv(defaultsFile);
  if(Object.keys(config).length)await saveApiEnv(file,config);
  return config;
}
module.exports={loadApiEnv,saveApiEnv,loadApiConfig};
