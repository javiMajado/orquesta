import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateEnv, FakeRegistry, node, edge } from './helpers.js';

isolateEnv({ ORQ_LLM_MAX_TOKENS_PER_RUN: '500' });
const { Workflows, Settings, Agents } = await import('../src/db.js');
const { Engine } = await import('../src/engine.js');
const { setLlmCache } = await import('../src/llm.js');
const { createAgent } = await import('../src/agents.js');
const { upgradeCoding, CODING_AGENTS, EXPLORAR, EXPLORAR_V1 } = await import('../src/seed-coding.js');

const run = (reg, nodes, edges) => new Engine(reg).start(Workflows.create({ name: `t-${Math.random()}`, graph: { nodes, edges } }).id, { input: {} }).done;

test('el presupuesto cuenta tokens ponderados: lo leído de caché apenas suma', async () => {
  // 1 000 tokens procesados, casi todos de caché: ponderados = 100 < 500, así que el segundo agente se ejecuta
  const reg = new FakeRegistry(() => ({ output: 'ok', meta: { usage: { input: 50, cacheRead: 900, cacheWrite: 0, output: 50, total: 1000, weighted: 190 } } }));
  const t = node('webhook'), a = node('agent', { provider: 'mock' }), b = node('agent', { provider: 'mock' }), c = node('agent', { provider: 'mock' });
  assert.equal(await run(reg, [t, a, b, c], [edge(t, a), edge(a, b), edge(b, c)]), 'ok');
  assert.equal(reg.calls.length, 3);
  // Sin «weighted» (worker antiguo) se usa total: 1 000 ≥ 500 agota el presupuesto
  const old = new FakeRegistry(() => ({ output: 'ok', meta: { usage: { input: 900, output: 100, total: 1000 } } }));
  await assert.rejects(run(old, [t, a, b], [edge(t, a), edge(a, b)]), /Presupuesto de tokens/);
});

test('la caché de prompts del proveedor (pantalla Workers) viaja con la tarea', async () => {
  const reg = new FakeRegistry(job => ({ output: job.params.promptCache }));
  const t = node('webhook'), a = node('agent', { provider: 'mock' });
  assert.equal(await run(reg, [t, a], [edge(t, a)]), 'auto');
  setLlmCache({ mock: 'off', otro: 'raro' });
  assert.equal(await run(reg, [t, a], [edge(t, a)]), 'off');
  assert.deepEqual(Settings.get('llmCache'), { mock: 'off' });
});

test('upgradeCoding: actualiza prompts sin tocar, herramientas del Desarrollador y añade repo a los nodos', () => {
  const rev = CODING_AGENTS.revisor, dev = CODING_AGENTS.desarrollador, qa = CODING_AGENTS.qa;
  const a1 = createAgent({ ...rev, config: { ...rev.config, prompt: rev.config.prompt.replace(EXPLORAR, EXPLORAR_V1) } });
  const a2 = createAgent({ ...dev, config: { ...dev.config, prompt: 'Prompt cambiado por el usuario', tools: 'buscar_ficheros, buscar_en_ficheros, leer_fichero' } });
  const a3 = createAgent({ ...qa, config: { ...qa.config, prompt: 'Otro prompt propio' } });
  const wf = Workflows.create({ name: 'Coding · viejo', collection: 'Coding', graph: { nodes: [
    { id: 'n1', type: 'agent', name: 'Revisor', params: { agentId: a1.id, input: 'x' } },
    { id: 'n2', type: 'agent', name: 'QA', params: { agentId: a3.id, input: 'x', repo: 'C:/otro' } },
  ], edges: [] } });
  Settings.set('codingVersion', 1);
  upgradeCoding();
  assert.equal(Agents.get(a1.id).config.prompt, rev.config.prompt, 'prompt original → versión con mapa');
  assert.match(Agents.get(a1.id).config.prompt, /Mapa del repositorio/);
  assert.equal(Agents.get(a2.id).config.prompt, 'Prompt cambiado por el usuario', 'prompt del usuario intacto');
  assert.equal(Agents.get(a2.id).config.tools, 'listar_ficheros, buscar_ficheros, buscar_en_ficheros, leer_fichero');
  const nodes = Workflows.get(wf.id).graph.nodes;
  assert.equal(nodes[0].params.repo, '{{ $node["Inicio"].body.repo }}');
  assert.equal(nodes[1].params.repo, 'C:/otro', 'no pisa un repo ya puesto');
  assert.equal(Settings.get('codingVersion'), 2);
});
