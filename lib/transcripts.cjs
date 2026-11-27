const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {newSession,atomicWrite,exportSession,readRegular,loadSession,SESSION_ID}=require('./session.cjs');
const written=new Map();

async function listTranscripts(folder){
  try{return (await fs.readdir(folder,{withFileTypes:true})).filter(file=>file.isFile()&&/\.txt$/i.test(file.name)).map(file=>file.name).sort().reverse();}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
}
async function saveTranscript(folder,session,format='txt'){
  const name='Meeting '+session.startedAt.slice(0,19).replace(/[:T]/g,'-')+' '+session.id+'.'+format;
  const file=path.join(folder,name),contents=exportSession(session,format),hash=value=>createHash('sha256').update(value).digest('hex');
  let previous;try{previous=await readRegular(file,20*1024*1024);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(previous&&hash(previous)!==hash(contents)&&written.get(file)!==hash(previous)){
    await atomicWrite(path.join(folder,name.slice(0,-format.length-1)+' edited-'+randomUUID()+'.'+format),previous);
  }
  if(!previous||hash(previous)!==hash(contents))await atomicWrite(file,contents);
  written.set(file,hash(contents));return name;
}
function parseTranscript(value){
  const text=value.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim();
  if(!text||text.includes('\0')||Buffer.byteLength(text)>10*1024*1024)throw new Error('Choose a nonempty TXT transcript smaller than 10 MB.');
  const exported=/^Meeting notes\n\nMetadata\nSession: [0-9a-f-]{36}\n/.test(text);
  const body=exported?(text.match(/(?:^|\n)Transcript\n([\s\S]*?)\nSummary\n/)?.[1]??text):text;
  if(body.trim()==='No transcript recorded.')throw new Error('This file has no transcript.');
  const seconds=value=>{const [h,m,s]=value.split(':').map(Number);if(m>=60||s>=60)throw new Error('Invalid transcript timestamp.');return h*3600+m*60+s;};
  const transcript=[];let stamped=false;
  for(const line of body.split('\n')){
    if(!line.trim())continue;
    const match=line.match(/^\[(\d{2,}:\d{2}:\d{2}(?:\.\d+)?) - (\d{2,}:\d{2}:\d{2}(?:\.\d+)?)\] (.*)$/);
    if(match){const start=seconds(match[1]),end=seconds(match[2]);if(end<start||!match[3].trim())throw new Error('Invalid transcript segment.');transcript.push({start,end,text:match[3]});stamped=true;}
    else if(stamped)transcript.at(-1).text+='\n'+line;
    else transcript.push({start:0,end:0,text:line});
  }
  if(!transcript.length)throw new Error('This file has no transcript.');
  // shortcut: plain TXT has no timing metadata, its passages share timestamp zero until a timed transcript is supplied.
  const session=newSession();session.endedAt=session.startedAt;session.status='complete';session.transcript=transcript;return session;
}
async function readTranscript(file,root){
  const text=(await readRegular(file,10*1024*1024)).toString('utf8');
  const id=path.basename(file).match(/([0-9a-f-]{36})\.txt$/i)?.[1];
  if(id&&SESSION_ID.test(id)&&text.includes(`Session: ${id}`)){
    try{const saved=await loadSession(root,id);if(exportSession(saved,'txt').replace(/\r\n/g,'\n')===text.replace(/\r\n/g,'\n'))return saved;}
    catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError)&&!(error instanceof TypeError))throw error;}
  }
  return parseTranscript(text);
}
module.exports={listTranscripts,saveTranscript,parseTranscript,readTranscript};
