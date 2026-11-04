const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn,execFile}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {CodexJobs,buildPrompt,parseJsonl,safeError,sourceUrl}=require('./codex.cjs');

const providers=[['codex','Codex','@openai/codex'],['claude','Claude Code','@anthropic-ai/claude-code'],['opencode','OpenCode','opencode-ai'],['gemini','Gemini CLI','@google/gemini-cli']];
async function where(name){
  if(process.platform!=='win32')return [];
  return new Promise(resolve=>execFile('where.exe',[name],{windowsHide:true,timeout:5000,maxBuffer:16000},(error,stdout)=>resolve(error?[]:stdout.trim().split(/\r?\n/))));
}
async function exists(file){try{await fs.access(file);return true;}catch{return false;}}
async function detectAgents(codexExecutable=''){
  const node=(await where('node.exe'))[0];
  return Promise.all(providers.map(async([id,label,pkg])=>{
    try{
      if(id==='codex'){const job=new CodexJobs('');job.executable=codexExecutable;return {id,label,available:true,command:await job.resolveExecutable(),prefix:[]};}
      const natives=[...await where(id+'.exe'),path.join(process.env.USERPROFILE||'','.local','bin',id+'.exe'),path.join(process.env.USERPROFILE||'','.'+id,'bin',id+'.exe')];
      for(const command of natives)if(await exists(command))return {id,label,available:true,command,prefix:[]};
      const roots=new Set([path.join(process.env.APPDATA||'','npm'),...(await where(id+'.cmd')).map(file=>path.dirname(file))]);
      for(const root of roots){
        const directory=path.join(root,'node_modules',pkg);let metadata;
        try{metadata=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));}catch{continue;}
        const bin=typeof metadata.bin==='string'?metadata.bin:metadata.bin?.[id];
        if(bin&&await exists(path.join(directory,bin))){const file=path.join(directory,bin);if(/\.exe$/i.test(file))return {id,label,available:true,command:file,prefix:[]};if(node)return {id,label,available:true,command:node,prefix:[file]};}
      }
      throw new Error(`${label} was not found. Install it and sign in using its CLI, then rescan.`);
    }catch(error){return {id,label,available:false,error:safeError(error.message)};}
  }));
}
function commandOptions(agent,kind,choice,schema){
  const search=kind==='research',args=[],config={};
  if(agent==='claude'){
    args.push('--print','--output-format','stream-json','--verbose','--no-session-persistence','--disable-slash-commands',
      '--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','user','--settings','{"disableAllHooks":true}',
      '--tools',search?'WebSearch,WebFetch':'','--json-schema',JSON.stringify(schema));
    if(search)args.push('--allowedTools','WebSearch,WebFetch');
    if(choice.model)args.push('--model',choice.model);if(choice.effort)args.push('--effort',choice.effort);
  }else if(agent==='gemini'){
    args.push('--prompt','Return only the requested JSON response.','--output-format','stream-json','--approval-mode','default',
      '--allowed-mcp-server-names','__meeting_no_mcp__','--extensions','__meeting_no_extensions__','--allowed-tools',...(search?['google_web_search','web_fetch']:['__meeting_no_tools__']));
    if(choice.model)args.push('--model',choice.model);
    Object.assign(config,{tools:{core:search?['google_web_search','web_fetch']:[],allowed:search?['google_web_search','web_fetch']:[]},skills:{enabled:false},experimental:{enableAgents:false},hooksConfig:{enabled:false},context:{fileName:'MEETING_NO_CONTEXT.md'},telemetry:{enabled:false}});
    if(choice.effort)config.modelConfigs={customOverrides:[{match:{model:choice.model||'chat-base'},modelConfig:{generateContentConfig:{thinkingConfig:{thinkingBudget:{low:1024,medium:4096,high:8192}[choice.effort]}}}}]};
  }else if(agent==='opencode'){
    args.push('run','--format','json','--agent','meeting-notes');if(choice.model)args.push('--model',choice.model);if(choice.effort)args.push('--variant',choice.effort);
    const permission={'*':'deny',websearch:search?'allow':'deny',webfetch:search?'allow':'deny'};
    Object.assign(config,{plugin:[],permission,agent:{'meeting-notes':{mode:'primary',description:'Summarize transcripts and answer meeting questions.',permission}}});
  }else throw new Error('Unsupported AI agent.');
  return {args,config};
}
function parseAgentEvents(agent,events){
  const sources=new Set(),tools=new Map();let final='',value,completed=false;
  const addSources=output=>{for(const match of JSON.stringify(output).matchAll(/https?:\/\/[^\s"<>\\]+/g)){try{sources.add(sourceUrl(match[0].replace(/[),.;\]]+$/,'')));}catch{}}};
  for(const event of events){
    if(event.type==='error'||(event.type==='result'&&(event.is_error||event.status==='error')))throw new Error(safeError(event.error?.message||event.error||event.message||event.result||event.errors?.join(' ')||'AI job failed.'));
    if(agent==='claude'){
      for(const part of event.message?.content||[]){
        if(part.type==='tool_use')tools.set(part.id,{name:part.name,input:part.input});
        if(part.type==='tool_result'&&!part.is_error){const tool=tools.get(part.tool_use_id);if(tool?.name==='WebSearch')addSources(part.content);if(tool?.name==='WebFetch'){try{sources.add(sourceUrl(tool.input.url));}catch{}}}
      }
      if(event.type==='result'){if(event.subtype!=='success')throw new Error('Claude Code did not complete the requested response.');completed=true;value=event.structured_output;final=event.result||'';}
    }else if(agent==='gemini'){
      if(event.type==='message'&&event.role==='assistant')final=event.delta?final+(event.content||''):(event.content||'');
      if(event.type==='tool_use')tools.set(event.tool_id,{name:event.tool_name,input:event.parameters});
      if(event.type==='tool_result'){final='';if(event.status==='success'){const tool=tools.get(event.tool_id);if(tool?.name==='google_web_search')addSources(event.output);if(tool?.name==='web_fetch')addSources(event.output);}}
      if(event.type==='result'){if(event.status!=='success')throw new Error('Gemini CLI did not complete the requested response.');completed=true;}
    }else{
      if(event.type==='text')final=event.part?.text||'';
      if(event.type==='tool_use'&&event.part?.state?.status==='completed'&&['websearch','webfetch'].includes(event.part.tool))addSources(event.part.state.output);
      if(event.type==='step_finish'&&event.part?.reason==='stop')completed=true;
    }
  }
  if(!completed)throw new Error('The AI agent did not produce a completed response.');
  if(value===undefined){try{value=JSON.parse(final.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{throw new Error('The AI agent did not return the requested JSON.');}}
  return {value,sources};
}
class AgentJobs extends CodexJobs{
  constructor(root,schemas,settings){super(root,schemas);this.settings=settings;}
  async run(kind,instructions,context){
    if(this.cancelled)throw new Error('AI job cancelled.');
    const prefix=kind==='notes'?'summary':'answer',choice={model:this.settings[prefix+'Model'],effort:this.settings[prefix+'Effort']},agent=this.settings[prefix+'Agent'];
    if(agent==='codex'){this.modelChoice=choice;this.executable=this.settings.codexExecutable;return super.run(kind,instructions,context);}
    const detected=(await detectAgents()).find(value=>value.id===agent);
    if(!detected?.available)throw new Error(detected?.error||'AI agent not found.');
    const schema=JSON.parse(await fs.readFile(path.join(this.schemaRoot,kind==='notes'?'notes.json':'answer.json'),'utf8'));
    const {args,config}=commandOptions(agent,kind,choice,schema),directory=path.join(this.jobRoot,randomUUID());
    await fs.mkdir(directory,{recursive:true});
    const env={...process.env};
    if(agent==='gemini'){await fs.mkdir(path.join(directory,'.gemini'));await fs.writeFile(path.join(directory,'.gemini','settings.json'),JSON.stringify(config));}
    if(agent==='opencode'){env.OPENCODE_CONFIG_CONTENT=JSON.stringify(config);env.OPENCODE_DISABLE_AUTOUPDATE='true';if(kind==='research')env.OPENCODE_ENABLE_EXA='true';}
    if(kind==='research')instructions=instructions.replace('the available web_search tool from perplexity-litellm','your available web search tool');
    const prompt=buildPrompt(instructions+'\nReturn only JSON matching this schema: '+JSON.stringify(schema),context);
    try{
      if(this.cancelled)throw new Error('AI job cancelled.');
      const events=await new Promise((resolve,reject)=>{
        const child=spawn(detected.command,[...detected.prefix,...args],{cwd:directory,env,windowsHide:true});this.child=child;
        child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
        let stdout='',diagnostic='',failure;const timer=setTimeout(()=>{failure=new Error('AI job exceeded ten minutes.');this.cancel();},600000);
        child.stdout.on('data',data=>{stdout+=data;if(Buffer.byteLength(stdout)>16*1024*1024){failure=new Error('AI output exceeded the app limit.');this.cancel();}});
        child.stderr.on('data',data=>{diagnostic=(diagnostic+data).slice(-4000);});child.on('error',error=>{failure=error;});
        child.stdin.on('error',error=>{failure??=new Error('Could not send context to the AI agent: '+error.code);});
        child.on('close',code=>{clearTimeout(timer);if(this.child===child)this.child=null;try{
          if(failure)throw failure;if(this.cancelled)throw new Error('AI job cancelled.');
          let events;try{events=parseJsonl([stdout]);}catch{throw new Error(`${detected.label} returned invalid JSON. ${safeError(diagnostic)}`);}
          if(code!==0){if(events.length)parseAgentEvents(agent,events);const detail=diagnostic.split(/\r?\n/).find(line=>/^Error\b/i.test(line))||diagnostic;throw new Error(`${detected.label} exited with code ${code}. ${safeError(detail)}`);}
          resolve(events);
        }catch(error){reject(error);}});
        child.stdin.end(prompt);
      });
      return parseAgentEvents(agent,events);
    }finally{await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
  }
  async testConnection(){
    const agent=(await detectAgents(this.settings.codexExecutable)).find(value=>value.id===this.settings.summaryAgent);
    if(!agent?.available)throw new Error(agent?.error||'AI agent not found.');
    const version=agent.label,session={transcript:[{start:0,end:10,text:'Alex will check the supported Node.js release. What is Node.js used for?'}]};
    try{await this.notes(session);}catch(error){if(this.cancelled)throw error;return {version,notesOk:false,searchOk:false,details:safeError(error.message)};}
    try{const answer=await this.research(session,{id:'diagnostic',question:'What is Node.js used for? Cite its official documentation.',evidence:[0]});return {version,notesOk:true,searchOk:answer.status==='answered',details:answer.status==='answered'?'Summary and answer agents responded with validated sources.':safeError(answer.gaps.join(' '))};}
    catch(error){if(this.cancelled)throw error;return {version,notesOk:true,searchOk:false,details:safeError(error.message)};}
  }
}
module.exports={AgentJobs,detectAgents,commandOptions,parseAgentEvents};
