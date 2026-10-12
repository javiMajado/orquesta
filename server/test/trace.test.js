import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateEnv, FakeRegistry, node, edge } from './helpers.js';

isolateEnv();
const { Engine } = await import('../src/engine.js');
const { Workflows, Steps, Runs } = await import('../src/db.js');

test('traza: cada paso guarda la salida que tomó y el sub-workflow su ejecución hija', async () => {
  const reg = new FakeRegistry(job => ({ output: { hecho: job.params.code } }));
  const ht = node('webhook'), ha = node('node', { code: 'hijo' }, {}, 'Paso del hijo');
  Workflows.create({ name: 'Hijo traza', graph: { nodes: [ht, ha], edges: [edge(ht, ha)] } });
  const t = node('webhook'), c = node('if', { expr: '$json.n > 1' }), s = node('subflow', { workflow: 'Hijo traza' }), no = node('node', { code: 'no' });
  const l = node('loop', { items: '{{ [1, 2] }}', batch: '1' }), it = node('node', { code: 'vuelta' });
  const wf = Workflows.create({ name: 'Padre traza', graph: { nodes: [t, c, s, no, l, it], edges: [edge(t, c), edge(c, s, 'true'), edge(c, no, 'false'), edge(s, l), edge(l, it, 'item')] } });
  const { done, runId } = new Engine(reg).start(wf.id, { input: { n: 5 } });
  await done;
  const steps = Steps.byRun(runId);
  const by = id => steps.filter(x => x.nodeId === id);
  assert.equal(by(c.id)[0].port, 'true');
  assert.equal(by(l.id)[0].port, 'done');
  assert.equal(by(t.id)[0].port, null, 'la salida normal no se guarda');
  assert.equal(by(no.id).length, 0, 'la rama «no» no se ejecuta');
  assert.equal(by(it.id).length, 2, 'una vez por elemento');
  const childId = by(s.id)[0].childRunId;
  assert.ok(childId);
  assert.equal(Runs.get(childId).parentRunId, runId);
  assert.deepEqual(Steps.byRun(childId).map(x => x.nodeName), [ht.name, 'Paso del hijo']);
});

test('aprobación dentro de un sub-workflow: el padre y su nodo pasan a «esperando» y se aprueba en la ejecución hija', async () => {
  const { waitFor } = await import('./helpers.js');
  const reg = new FakeRegistry(job => ({ output: { hecho: job.params.code } }));
  const ht = node('webhook'), ap = node('approval', { assignee: 'x', timeout: '1 h' }, {}, 'Aprobar en el hijo'), hb = node('node', { code: 'tras aprobar' });
  Workflows.create({ name: 'Hijo con aprobación', graph: { nodes: [ht, ap, hb], edges: [edge(ht, ap), edge(ap, hb)] } });
  const t = node('webhook'), s = node('subflow', { workflow: 'Hijo con aprobación' });
  const wf = Workflows.create({ name: 'Padre con hijo que espera', graph: { nodes: [t, s], edges: [edge(t, s)] } });
  const engine = new Engine(reg);
  const { done, runId } = engine.start(wf.id, {});
  const childId = await waitFor(() => Steps.byRun(runId).find(x => x.nodeId === s.id)?.childRunId, { what: 'la ejecución hija' });
  await waitFor(() => engine.pending(childId).includes(ap.id), { what: 'la aprobación del hijo' });
  assert.equal(Runs.get(childId).status, 'waiting');
  assert.equal(Runs.get(runId).status, 'waiting', 'el padre también');
  assert.equal(Steps.byRun(runId).find(x => x.nodeId === s.id).status, 'waiting', 'y su nodo Sub-workflow');
  assert.deepEqual(engine.pending(runId), [], 'la aprobación es del hijo, no del padre');
  engine.decide(childId, ap.id, { approved: true, by: 'ana' });
  await waitFor(() => Runs.get(runId).status !== 'waiting', { what: 'que el padre siga' });
  await done;
  assert.equal(Runs.get(runId).status, 'success');
  assert.equal(Steps.byRun(runId).find(x => x.nodeId === s.id).status, 'success');
});
