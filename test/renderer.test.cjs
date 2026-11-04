const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('an export error keeps recording, while an audio failure stops capture', () => {
  const elements=new Map();let stops=0;
  const element=()=>({value:'',classList:{toggle(){}},childNodes:[],replaceChildren(){},append(){},setAttribute(){}});
  const document={createElement:element,querySelectorAll:()=>[],getElementById:id => {
    if (!elements.has(id)) elements.set(id,element());
    return elements.get(id);
  }};
  const context=vm.createContext({document,stop:()=>{stops++;},state:{active:true,ready:true,error:'Export write failed',captureError:null,history:[],recovery:{count:0,legacyCount:0},settings:require('../lib/settings.cjs').defaults}});
  const source=fs.readFileSync(require.resolve('../renderer/app.js'),'utf8').split('async function act')[0];
  vm.runInContext(source+'\ncapturing=true;render(state);',context);
  assert.equal(stops,0,'Export failure interrupted recording.');
  context.state.captureError='Microphone disconnected';
  vm.runInContext('render(state);',context);assert.equal(stops,1);
});
test('summary subsections render separately and older summary text still displays intact',()=>{
 const document={createElement:tag=>({tag})};const context=vm.createContext({document});
 const source=fs.readFileSync(require.resolve('../renderer/app.js'),'utf8').split('function renderNotes')[0];vm.runInContext(source,context);
 const children=[],content={append(...values){children.push(...values);}};context.content=content;
 context.summary='Summary\nDiscussed support.\n\nKey findings\n- LTS selected.\n\nKey points\n- Release options.';
 vm.runInContext('renderSummary(content,summary)',context);
 assert.deepEqual(children.filter(child=>child.tag==='h3').map(child=>child.textContent),['Summary','Key findings','Key points']);
 assert.ok(children.some(child=>child.textContent==='- LTS selected.'));
 children.length=0;context.summary='Previously saved summary.';vm.runInContext('renderSummary(content,summary)',context);
 assert.equal(children[1].textContent,'Previously saved summary.');
});
test('notes tabs show one section and support keyboard navigation with focus',()=>{
 const elements=new Map();let focused;
 const document={getElementById:id=>{
  if(!elements.has(id))elements.set(id,{handlers:{},setAttribute(name,value){this[name]=value;},addEventListener(name,handler){this.handlers[name]=handler;},focus(){focused=this;}});
  return elements.get(id);
 }};
 const source=fs.readFileSync(require.resolve('../renderer/app.js'),'utf8'),context=vm.createContext({document});
 vm.runInContext(source.split('function renderNotes')[0]+source.slice(source.lastIndexOf('for(const tab of noteTabs){'),source.indexOf('window.meeting.onState(render)')),context);
 const names=['summary','actions','questions'];
 const check=selected=>{for(const name of names){const tab=document.getElementById('tab-'+name);assert.equal(tab['aria-selected'],String(name===selected));assert.equal(tab.tabIndex,name===selected?0:-1);assert.equal(document.getElementById('notes-'+name).hidden,name!==selected);}};
 for(const name of names){document.getElementById('tab-'+name).handlers.click();check(name);}
 focused=document.getElementById('tab-questions');
 for(const [key,name]of [['ArrowRight','summary'],['ArrowLeft','questions'],['Home','summary'],['End','questions']]){
  let prevented=false;focused.handlers.keydown({key,preventDefault(){prevented=true;}});check(name);assert.equal(focused,document.getElementById('tab-'+name));assert.equal(prevented,true);
 }
});
test('regenerating checked actions requires confirmation before replacing them',()=>{
 let handler,calls=0,confirmed=0,approve=false;
 const context=vm.createContext({$:id=>({addEventListener(_event,value){if(id==='notes-retry')handler=value;}}),act:action=>action(),current:{session:{notes:{actions:[{done:true}]},answers:[]}},window:{confirm(){confirmed++;return approve;},meeting:{notes:regenerate=>{assert.equal(regenerate,true);calls++;}}}});
 const source=fs.readFileSync(require.resolve('../renderer/app.js'),'utf8');vm.runInContext(source.split('\n').find(line=>line.includes("$('notes-retry').addEventListener")),context);
 handler();assert.equal(confirmed,1);assert.equal(calls,0);approve=true;handler();assert.equal(calls,1);
});
