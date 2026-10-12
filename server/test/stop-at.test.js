import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateEnv, FakeRegistry, node, edge } from './helpers.js';

isolateEnv();
const { Engine } = await import('../src/engine.js');
const { Workflows, Runs } = await import('../src/db.js');

// Cada nodo de acción devuelve su nombre, para saber cuáles se han ejecutado
const reg = () => new FakeRegistry(job => ({ output: { de: job.params.code } }));
const act = name => node('node', { code: name }, {}, name);
function run(r, nodes, edges, stopAt, input = {}) {
  const wf = Workflows.create({ name: `t-${Math.random()}`, graph: { nodes, edges } });
  return new Engine(r).start(wf.id, { input, stopAt });
}
const ran = r => r.calls.map(c => c.params.code).sort();

test('hasta aquí: solo el nodo y los que llevan a él; la salida es la suya', async () => {
  const r = reg();
  const t = node('webhook'), a = act('A'), b = act('B'), c = act('C'), d = act('D');
  const { done, runId } = run(r, [t, a, b, c, d], [edge(t, a), edge(a, b), edge(b, d), edge(a, c)], b.id);
  assert.deepEqual(await done, { de: 'B' });
  assert.deepEqual(ran(r), ['A', 'B'], 'ni la otra rama (C) ni lo de después (D)');
  assert.equal(Runs.get(runId).status, 'success');
});

test('hasta aquí con ramas en paralelo: la unión espera solo a las ramas que llevan al nodo', async () => {
  const t = node('webhook'), p = node('parallel', { mode: 'Dividir' }), x = act('X'), y = act('Y');
  const u = node('parallel', { mode: 'Unir (esperar todas)' }), z = act('Z');
  const nodes = [t, p, x, y, u, z], edges = [edge(t, p), edge(p, x), edge(p, y), edge(x, u), edge(y, u), edge(u, z)];
  let r = reg();
  assert.deepEqual(await run(r, nodes, edges, z.id).done, { de: 'Z' });
  assert.deepEqual(ran(r), ['X', 'Y', 'Z']);
  r = reg();
  await run(r, nodes, edges, x.id).done;
  assert.deepEqual(ran(r), ['X']);
});

test('hasta aquí dentro de un bucle: solo el primer elemento', async () => {
  const r = reg();
  const t = node('webhook'), l = node('loop', { items: '{{ [1, 2, 3] }}', batch: '1' }), a = act('A');
  await run(r, [t, l, a], [edge(t, l), edge(l, a, 'item')], a.id).done;
  assert.equal(r.calls.length, 1);
});

test('hasta aquí en un nodo sin disparador delante: error claro', () => {
  const t = node('webhook'), suelto = act('S');
  assert.throws(() => run(reg(), [t, suelto], [], suelto.id), /no está conectado/);
});

test('Email: con el cuerpo vacío usa el texto del nodo anterior', async () => {
  const r = new FakeRegistry(job => ({ output: job.nodeType === 'agent' ? { text: 'Hola, resumen listo' } : { body: job.params.body } }));
  const t = node('webhook'), ag = node('agent', { input: 'x' }), mail = node('email', { to: 'a@b.c', subject: 's', body: '' });
  assert.deepEqual(await run(r, [t, ag, mail], [edge(t, ag), edge(ag, mail)]).done, { body: 'Hola, resumen listo' });
});

test('Condición: acepta JavaScript directo y también {{ }} dentro de la expresión', async () => {
  for (const expr of ['$json.rowCount > 0', '{{ $json.rowCount }} > 0', '{{ $json.rowCount > 0 }}']) {
    const r = reg();
    const t = node('webhook'), c = node('if', { expr }), si = act('SI'), no = act('NO');
    await run(r, [t, c, si, no], [edge(t, c), edge(c, si, 'true'), edge(c, no, 'false')], undefined, { rowCount: 3 }).done;
    assert.deepEqual(ran(r), ['SI'], expr);
  }
});
