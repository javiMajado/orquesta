import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isolateEnv, FakeRegistry, waitFor, sleep, node, edge } from './helpers.js';

isolateEnv({ WORKER_TOKEN: 't' });
const { Engine } = await import('../src/engine.js');
const { Registry } = await import('../src/registry.js');
const { Workflows, Steps } = await import('../src/db.js');

const lastStep = (runId, nodeId) => Steps.byRun(runId).filter(s => s.nodeId === nodeId).pop();

// El worker «pide» aprobación a mitad de tarea (como hace ejecutar_comando) y devuelve la decisión
function setup() {
  const reg = new FakeRegistry(async job => ({ output: { decision: await job.onApproval({ tool: 'ejecutar_comando', comando: 'npm test', carpeta: 'C:/repo' }, 'falso') } }));
  const t = node('webhook'), ag = node('agent', { tools: 'ejecutar_comando' });
  const wf = Workflows.create({ name: `t-${Math.random()}`, graph: { nodes: [t, ag], edges: [edge(t, ag)] } });
  const engine = new Engine(reg);
  return { engine, ag, ...engine.start(wf.id, {}) };
}

test('aprobación por llamada: el paso espera con el comando a la vista y sigue al aprobar', async () => {
  const { engine, ag, runId, done } = setup();
  await waitFor(() => engine.pending(runId).includes(ag.id), { what: 'la aprobación' });
  const st = lastStep(runId, ag.id);
  assert.equal(st.status, 'waiting');
  assert.equal(st.meta.tool, true);
  assert.deepEqual(st.meta.revision.params, { herramienta: 'ejecutar_comando', comando: 'npm test', carpeta: 'C:/repo' });
  engine.decide(runId, ag.id, { approved: true, by: 'ana' });
  const out = await done;
  assert.deepEqual(out.decision, { approved: true, scope: 'once', by: 'ana', comment: '' });
  assert.equal(lastStep(runId, ag.id).worker, 'falso', 'vuelve a mostrar el worker');
});

test('aprobación por llamada: rechazar no hace fallar el nodo; el agente recibe el rechazo', async () => {
  const { engine, ag, runId, done } = setup();
  await waitFor(() => engine.pending(runId).includes(ag.id), { what: 'la aprobación' });
  engine.decide(runId, ag.id, { approved: false, by: 'ana', comment: 'no' });
  const out = await done;
  assert.equal(out.decision.approved, false);
  assert.match(out.decision.comment, /Rechazado por ana: no/);
});

test('registry: el timeout de la tarea se pausa mientras se espera la aprobación', async () => {
  const reg = new Registry();
  const ws = Object.assign(new EventEmitter(), { sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() {} });
  reg.attach(ws);
  ws.emit('message', JSON.stringify({ type: 'hello', id: 'w1', caps: ['llm'], token: 't' }));
  const p = reg.dispatch({ runId: 'r', cap: 'llm', nodeType: 'agent', params: {}, input: null, timeoutMs: 150,
    onApproval: async () => { await sleep(300); return { approved: true, by: 'ana' }; } });
  const task = ws.sent.find(m => m.type === 'task');
  ws.emit('message', JSON.stringify({ type: 'approval', taskId: task.taskId, reqId: 'q1', request: { tool: 'ejecutar_comando' } }));
  await waitFor(() => ws.sent.some(m => m.type === 'approval'), { what: 'la respuesta' });
  assert.deepEqual(ws.sent.find(m => m.type === 'approval'), { type: 'approval', reqId: 'q1', approved: true, by: 'ana' });
  ws.emit('message', JSON.stringify({ type: 'result', taskId: task.taskId, ok: true, output: { ok: 1 } }));
  assert.deepEqual((await p).output, { ok: 1 });
});
