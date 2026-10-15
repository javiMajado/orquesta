import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateEnv, FakeRegistry, node, edge } from './helpers.js';

isolateEnv();
const { Workflows, Logs } = await import('../src/db.js');
const { Engine } = await import('../src/engine.js');
const A = await import('../src/agents.js');
const { mergeOverrides, pruneOverrides } = await import('@orquesta/shared/overrides');

const wf = (name, nodes, edges) => Workflows.create({ name, graph: { nodes, edges } });

test('los ajustes del nodo Sub-workflow cambian el agente del hijo solo en esa ejecución', async () => {
  const ag = A.createAgent({ name: 'Revisor sub', config: { provider: 'mock', model: 'mock', prompt: 'Revisa.', mockOutput: 'ok' } });
  const ct = node('webhook'), ca = node('agent', { agentId: ag.id, input: '', extraPrompt: '' }, {}, 'Revisar');
  const hijo = wf('Hijo ajustable', [ct, ca], [edge(ct, ca)]);
  const reg = new FakeRegistry(job => ({ output: { model: job.params.model, prompt: job.params.prompt, input: job.params.input } }));

  const t = node('webhook'), s = node('subflow', { workflow: 'Hijo ajustable', overrides: { [ca.id]: { overrideModel: 'mock-grande', extraPrompt: 'Sé breve.', input: 'Ticket {{ $json.n }}' } } });
  const padre = wf('Padre ajustes', [t, s], [edge(t, s)]);
  const { done, runId } = new Engine(reg).start(padre.id, { input: { n: 3 } });
  assert.deepEqual(await done, { model: 'mock-grande', prompt: 'Revisa.\n\nSé breve.', input: 'Ticket 3' });

  // El hijo guardado no cambia, y lanzado solo usa lo suyo
  assert.equal(Workflows.get(hijo.id).graph.nodes[1].params.overrideModel, undefined);
  const solo = await new Engine(reg).start(hijo.id, { input: {} }).done;
  assert.deepEqual([solo.model, solo.prompt], ['mock', 'Revisa.']);

  const child = reg.calls[0].runId;
  assert.notEqual(child, runId);
  assert.match(Logs.byRun(child).map(l => l.msg).join('\n'), /Ajustes del nodo Sub-workflow en: «Revisar»/);
});

test('ajustes anidados: el abuelo cambia un nodo del nieto y se combina con los del hijo', async () => {
  const nt = node('webhook'), nn = node('node', { code: 'return 1' }, {}, 'Nieto script'), nh = node('http', { url: 'https://a', method: 'GET' }, {}, 'Nieto http');
  wf('Nieto', [nt, nn, nh], [edge(nt, nn), edge(nn, nh)]);
  const ht = node('webhook'), hs = node('subflow', { workflow: 'Nieto', overrides: { [nn.id]: { code: 'return 2' } } });
  wf('Hijo intermedio', [ht, hs], [edge(ht, hs)]);
  const reg = new FakeRegistry(job => ({ output: job.nodeType === 'node' ? job.params.code : job.params.url }));

  const t = node('webhook'), s = node('subflow', { workflow: 'Hijo intermedio', overrides: { [hs.id]: { overrides: { [nh.id]: { url: 'https://b' } } } } });
  const padre = wf('Abuelo', [t, s], [edge(t, s)]);
  assert.equal(await new Engine(reg).start(padre.id, { input: {} }).done, 'https://b');
  assert.equal(reg.calls.find(c => c.nodeType === 'node').params.code, 'return 2', 'conserva el ajuste propio del hijo');
});

test('mergeOverrides y pruneOverrides', () => {
  assert.deepEqual(mergeOverrides({ a: { x: 1, overrides: { b: { y: 1 } } } }, { a: { overrides: { b: { z: 2 } } } }), { a: { x: 1, overrides: { b: { y: 1, z: 2 } } } });
  assert.deepEqual(pruneOverrides({ a: {}, b: { overrides: { c: {} } }, d: { k: '' } }), { d: { k: '' } });
});
