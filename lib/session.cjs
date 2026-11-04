const {randomUUID} = require('node:crypto');
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = new Set(['recording', 'finishing', 'generating-notes', 'complete', 'incomplete']);
const METRICS = ['inferenceMs','p95InferenceMs','p95LatencyMs','pendingSeconds','pendingBytes','rtf','processedChunks'];

function newSession() {
  return {id: randomUUID(), startedAt: new Date().toISOString(), endedAt: null,
    status: 'recording', transcript: [], notes: null, answers: []};
}

function isoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validEvidence(value) {
  return Array.isArray(value) && value.every(time => Number.isFinite(time) && time >= 0);
}

function validateSession(session) {
  if (!session || typeof session.id !== 'string' || !SESSION_ID.test(session.id)) {
    throw new TypeError('Invalid session ID');
  }
  if (!isoTime(session.startedAt) ||
      (session.transcriptRevision !== undefined && (!Number.isSafeInteger(session.transcriptRevision) || session.transcriptRevision < 0)) ||
      (session.notesEdited !== undefined && typeof session.notesEdited !== 'boolean') ||
      (session.interruption !== undefined && (typeof session.interruption !== 'string' || session.interruption.length > 4096)) ||
      (session.endedAt !== null && (!isoTime(session.endedAt) || Date.parse(session.endedAt) < Date.parse(session.startedAt))) ||
      !STATUSES.has(session.status) || !Array.isArray(session.answers) ||
      (session.processedChunks !== undefined && (!Array.isArray(session.processedChunks) ||
        session.processedChunks.some(id => typeof id !== 'string' || !SESSION_ID.test(id)) ||
        new Set(session.processedChunks).size !== session.processedChunks.length)) ||
      (session.incompleteReason !== undefined && (typeof session.incompleteReason !== 'string' || session.incompleteReason.length > 4096)) ||
      (session.metrics !== undefined && (!session.metrics || METRICS.some(key =>
        !Number.isFinite(session.metrics[key]) || session.metrics[key] < 0) ||
        !Number.isInteger(session.metrics.pendingBytes) || !Number.isInteger(session.metrics.processedChunks))) ||
      (session.notes !== null && (!session.notes || typeof session.notes.summary !== 'string' ||
        !Array.isArray(session.notes.actions) || !Array.isArray(session.notes.questions) ||
        session.notes.actions.some(action => !action || typeof action.task !== 'string' ||
          (action.done !== undefined && typeof action.done !== 'boolean') ||
          (action.owner !== null && typeof action.owner !== 'string') ||
          (action.due !== null && typeof action.due !== 'string') || !validEvidence(action.evidence)) ||
        session.notes.questions.some(question => !question || typeof question.id !== 'string' ||
          typeof question.question !== 'string' || !validEvidence(question.evidence)))) ||
      session.answers.some(answer => !answer || typeof answer.questionId !== 'string' ||
        typeof answer.status !== 'string' || typeof answer.answer !== 'string' ||
        !Array.isArray(answer.sources) || answer.sources.some(source => !source ||
          typeof source.title !== 'string' || typeof source.url !== 'string') ||
        !Array.isArray(answer.gaps) || answer.gaps.some(gap => typeof gap !== 'string'))) {
    throw new TypeError('Invalid session data');
  }
  if (!Array.isArray(session.transcript) || session.transcript.some(segment => !segment ||
      !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
      segment.start < 0 || segment.end < segment.start || typeof segment.text !== 'string')) {
    throw new TypeError('Invalid session transcript');
  }
}

async function atomicWrite(destination, data) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  await fs.mkdir(path.dirname(destination), {recursive: true});
  let file;
  try {
    file = await fs.open(temporary, 'wx');
    await file.writeFile(data, {encoding: 'utf8'});
    await file.sync();
    await file.close();file = null;
    await fs.rename(temporary, destination);
  } catch (error) {
    await file?.close().catch(() => {});
    await fs.rm(temporary, {force: true}).catch(() => {});
    throw error;
  }
}

const sessionWrites=new Map();
function serializeSession(root,session,write) {
  validateSession(session);
  const key=path.resolve(root,session.id+'.json');
  const previous=sessionWrites.get(key)||Promise.resolve();
  const pending=previous.catch(()=>{}).then(write).finally(()=>{if(sessionWrites.get(key)===pending)sessionWrites.delete(key);});
  sessionWrites.set(key,pending);return pending;
}
async function writeSession(root, session) {
  validateSession(session);
  await atomicWrite(path.join(root, `${session.id}.json`), JSON.stringify(session, null, 2) + '\n');
}
async function saveSession(root,session) {
  return serializeSession(root,session,()=>writeSession(root,session));
}

