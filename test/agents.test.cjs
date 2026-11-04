const {test}=require('node:test');
const assert=require('node:assert/strict');
const {commandOptions,parseAgentEvents}=require('../lib/agents.cjs');
const {buildArguments,validateAnswer}=require('../lib/codex.cjs');
const answer={status:'answered',answer:'Use the published calendar.',sources:[{title:'Calendar',url:'https://example.com/calendar'}],gaps:[]};

test('summary and answer model overrides use their respective choices',()=>{
  const config={mcp_servers:{'perplexity-litellm':{}}};
  const args=buildArguments(config,'research','answer.json',{model:'answer-model',effort:'high'});
  assert.ok(args.includes('model="answer-model"'));assert.ok(args.includes('model_reasoning_effort="high"'));
  const claude=commandOptions('claude','notes',{model:'sonnet',effort:'medium'},{});
  assert.equal(claude.args[claude.args.indexOf('--tools')+1],'');assert.ok(claude.args.includes('sonnet'));assert.ok(claude.args.includes('medium'));assert.ok(claude.args.includes('--strict-mcp-config'));
  const gemini=commandOptions('gemini','notes',{model:'gemini-2.5-pro',effort:'medium'},{});
  assert.deepEqual(gemini.config.tools.core,[]);assert.equal(gemini.config.modelConfigs.customOverrides[0].modelConfig.generateContentConfig.thinkingConfig.thinkingBudget,4096);
  assert.equal(gemini.config.skills.enabled,false);assert.equal(gemini.config.experimental.enableAgents,false);
  const open=commandOptions('opencode','research',{model:'provider/model',effort:'high'},{});
  assert.ok(open.args.includes('--variant'));assert.ok(open.args.includes('provider/model'));assert.equal(open.config.permission['*'],'deny');assert.equal(open.config.permission.websearch,'allow');
  assert.ok(open.args.includes('--agent'));assert.equal(open.config.agent['meeting-notes'].permission['*'],'deny');
});
test('Claude sources must come from a completed search, and failed final responses are rejected',()=>{
  const events=[{type:'assistant',message:{content:[{type:'tool_use',id:'search-1',name:'WebSearch',input:{}}]}},
    {type:'user',message:{content:[{type:'tool_result',tool_use_id:'search-1',content:'[{"url":"https://example.com/calendar"}]'}]}},
    {type:'result',subtype:'success',structured_output:answer}];
  assert.equal(validateAnswer(parseAgentEvents('claude',events).value,parseAgentEvents('claude',events).sources).status,'answered');
  assert.throws(()=>validateAnswer(answer,parseAgentEvents('claude',events.slice(2)).sources),/not returned/);
  assert.throws(()=>parseAgentEvents('claude',[{type:'result',subtype:'error_max_turns',result:JSON.stringify(answer)}]),/complete/);
});
test('Gemini discards pre-search text and accepts only successful search output as evidence',()=>{
  const events=[{type:'message',role:'assistant',delta:true,content:'Searching the web.'},{type:'tool_use',tool_id:'t1',tool_name:'google_web_search'},
    {type:'tool_result',tool_id:'t1',status:'success',output:'Calendar: https://example.com/calendar'},
    {type:'message',role:'assistant',delta:true,content:JSON.stringify(answer).slice(0,30)},
    {type:'message',role:'assistant',delta:true,content:JSON.stringify(answer).slice(30)},{type:'result',status:'success'}];
  const result=parseAgentEvents('gemini',events);assert.equal(validateAnswer(result.value,result.sources).status,'answered');
  events[2].status='error';events[2].error={message:'Search unavailable'};const failed=parseAgentEvents('gemini',events);assert.equal(failed.sources.size,0);
});
test('OpenCode requires a completed turn and takes citations only from search tool output',()=>{
  const events=[{type:'tool_use',part:{tool:'websearch',state:{status:'completed',output:'https://example.com/calendar'}}},
    {type:'text',part:{text:'```json\n'+JSON.stringify(answer)+'\n```'}},{type:'step_finish',part:{reason:'stop'}}];
  const result=parseAgentEvents('opencode',events);assert.equal(validateAnswer(result.value,result.sources).status,'answered');
  assert.throws(()=>parseAgentEvents('opencode',events.slice(0,-1)),/completed/);
});
