import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, exportAnalysis } from './engine.js';
import { readJson } from './storage.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const example = await readJson(new URL('../examples/trace.json', import.meta.url));
for (const scenario of [
  { title: 'Acyclic conflicts permit serial order a then b', values: ['ReadOnly','Writes','NoAccess','NoAccess'], expected: true },
  { title: 'Conflicting X and Y accesses require a before b and b before a', values: ['ReadOnly','Writes','ReadOnly','Writes'], expected: false },
  { title: 'Unknown operation withholds the whole analysis', values: ['Unknown','Writes','ReadOnly','Writes'], expected: null },
]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-serial-demo-'));
  try {
    const input = structuredClone(example), now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    let result;
    for (const value of scenario.values) {
      result = await step(options); api.answer(result.answers.find(answer => answer.status === 'pending').questionId,value); result = await step(options);
    }
    if (scenario.expected !== null) {
      assert.equal(result.status,'complete'); assert.equal(result.analysis.conflictSerializable,scenario.expected);
      assert.deepEqual((await exportAnalysis(directory,input)).analysis,result.analysis);
    } else { assert.equal(result.status,'incomplete'); assert.equal(result.analysis,null); await assert.rejects(exportAnalysis(directory,input)); }
    console.log(JSON.stringify({scenario:scenario.title,status:result.status,analysis:result.analysis},null,2));
  } finally { await rm(directory,{recursive:true,force:true}); }
}
console.log('Offline demo used the pinned SDK with local mock transport. No live phone delivery, database connection or SQL execution.');
