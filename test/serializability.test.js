import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportAnalysis } from '../src/engine.js';
import { readJson, atomicJson, acquireLock, atomicText } from '../src/storage.js';
import { validateInput, validateState, tasksFor, parseChoice, serializability, analyzeTrace, CHOICES, POLICY, POLICY_HASH, TOKEN, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/trace.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-serial-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later event classifications; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'ReadOnly'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input = { max_length: 30 }; }, (q) => { q.options[0].label = 'Changed'; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { q.is_handoff = null; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-button answers never resolve a event classification', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '1e2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'ReadOnly'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.analysis, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across event classifications', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'ReadOnly'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).analysis, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'ReadOnly');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'ReadOnly'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'ReadOnly'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing operator before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'ReadOnly');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'ReadOnly'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).analysis, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});



const classifications = ['ReadOnly','Writes','NoAccess'];
const fixtureValues = ['ReadOnly','Writes','ReadOnly','Writes'];
const answersFor = (input,values) => tasksFor(input).map((event,index) => ({taskId:event.id,value:values[index]}));
const accessFor = (input,values) => Object.fromEntries(input.events.map((event,index)=>[event.id,values[index]]));
function trace(entries) {
  return {traceId:'oracle-v1',title:'Practice operation trace',purpose:'Check declared object accesses.',
    transactions:[...new Set(entries.map(row=>row[0]))].map(id=>({id,label:id})),objects:[...new Set(entries.map(row=>row[1]))].map(id=>({id,label:id})),
    events:entries.map(([transactionId,objectId],i)=>({id:`e${i}`,transactionId,objectId,description:`Operation ${i}`}))};
}
function permutations(items) {
  if(!items.length)return [[]];
  return items.flatMap((item,i)=>permutations(items.filter((_,j)=>i!==j)).map(rest=>[item,...rest]));
}
// Independent oracle: enumerate serial event sequences and compare conflicting operation order.
// It creates no precedence graph and runs no graph traversal.
function serialOracle(input,accesses) {
  return permutations(input.transactions.map(tx=>tx.id).sort()).filter(order=>{
    const serial=order.flatMap(tx=>input.events.filter(event=>event.transactionId===tx));
    for(let i=0;i<input.events.length;i++)for(let j=i+1;j<input.events.length;j++){
      const a=input.events[i],b=input.events[j];
      const at=accesses[a.id],bt=accesses[b.id];
      if(a.objectId===b.objectId && at!=='NoAccess' && bt!=='NoAccess' && (at==='Writes'||bt==='Writes')
        && serial.indexOf(a)>serial.indexOf(b))return false;
    }
    return true;
  });
}
function verifyCycle(input,accesses,result) {
  const cycle=result.cycle;assert.ok(cycle);assert.equal(cycle.transactionIds[0],cycle.transactionIds.at(-1));
  assert.equal(new Set(cycle.transactionIds.slice(0,-1)).size,cycle.transactionIds.length-1);assert.ok(cycle.transactionIds.length>=3);
  assert.equal(cycle.edges.length,cycle.transactionIds.length-1);
  for(const [i,edge] of cycle.edges.entries()){
    assert.equal(edge.from,cycle.transactionIds[i]);assert.equal(edge.to,cycle.transactionIds[i+1]);
    const w=edge.witness,a=input.events[w.earlierIndex],b=input.events[w.laterIndex];assert.ok(w.earlierIndex<w.laterIndex);
    assert.equal(a.id,w.earlierEventId);assert.equal(b.id,w.laterEventId);assert.equal(a.transactionId,edge.from);assert.equal(b.transactionId,edge.to);
    assert.equal(a.objectId,b.objectId);assert.equal(a.objectId,w.objectId);assert.notEqual(accesses[a.id],'NoAccess');assert.notEqual(accesses[b.id],'NoAccess');assert.ok(accesses[a.id]==='Writes'||accesses[b.id]==='Writes');
    assert.equal(w.earlierAccess,accesses[a.id]);assert.equal(w.laterAccess,accesses[b.id]);
  }
  assert.equal(result.serialOrder,null);assert.equal(result.serialEventOrder,null);
}

test('fixture produces a concrete two-transaction conflict cycle',()=>{
  const input=simple(),accesses=accessFor(input,fixtureValues),result=analyzeTrace(input,accesses);
  assert.equal(result.conflictSerializable,false);assert.deepEqual(result.cycle.transactionIds,['a','b','a']);verifyCycle(input,accesses,result);
  assert.deepEqual(result.edges.map(edge=>[edge.from,edge.to,edge.witnesses[0].earlierEventId,edge.witnesses[0].laterEventId]),[['a','b','e1','e2'],['b','a','e3','e4']]);
});

test('22620 exhaustive small traces match serial-permutation equivalence without graph algorithms',()=>{
  let cases=0;
  for(let size=1;size<=4;size++)for(let code=0;code<12**size;code++){
    let digits=code;const entries=[],values=[];
    for(let i=0;i<size;i++){const digit=digits%12;digits=Math.floor(digits/12);entries.push([['a','b'][digit%2],['x','y'][Math.floor(digit/2)%2]]);values.push(classifications[Math.floor(digit/4)]);}
    const input=trace(entries),accesses=accessFor(input,values),expected=serialOracle(input,accesses),actual=analyzeTrace(input,accesses);
    assert.equal(actual.conflictSerializable,expected.length>0);
    if(expected.length){assert.deepEqual(actual.serialOrder,expected[0]);assert.equal(actual.cycle,null);assert.deepEqual(actual.serialEventOrder,expected[0].flatMap(tx=>input.events.filter(event=>event.transactionId===tx).map(event=>event.id)));}
    else verifyCycle(input,accesses,actual);
    cases++;
  }
  assert.equal(cases,22620);
});

test('6561 four-transaction eight-event access vectors match all serial-permutation candidates',()=>{
  const input=trace([['a','x'],['b','x'],['b','y'],['c','y'],['c','z'],['d','z'],['d','x'],['a','x']]);
  for(let code=0;code<3**8;code++){
    let digits=code;const values=input.events.map(()=>{const value=classifications[digits%3];digits=Math.floor(digits/3);return value;});
    const accesses=accessFor(input,values),expected=serialOracle(input,accesses),actual=analyzeTrace(input,accesses);
    assert.equal(actual.conflictSerializable,expected.length>0);
    if(expected.length)assert.deepEqual(actual.serialOrder,expected[0]);else verifyCycle(input,accesses,actual);
  }
});

test('ReadOnly pairs, different objects, same-transaction writes and NoAccess do not create conflicts',()=>{
  for(const [entries,values] of [
    [[['a','x'],['b','x']],['ReadOnly','ReadOnly']],[[['a','x'],['b','y']],['Writes','Writes']],
    [[['a','x'],['a','x']],['Writes','Writes']],[[['a','x'],['b','x']],['Writes','NoAccess']],
  ]){const input=trace(entries),result=analyzeTrace(input,accessFor(input,values));assert.deepEqual(result.edges,[]);assert.equal(result.conflictSerializable,true);}
  for(const values of [['ReadOnly','Writes'],['Writes','ReadOnly'],['Writes','Writes']]){const input=trace([['a','x'],['b','x']]);assert.equal(analyzeTrace(input,accessFor(input,values)).edges.length,1);}
});

test('NoAccess-only transactions remain in canonical order and their original event order is retained',()=>{
  const input=trace([['d','x'],['a','x'],['c','y'],['a','y'],['b','x'],['d','y']]),values=['NoAccess','ReadOnly','NoAccess','Writes','NoAccess','NoAccess'];
  const result=analyzeTrace(input,accessFor(input,values));assert.deepEqual(result.serialOrder,['a','b','c','d']);assert.deepEqual(result.serialEventOrder,['e1','e3','e4','e2','e0','e5']);assert.equal(result.eventAccesses.filter(e=>e.access==='NoAccess').length,4);
  const all=analyzeTrace(input,accessFor(input,values.map(()=> 'NoAccess')));assert.deepEqual(all.serialOrder,['a','b','c','d']);assert.deepEqual(all.edges,[]);
});

test('all witnesses are retained for one edge and cycle selection is deterministic with multiple cycles',()=>{
  const input=trace([['a','x'],['a','x'],['b','x'],['c','x'],['b','x'],['a','x']]),values=input.events.map(()=> 'Writes'),accesses=accessFor(input,values),result=analyzeTrace(input,accesses);
  const edge=result.edges.find(e=>e.from==='a'&&e.to==='b');assert.equal(edge.witnesses.length,4);assert.deepEqual(edge.witnesses.map(w=>[w.earlierIndex,w.laterIndex]),[[0,2],[0,4],[1,2],[1,4]]);
  verifyCycle(input,accesses,result);assert.deepEqual(result.cycle.transactionIds,['a','b','a']);assert.deepEqual(result,analyzeTrace(input,accesses));
});

test('source event order changes the answer while declaration-array reordering does not',()=>{
  const input=simple(),accesses=accessFor(input,fixtureValues),reordered=simple();reordered.transactions.reverse();reordered.objects.reverse();
  assert.equal(hash(validateInput(input)),hash(validateInput(reordered)));assert.deepEqual(analyzeTrace(input,accesses),analyzeTrace(reordered,accesses));
  const serial=simple();serial.events=[input.events[0],input.events[3],input.events[1],input.events[2]];assert.notEqual(hash(validateInput(input)),hash(validateInput(serial)));assert.equal(analyzeTrace(serial,accesses).conflictSerializable,true);
});

test('strict schema rejects duplicate IDs, unknown references, holes, unsupported text and unused declarations',()=>{
  const mutations=[input=>input.extra=1,input=>input.transactions=[],input=>input.objects=[],input=>input.events=[],input=>input.events=[...input.events,...input.events,...input.events],
    input=>input.transactions.push({...input.transactions[0]}),input=>input.objects.push({id:'unused',label:'Unused'}),input=>input.transactions.push({id:'unused',label:'Unused'}),
    input=>input.events[1].id=input.events[0].id,input=>input.events[0].objectId='missing',input=>input.events[0].transactionId='missing',input=>input.events[0].extra=true,
    input=>delete input.events[0],input=>input.events[0]=null,input=>input.events[0].description='bad\nline',input=>input.events[0].description='\ud800',input=>input.transactions[0].label='bad\u2028line',input=>input.events[0].id='__proto__'];
  for(const mutate of mutations){const input=simple();mutate(input);assert.throws(()=>validateInput(input));}
  for(const input of [null,[],true,{}])assert.throws(()=>validateInput(input));
  for(const accesses of [{},Object.fromEntries(simple().events.map(e=>[e.id,'Unknown'])),{...accessFor(simple(),fixtureValues),extra:'Writes'}])assert.throws(()=>analyzeTrace(simple(),accesses));
});

test('maximum legal prompt includes transaction, object, event meaning and all four semantics',()=>{
  const input={traceId:'t'.repeat(40),title:'T'.repeat(40),purpose:'P'.repeat(60),transactions:[{id:'a'.repeat(16),label:'A'.repeat(24)}],objects:[{id:'o'.repeat(16),label:'O'.repeat(24)}],events:Array.from({length:8},(_,i)=>({id:'e'.repeat(15)+i,transactionId:'a'.repeat(16),objectId:'o'.repeat(16),description:'D'.repeat(60)}))};
  assert.equal(tasksFor(input).length,8);for(const task of tasksFor(input)){const request=requestFor(input,CONFIG,task.id,id(1));assert.ok(request.prompt.length<=500);assert.ok(request.prompt.includes(task.transactionId));assert.ok(request.prompt.includes(task.objectId));assert.ok(request.prompt.includes(task.description));assert.deepEqual(request.options.map(o=>o.value),CHOICES);assert.equal(request.data.policy_hash,POLICY_HASH);assert.equal(request.context.length,39);}
});

test('missing or Unknown anywhere withholds all graph conclusions; malformed or sparse answers reject',()=>{
  const input=simple();assert.equal(serializability(input,answersFor(input,fixtureValues)).status,'complete');
  for(let i=0;i<4;i++)for(const absent of [null,'Unknown']){const values=[...fixtureValues];values[i]=absent;assert.deepEqual(serializability(input,answersFor(input,values)),{status:'incomplete',analysis:null});}
  for(const value of ['',null,{},'ReadOnly ','writes','NoAccess\n','Unknown\u2028'])assert.throws(()=>parseChoice(value));
  assert.deepEqual(parseChoice('Unknown'),{kind:'unknown',choice:null});assert.deepEqual(parseChoice('NoAccess'),{kind:'known',choice:'NoAccess'});
  const sparse=answersFor(input,fixtureValues);delete sparse[0];assert.throws(()=>serializability(input,sparse));const wrong=answersFor(input,fixtureValues);wrong[0].taskId='wrong';assert.throws(()=>serializability(input,wrong));
});

test('complete positive and negative analyses export private repeatable evidence without network calls',async t=>{
  for(const values of [fixtureValues,['ReadOnly','Writes','NoAccess','NoAccess']]){
    const s=await setup(t),result=await decide(s,values);assert.equal(result.status,'complete');assert.equal(result.sqlExecuted,false);assert.equal(result.databaseIsolationVerified,false);assert.equal(result.traceCompletenessVerified,false);
    assert.ok(result.answers.every(row=>row.value&&row.label&&row.questionId&&row.responderId===CONFIG.participant.id&&row.askerId===ASKER));
    const calls=s.api.calls.length,exported=await exportAnalysis(s.directory,s.options.input);assert.deepEqual(exported.analysis,result.analysis);assert.equal(s.api.calls.length,calls);
    const path=join(s.directory,'analysis.json'),bytes=await readFile(path,'utf8');assert.deepEqual(JSON.parse(bytes),exported);await exportAnalysis(s.directory,s.options.input);assert.equal(await readFile(path,'utf8'),bytes);assert.equal((await stat(path)).mode&0o777,0o600);assert.equal(sends(s.api),4);
    assert.equal(result.sourceHash,hash(validateInput(s.options.input)));
  }
});

test('Unknown or cancelled event blocks final graph and export while preserving existing output',async t=>{
  for(const value of ['Unknown','Cancelled']){const s=await setup(t);await s.run();if(value==='Cancelled')s.api.terminal(id(1),'cancelled');else s.api.answer(id(1),value);await s.run();const result=await decide(s,['Writes','ReadOnly','Writes']);assert.equal(result.status,'incomplete');assert.equal(result.analysis,null);await atomicJson(s.directory,'analysis.json',{previous:'preserve'});await assert.rejects(exportAnalysis(s.directory,s.options.input));assert.deepEqual(await readJson(join(s.directory,'analysis.json')),{previous:'preserve'});}
});

test('ordinary Question optional flags work while poll tally, handoff and modified options fail closed',async t=>{
  const s=await setup(t);await s.run();const q=s.api.questions.get(id(1));delete q.is_handoff;delete q.results;for(const option of q.options){delete option.primary;delete option.destructive;option.style='default';}s.api.answer(id(1),'ReadOnly');assert.equal((await s.run()).observedStatus,'answered');
  for(const mutate of [q=>q.is_handoff=true,q=>q.is_handoff=null,q=>q.is_handoff=0,q=>q.results={},q=>q.results=[],q=>q.options[0].primary=true,q=>q.options[0].primary=null,q=>q.options[0].destructive='false',q=>q.options[0].style='danger',q=>q.options.reverse(),q=>q.options[0].label='Wrong']){const other=await setup(t);await other.run();mutate(other.api.questions.get(id(1)));await assert.rejects(other.run());}
});

test('changed event order, metadata, policy or saved choice is rejected before further requests',async t=>{
  const s=await setup(t);await s.run();s.api.answer(id(1),'ReadOnly');await s.run();const original=await s.saved();
  for(const mutate of [state=>state.attempts[0].observation.answer.choice='Writes',state=>state.attempts[0].observation.answer.label='Wrong',state=>state.attempts[0].request.data.policy_hash='bad']){const saved=structuredClone(original);mutate(saved);await atomicJson(s.directory,'state.json',saved);const calls=s.api.calls.length;await assert.rejects(s.run());assert.equal(s.api.calls.length,calls);}
  await atomicJson(s.directory,'state.json',original);
  for(const mutate of [input=>input.events.reverse(),input=>input.events[0].description='Different meaning',input=>input.objects[0].label='Different object']){const input=simple();mutate(input);const calls=s.api.calls.length;await assert.rejects(s.run({input}));assert.equal(s.api.calls.length,calls);}
});

test('invalid inputs send nothing and tokens reject trailing line terminators',async t=>{
  const s=await setup(t),input=simple();input.events[0].transactionId='missing';await assert.rejects(s.run({input}));assert.equal(s.api.calls.length,0);
  for(const suffix of ['\n','\r\n','\u2028','\u2029']){assert.equal(TOKEN.test('token'+suffix),false);assert.equal(isId(CONFIG.participant.id+suffix),false);assert.equal(ROOM.test(ROOM_CODE+suffix),false);assert.throws(()=>validateConnection({token:'token'+suffix,room:ROOM_CODE}));}
});
