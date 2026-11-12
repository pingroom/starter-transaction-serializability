import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const POLICY = Object.freeze({ model: 'complete-single-version-object-access-trace-v1', conflicts: 'ordered-cross-transaction-same-object-one-write-v1', order: 'input-event-order-ascii-transaction-ties-v1', witness: 'sorted-dfs-first-simple-cycle-first-event-pair-v1' });
export const POLICY_HASH = hash(POLICY);
export const CHOICES = Object.freeze(['ReadOnly', 'Writes', 'NoAccess', 'Unknown']);
const safeId = value => word(value) && value.length <= 16 && !['constructor', 'prototype', '__proto__'].includes(value);
const byId = (a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function validateInput(input) {
  if (!keys(input, ['traceId','title','purpose','transactions','objects','events']) || !word(input.traceId) || !line(input.title,40) || !line(input.purpose,60)
    || !Array.isArray(input.transactions) || input.transactions.length < 1 || input.transactions.length > 4
    || !Array.isArray(input.objects) || input.objects.length < 1 || input.objects.length > 4
    || !Array.isArray(input.events) || input.events.length < 1 || input.events.length > 8) throw new Error('Provide a trace ID, title, purpose, one to four transactions and objects, and one to eight ordered events.');
  const registry = list => {
    const ids = new Set();
    for (const item of list) {
      if (!keys(item,['id','label']) || !safeId(item.id) || !line(item.label,24) || ids.has(item.id)) throw new Error('Transactions and objects need unique safe IDs and labels.');
      ids.add(item.id);
    }
    return ids;
  };
  const transactions = registry(input.transactions), objects = registry(input.objects), events = new Set(), usedTransactions = new Set(), usedObjects = new Set();
  for (const event of input.events) {
    if (!keys(event,['id','transactionId','objectId','description']) || !safeId(event.id) || events.has(event.id) || !transactions.has(event.transactionId)
      || !objects.has(event.objectId) || !line(event.description,60)) throw new Error('Each event needs a unique safe ID, known transaction/object IDs and a description.');
    events.add(event.id); usedTransactions.add(event.transactionId); usedObjects.add(event.objectId);
  }
  if (usedTransactions.size !== transactions.size || usedObjects.size !== objects.size) throw new Error('Every declared transaction and object must occur in the trace.');
  const result = structuredClone(input); result.transactions.sort(byId); result.objects.sort(byId); return result;
}
export function validateConfig(config) {
  if (!keys(config,['participant']) || !keys(config.participant,['id','label']) || !isId(config.participant.id) || !line(config.participant.label,60)) throw new Error('Config requires an exact trace owner UUID and label.');
  return structuredClone(config);
}
export function tasksFor(rawInput) { return validateInput(rawInput).events; }
export function parseChoice(value) {
  if (value === 'Unknown') return { kind: 'unknown', choice: null };
  if (CHOICES.includes(value)) return { kind: 'known', choice: value };
  throw new Error('Choose one of the displayed access classifications.');
}
export function requestFor(rawInput,config,taskId,attemptId) {
  const input = validateInput(rawInput); validateConfig(config);
  const index = input.events.findIndex(event => event.id === taskId), event = input.events[index];
  if (!event || !isId(attemptId)) throw new Error('Invalid event or attempt.');
  const tx = input.transactions.find(tx => tx.id === event.transactionId), object = input.objects.find(object => object.id === event.objectId);
  const prompt = `${input.title}\nTrace: ${input.traceId}\nPurpose: ${input.purpose}\nEvent ${index+1}/${input.events.length}: ${event.id} — ${event.description}\nTransaction: ${tx.id} (${tx.label})\nObject: ${object.id} (${object.label})\nReadOnly = read without write; Writes = any write, including read-modify-write; NoAccess = neither; Unknown = unclear.`;
  if (prompt.length > 500) throw new Error('Event prompt exceeds 500 characters.');
  const key = `serial-${attemptId}`;
  return { prompt, context: `To ${config.participant.id}`, options: CHOICES.map(value => ({value,label:value,style:'default'})), responder_scope:'direct', target_user_id:config.participant.id,
    ttl:TTL, correlation_id:key, data:{input_hash:hash(input),policy_hash:POLICY_HASH,task_id:taskId,attempt_id:attemptId}, idempotencyKey:key };
}

/** Analyze declared operations; this does not connect to or execute a database. */
export function analyzeTrace(rawInput,accesses) {
  const input = validateInput(rawInput);
  if (!keys(accesses,input.events.map(event => event.id)) || input.events.some(event => !CHOICES.slice(0,3).includes(accesses[event.id]))) throw new Error('Every event needs a known access classification.');
  const edgeMap = new Map();
  for (let earlier = 0; earlier < input.events.length; earlier++) for (let later = earlier + 1; later < input.events.length; later++) {
    const a = input.events[earlier], b = input.events[later], ac = accesses[a.id], bc = accesses[b.id];
    if (a.transactionId === b.transactionId || a.objectId !== b.objectId || ac === 'NoAccess' || bc === 'NoAccess' || ac !== 'Writes' && bc !== 'Writes') continue;
    const key = JSON.stringify([a.transactionId,b.transactionId]);
    if (!edgeMap.has(key)) edgeMap.set(key,{from:a.transactionId,to:b.transactionId,witnesses:[]});
    edgeMap.get(key).witnesses.push({earlierEventId:a.id,laterEventId:b.id,earlierIndex:earlier,laterIndex:later,objectId:a.objectId,earlierAccess:ac,laterAccess:bc});
  }
  const ids = input.transactions.map(tx => tx.id), edges = [...edgeMap.values()].sort((a,b) => a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0);
  const outgoing = new Map(ids.map(id => [id,edges.filter(edge => edge.from === id)]));
  const indegree = new Map(ids.map(id => [id,edges.filter(edge => edge.to === id).length])), order = [];
  const ready = ids.filter(id => indegree.get(id) === 0);
  while (ready.length) {
    ready.sort(); const id = ready.shift(); order.push(id);
    for (const edge of outgoing.get(id)) { indegree.set(edge.to,indegree.get(edge.to)-1); if(indegree.get(edge.to) === 0) ready.push(edge.to); }
  }
  let cycle = null;
  if (order.length !== ids.length) {
    const colors = new Map(), stack = [];
    const visit = id => {
      colors.set(id,1); stack.push(id);
      for (const edge of outgoing.get(id)) {
        if (colors.get(edge.to) === 1) {
          const transactionIds = [...stack.slice(stack.indexOf(edge.to)),edge.to];
          cycle = {transactionIds,edges:transactionIds.slice(0,-1).map((from,index) => {
            const to = transactionIds[index+1], match = edgeMap.get(JSON.stringify([from,to]));
            return {from,to,witness:match.witnesses[0]};
          })}; return true;
        }
        if (!colors.has(edge.to) && visit(edge.to)) return true;
      }
      stack.pop(); colors.set(id,2); return false;
    };
    for (const id of ids) if (!colors.has(id) && visit(id)) break;
    if (cycle === null) throw new Error('Cycle witness invariant failed.');
  }
  const serializable = cycle === null;
  return { conflictSerializable:serializable, transactionIds:ids, eventAccesses:input.events.map((event,index) => ({eventId:event.id,index,access:accesses[event.id]})),
    edges, serialOrder:serializable ? order : null,
    serialEventOrder:serializable ? order.flatMap(id => input.events.filter(event => event.transactionId === id).map(event => event.id)) : null, cycle };
}
export function serializability(rawInput,answers) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!Array.isArray(answers) || answers.length !== tasks.length || Array.from(answers).some((row,index) => !keys(row,['taskId','value']) || row.taskId !== tasks[index].id
    || row.value !== null && !CHOICES.includes(row.value))) throw new Error('Provide an ordered displayed answer or missing outcome for every event.');
  if (answers.some(row => row.value === null || row.value === 'Unknown')) return {status:'incomplete',analysis:null};
  return {status:'complete',analysis:analyzeTrace(input,Object.fromEntries(answers.map(row => [row.taskId,row.value])))};
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || state.credentialHash.length !== 64 || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > tasks.length || iso(state.startedAt) !== state.startedAt) {
    throw new Error('Invalid state or changed trace or event metadata. Restore the original inputs.');
  }
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set();
  let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'taskId', 'createdAt', 'request', 'questionId', 'status', 'observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || attempt.taskId !== tasks[index].id
      || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.taskId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) {
      throw new Error('Invalid saved event classification request.');
    }
    ids.add(attempt.id);
    previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);
      validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS
        || attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) {
      throw new Error('Only the last task may have an active Question.');
    }
  }
  return state;
}

