import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateEnv, FakeRegistry, node, edge, waitFor } from './helpers.js';

isolateEnv();
const { Engine } = await import('../src/engine.js');
const { Workflows, Datasets, Cases, Runs } = await import('../src/db.js');
const { createDatasets } = await import('../src/datasets.js');

// El nodo de acción devuelve lo que recibe; si el email está vacío, falla (para probar «debe fallar»)
const reg = () => new FakeRegistry(job => {
  if (job.nodeType === 'agent') return { output: JSON.parse(job.params.mockOutput) };
  if (!job.input?.body?.email) throw new Error('sin email');
  return { output: { prioridad: job.input.body.vip ? 'alta' : 'baja', email: job.input.body.email } };
});
const events = [];
function setup(r = reg()) {
  const engine = new Engine(r);
  const ds = createDatasets({ engine, registry: r, broadcast: m => events.push(m) });
  const t = node('webhook', { method: 'POST', path: '/x', inputFields: [
    { key: 'email', path: 'body.email', type: 'email', required: true },
    { key: 'vip', path: 'body.vip', type: 'boolean', required: false },
  ] }, {}, 'Entrada');
  const a = node('node', { code: 'x' }, {}, 'Clasificar');
  const wf = Workflows.create({ name: `t-${Math.random()}`, graph: { nodes: [t, a], edges: [edge(t, a)] } });
  return { r, engine, ds, wf, t, a };
}

test('migración: testInput → campos de entrada y conjunto «Por defecto»', () => {
  const t = node('webhook', { method: 'POST', path: '/m' });
  const wf = Workflows.create({ name: 'mig', graph: { nodes: [t], edges: [], settings: { testInput: JSON.stringify({ body: { email: 'a@b.c', n: 2 } }) } } });
  const { ds } = setup();
  assert.equal(ds.migrateOne(Workflows.get(wf.id)), true);
  const g = Workflows.get(wf.id).graph;
  assert.equal(g.settings.testInput, undefined);
  assert.deepEqual(g.nodes[0].params.inputFields.map(f => `${f.key}:${f.type}`), ['email:email', 'n:number']);
  const [d] = Datasets.byWorkflow(wf.id);
  assert.equal(d.name, 'Por defecto');
  assert.deepEqual(Cases.byDataset(d.id)[0].values, { email: 'a@b.c', n: 2 });
  assert.equal(ds.migrateOne(Workflows.get(wf.id)), false, 'idempotente');
});

test('lote: hereda comunes, evalúa expectativas y «debe fallar»', async () => {
  const { ds, wf } = setup();
  const d = ds.createDataset(wf.id, { name: 'Regresión', common: { email: 'a@b.c', vip: false } });
  ds.createCase(d.id, { name: 'Normal', expect: [{ type: 'equals', node: 'Clasificar', path: 'prioridad', value: 'baja' }] });
  ds.createCase(d.id, { name: 'VIP', values: { vip: true }, expect: [{ type: 'equals', node: 'Clasificar', path: 'prioridad', value: 'baja' }] });
  ds.createCase(d.id, { name: 'Sin email', removed: ['email'], expectError: true });
  const b = ds.runBatch(d.id);
  const done = await waitFor(() => { const x = ds.getBatch(b.id); return x.status === 'done' && x; }, { what: 'el lote' });
  const by = Object.fromEntries(done.results.map(r => [r.name, r]));
  assert.equal(by.Normal.pass, true);
  assert.equal(by.VIP.pass, false);
  assert.equal(by.VIP.diffs[0].got, 'prioridad = "alta"');
  assert.equal(by['Sin email'].pass, true);
  assert.equal(Runs.get(by.Normal.runId).caseId, Cases.byDataset(d.id)[0].id);
  assert.ok(events.some(e => e.type === 'batch'));
});

test('casos incompletos y completar con IA (simulado)', async () => {
  const { ds, wf } = setup();
  const d = ds.createDataset(wf.id, { name: 'Incompletos' });
  ds.createCase(d.id, { name: 'A' });
  const view = ds.list(wf.id).datasets.find(x => x.id === d.id);
  assert.deepEqual(view.cases[0].missing, ['email']);
  assert.deepEqual(await ds.generate(d.id, { mode: 'fill' }), { updated: 1 });
  assert.equal(Cases.byDataset(d.id)[0].values.email, 'persona1@ejemplo.com');
  assert.deepEqual(await ds.generate(d.id, { mode: 'new', count: 2 }), { created: 2 });
});

test('importar CSV y guardar una ejecución como caso', async () => {
  const { ds, wf, engine, t } = setup();
  const d = ds.createDataset(wf.id, { name: 'Imp' });
  assert.deepEqual(ds.importData(d.id, { text: '_name;email;vip;_expect_error\nUno;u@x.es;sí;\nDos;;;sí' }), { created: 2 });
  const [uno, dos] = Cases.byDataset(d.id);
  assert.deepEqual(uno.values, { email: 'u@x.es', vip: true });
  assert.equal(dos.expectError, true);
  const { runId, done } = engine.start(wf.id, { input: { body: { email: 'r@x.es' } }, triggerNodeId: t.id });
  await done;
  const c = ds.saveRunAsCase(runId, { datasetId: d.id });
  assert.deepEqual(c.values, { email: 'r@x.es' });
  assert.equal(c.source.runId, runId);
});

test('webhook: validación y captura en modo escucha', () => {
  const { ds, wf, t } = setup();
  const node = { ...t, params: { ...t.params, validateInput: true } };
  assert.deepEqual(ds.validateWebhook(node, { body: {} }), [{ key: 'email', message: 'Obligatorio' }]);
  assert.deepEqual(ds.validateWebhook(node, { body: { email: 'a@b.c' } }), []);
  ds.listen(wf.id);
  assert.equal(ds.isListening(wf.id), true);
  ds.onWebhook(wf, t, { body: { email: 'cap@x.es' } }, { ip: '1.2.3.4' });
  assert.equal(ds.isListening(wf.id), false, 'una sola captura');
  const cap = Datasets.findKind(wf.id, 'capture');
  assert.equal(cap.name, 'Capturados de producción');
  assert.equal(Cases.byDataset(cap.id)[0].values.email, 'cap@x.es');
});