async function readRegular(destination, limit) {
  let file;
  try {
    file=await fs.open(destination,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat=await file.stat();const link=await fs.lstat(destination);
    if(!stat.isFile() || !link.isFile() || link.isSymbolicLink() || stat.dev!==link.dev || stat.ino!==link.ino) {
      throw new TypeError('Stored data must be a regular file, not a symlink');
    }
    if(stat.size>limit) throw new TypeError('Stored data is too large');
    const data=Buffer.alloc(stat.size+1);let size=0;
    while(size<data.length) {
      const {bytesRead}=await file.read(data,size,data.length-size,null);
      if(!bytesRead) break;
      size+=bytesRead;
    }
    if(size>stat.size) throw new TypeError('Stored data changed while reading');
    return data.subarray(0,size);
  } catch(error) {
    if(error.code==='ELOOP') throw new TypeError('Stored data must be a regular file, not a symlink');
    throw error;
  } finally {await file?.close();}
}

async function loadSession(root, id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new TypeError('Invalid session ID');
  const data=await readRegular(path.join(root,id+'.json'),32*1024*1024);
  const session=JSON.parse(data.toString('utf8'));validateSession(session);
  if (session.id !== id) throw new TypeError('Session ID does not match its filename');
  return session;
}

async function storedSessions(root) {
  let entries;
  try {
    entries = await fs.readdir(root, {withFileTypes: true});
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const sessions=[];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || !SESSION_ID.test(entry.name.slice(0, -5))) continue;
    try {
      sessions.push(await loadSession(root,entry.name.slice(0,-5)));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError || error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return sessions.sort((a,b) => Date.parse(b.startedAt)-Date.parse(a.startedAt) || a.id.localeCompare(b.id));
}

async function loadLatestSession(root) {
  return (await storedSessions(root))[0] ?? null;
}

async function listSessions(root) {
  return (await storedSessions(root)).map(session => ({id:session.id,startedAt:session.startedAt,
    endedAt:session.endedAt,status:session.status,summary:session.notes?.summary ?? '',segments:session.transcript.length}));
}

function timestamp(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const remainingSeconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

function evidence(times) {
  return `Evidence: ${times.map(timestamp).join(', ') || 'Not specified'}`;
}

function exportSession(session, format) {
  if (format !== 'txt' && format !== 'md') throw new TypeError('Unsupported export format');
  validateSession(session);
  const {notes} = session;
  const sections = [
    ['Metadata', [`Session: ${session.id}`, `Started: ${session.startedAt}`,
      `Ended: ${session.endedAt ?? 'Not ended'}`, `Status: ${session.status}`,
      ...(session.incompleteReason ? [`Incomplete reason: ${session.incompleteReason}`] : [])]],
    ['Transcript', session.transcript.length ? session.transcript.map(segment =>
      `[${timestamp(segment.start)} - ${timestamp(segment.end)}] ${segment.text}`) : ['No transcript recorded.']],
    ['Summary', [notes ? notes.summary : 'Not generated.']],
    ['Actions', !notes ? ['Not generated.'] : notes.actions.length ? notes.actions.flatMap(action => [
      `${action.done?'[x]':'[ ]'} ${action.task}`, `Owner: ${action.owner ?? 'Not specified'}`, `Due: ${action.due ?? 'Not specified'}`,
      evidence(action.evidence), '']) : ['None.']],
    ['Open questions', !notes ? ['Not generated.'] : notes.questions.length ? notes.questions.flatMap(question => [
      `${question.id}: ${question.question}`, evidence(question.evidence),
      `Status: ${session.answers.find(answer => answer.questionId === question.id)?.status ?? 'Unanswered'}`, '']) : ['None.']],
    ['Researched answers and sources', session.answers.length ? session.answers.flatMap(answer => [
      `Question: ${answer.questionId}`, `Status: ${answer.status}`, answer.answer,
      'Sources:', ...(!answer.sources.length ? ['None.'] : answer.sources.map(source => `${source.title}: ${source.url}`)),
      `Gaps: ${answer.gaps.join('; ') || 'None.'}`, '']) : ['Not researched.']]
  ];
  const lines = [format === 'md' ? '# Meeting notes' : 'Meeting notes', ''];
  for (const [heading, content] of sections) {
    lines.push(format === 'md' ? `## ${heading}` : heading, ...content, '');
  }
  const text = lines.join('\n').replace(/\r\n?/g, '\n');
  return format === 'txt' ? text.replaceAll('\n', '\r\n') : text;
}

async function commitSession(root, session, changes) {
  return serializeSession(root,session,async()=>{
    await writeSession(root,{...session,...changes});
    Object.assign(session,changes);
  });
}

module.exports = {newSession, saveSession, commitSession, loadLatestSession, loadSession, listSessions,
  atomicWrite, exportSession, validateSession, SESSION_ID, readRegular};