export function report(state,rawInput) {
  const input = validateInput(rawInput); validateState(state,input);
  const answers = tasksFor(input).map((task,index) => {
    const attempt = state.attempts.find(row => row.taskId === task.id), answer = attempt?.observation?.answer;
    return {taskId:task.id,eventIndex:index,transactionId:task.transactionId,objectId:task.objectId,
      status:attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      value:answer?.value ?? null,label:answer?.label ?? null,kind:answer?.kind ?? null,choice:answer?.choice ?? null,
      questionId:attempt?.questionId ?? null,attemptId:attempt?.id ?? null,responderId:answer?.responderId ?? null,answeredAt:answer?.answeredAt ?? null,
      askerId:attempt?.observation?.askerId ?? null,observedAt:attempt?.observation?.checkedAt ?? null};
  });
  const calculation = serializability(input,answers.map(({taskId,value}) => ({taskId,value})));
  const active = answers.find(row => ['create_unknown','pending'].includes(row.status));
  const status = active?.status ?? (answers.some(row => row.status === 'unasked') ? 'ready' : calculation.status);
  return {traceId:input.traceId,source:input,sourceHash:hash(input),configHash:hash(state.config),policy:POLICY,policyHash:POLICY_HASH,
    participant:state.config.participant,room:state.room,answers,analysis:calculation.analysis,
    traceCompletenessVerified:false,databaseIsolationVerified:false,sqlExecuted:false,status};
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'kind', 'choice', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some(option => option.value === answer.value && option.label === answer.label)
      || hash(parseChoice(answer.value)) !== hash({ kind: answer.kind, choice: answer.choice })
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved access evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain access evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== undefined && q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results != null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || Array.from(q.options).some((option,index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option.primary !== undefined && option.primary !== false || option.destructive !== undefined && option.destructive !== false
      || option.style !== undefined && option.style !== 'default')) throw new Error('Question does not match the saved task, room, or trace owner.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some(option => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid access button answer.');
      observation.answer = { value: answer.value, label: answer.label, ...parseChoice(answer.value), responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
