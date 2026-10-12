import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateEnv, FakeRegistry, node, edge } from './helpers.js';

isolateEnv();
const A = await import('../src/agents.js');
const { Workflows, Logs } = await import('../src/db.js');
const { Engine } = await import('../src/engine.js');

const BASE = { name: 'Clasificador', description: 'Clasifica tickets', config: { provider: 'mock', model: '', prompt: 'Clasifica el ticket.', output: 'JSON', tools: ' fecha_actual ,', temperature: '0.2', maxTokens: '500', mockOutput: '{ "tipo": "bug" }' } };

function run(reg, nodes, edges, input = {}) {
  const wf = Workflows.create({ name: `t-${Math.random()}`, graph: { nodes, edges } });
  return { wf, ...new Engine(reg).start(wf.id, { input }) };
}

test('crear, validar, renombrar y borrar', () => {
  const a = A.createAgent(BASE);
  assert.equal(a.config.tools, 'fecha_actual', 'normaliza herramientas');
  assert.throws(() => A.createAgent(BASE), /Ya existe/);
  assert.throws(() => A.createAgent({ ...BASE, name: ' ' }), /nombre/);
  assert.throws(() => A.createAgent({ ...BASE, name: 'x', config: { temperature: '3' } }), /temperatura/);
  assert.throws(() => A.createAgent({ ...BASE, name: 'x', config: { maxTokens: '1.5' } }), /entero/);
  const b = A.updateAgent(a.id, { name: 'Clasificador v2', config: { model: 'mock' } });
  assert.equal(b.name, 'Clasificador v2');
  assert.equal(b.config.prompt, 'Clasifica el ticket.', 'la edición parcial conserva el resto');
  assert.equal(A.deleteAgent(a.id), true);
});

test('el nodo usa la configuración del agente, su entrada e instrucciones adicionales', async () => {
  const a = A.createAgent({ ...BASE, name: 'Usado' });
  const reg = new FakeRegistry(job => ({ output: job.params }));
  const t = node('webhook');
  const ag = node('agent', { agentId: a.id, prompt: 'IGNORADO', output: 'Texto', input: 'Ticket {{ $json.n }}', extraPrompt: 'Responde en inglés.' });
  const { done, runId, wf } = run(reg, [t, ag], [edge(t, ag)], { n: 7 });
  const p = await done;
  assert.equal(p.prompt, 'Clasifica el ticket.\n\nResponde en inglés.');
  assert.equal(p.output, 'JSON');
  assert.equal(p.input, 'Ticket 7');
  assert.equal(p.temperature, '0.2');
  assert.equal(p.agentId, undefined);
  assert.equal(p.extraPrompt, undefined);
  assert.equal(reg.calls[0].provider, 'mock');
  assert.match(Logs.byRun(runId).map(l => l.msg).join('\n'), /Agente personalizado «Usado»/);
  assert.deepEqual(A.listAgents().find(x => x.id === a.id).usedIn.map(u => u.workflowId), [wf.id]);
});

test('editar el agente cambia los nodos que lo usan en la siguiente ejecución', async () => {
  const a = A.createAgent({ ...BASE, name: 'Editable' });
  const reg = new FakeRegistry(job => ({ output: { prompt: job.params.prompt } }));
  const t = node('webhook'), ag = node('agent', { agentId: a.id });
  A.updateAgent(a.id, { config: { prompt: 'Nuevo prompt' } });
  assert.deepEqual(await run(reg, [t, ag], [edge(t, ag)]).done, { prompt: 'Nuevo prompt' });
});

test('si el agente ya no existe, el nodo falla sin llamar a ningún worker', async () => {
  const reg = new FakeRegistry(() => ({ output: {} }));
  const t = node('webhook'), ag = node('agent', { agentId: 'ag_borrado' }, { retries: '2' });
  await assert.rejects(run(reg, [t, ag], [edge(t, ag)]).done, /ya no existe/);
  assert.equal(reg.calls.length, 0);
});

test('el esquema JSON de un agente se valida al guardarlo', () => {
  assert.throws(() => A.createAgent({ ...BASE, name: 'Esquema roto', config: { ...BASE.config, schema: '{ no' } }), /no es JSON válido/);
  assert.throws(() => A.createAgent({ ...BASE, name: 'Esquema lista', config: { ...BASE.config, schema: '[]' } }), /debe ser un objeto/);
  const a = A.createAgent({ ...BASE, name: 'Con esquema', config: { ...BASE.config, schema: '{ "type": "object", "properties": { "sql": { "type": "string" } } }' } });
  assert.match(a.config.schema, /"sql"/);
});
