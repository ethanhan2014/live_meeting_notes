const {commitSession}=require('./session.cjs');
function text(value,max=8000){if(typeof value!=='string'||value.length>max)throw new Error('Invalid edited text.');return value.trim();}
async function editTranscript(root,session,index,value){
  if(!session || !Number.isInteger(index)||index<0||index>=session.transcript.length)throw new Error('Invalid transcript segment.');
  const corrected=text(value);if(!corrected)throw new Error('A transcript segment cannot be empty.');
  if(session.transcript[index].text===corrected)return;
  const transcript=session.transcript.map((segment,i)=>i===index?{...segment,text:corrected}:segment);
  await commitSession(root,session,{transcript,notes:null,answers:[],transcriptRevision:(session.transcriptRevision||0)+1});
}
async function editNotes(root,session,value){
  const original=session?.notes;
  if(!original||!value||!Array.isArray(value.actions)||!Array.isArray(value.questions)||value.actions.length!==original.actions.length||value.questions.length!==original.questions.length)throw new Error('Invalid edited notes.');
  const notes={summary:text(value.summary),actions:value.actions.map((action,index)=>({
    ...original.actions[index],task:text(action.task),owner:action.owner===null?null:text(action.owner,200)||null,due:action.due===null?null:text(action.due,200)||null
  })),questions:value.questions.map((question,index)=>{
    if(question.id!==original.questions[index].id)throw new Error('Invalid edited question.');
    return {...original.questions[index],question:text(question.question)};
  })};
  const unchanged=new Set(notes.questions.filter((question,index)=>question.question===original.questions[index].question).map(question=>question.id));
  await commitSession(root,session,{notes,answers:session.answers.filter(answer=>unchanged.has(answer.questionId)),notesEdited:true});
}
async function setActionDone(root,session,index,done){
  if(!session?.notes||!Number.isInteger(index)||index<0||index>=session.notes.actions.length||typeof done!=='boolean')throw new Error('Invalid action item.');
  const actions=session.notes.actions.map((action,i)=>i===index?{...action,done}:action);
  await commitSession(root,session,{notes:{...session.notes,actions}});
}
module.exports={editTranscript,editNotes,setActionDone};
