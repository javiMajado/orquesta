import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateEnv, FakeRegistry, waitFor, node, edge } from './helpers.js';

isolateEnv({ ORQ_LLM_MAX_TOKENS_PER_RUN: '1000' });
const { Engine } = await import('../src/engine.js');
const { Workflows, Runs, Steps } = await import('../src/db.js');

// Crea un workflow con los nodos dados (el primero debe ser el disparador) y lo ejecuta
function run(registry, nodes, edges, input = {}) {
  const wf = Workflows.create({ name: `t-${Math.random()}`, graph: { nodes, edges } });
  const engine = new Engine(registry);
  const r = engine.start(wf.id, { input });
  return { engine, ...r };
}
const echo = job => ({ output: { ...(job.input || {}), [job.params.tag]: true } });

test('secuencia: cada nodo recibe la salida del anterior', async () => {
  const [t, a, b] = [node('webhook'), node('node', { tag: 'a' }), node('node', { tag: 'b' })];
  const { done, runId } = run(new FakeRegistry(echo), [t, a, b], [edge(t, a), edge(a, b)], { x: 1 });
  assert.deepEqual(await done, { x: 1, a: true, b: true });
  assert.equal(Runs.get(runId).status, 'success');
  assert.equal(Steps.byRun(runId).length, 3);
});

test('condición: sigue solo la rama que corresponde', async () => {
  for (const [v, port] of [[5, 'true'], [1, 'false']]) {
    const t = node('webhook'), c = node('if', { expr: '$json.v > 3' }), yes = node('node', { tag: 'si' }), no = node('node', { tag: 'no' });
    const out = await run(new FakeRegistry(echo), [t, c, yes, no], [edge(t, c), edge(c, yes, 'true'), edge(c, no, 'false')], { v }).done;
    assert.equal(out[port === 'true' ? 'si' : 'no'], true);
    assert.equal(out[port === 'true' ? 'no' : 'si'], undefined);
  }
});

test('bucle por lotes: «cada» por elemento y «fin» con todos los resultados', async () => {
  const t = node('webhook'), loop = node('loop', { items: '{{ $json.lista }}', batch: '2' }), each = node('node'), end = node('node', { tag: 'fin' });
  const reg = new FakeRegistry(job => (job.params.tag ? echo(job) : { output: job.input.item * 10 }));
  const out = await run(reg, [t, loop, each, end], [edge(t, loop), edge(loop, each, 'item'), edge(loop, end, 'done')], { lista: [1, 2, 3] }).done;
  assert.deepEqual(out.items, [10, 20, 30]);
  assert.equal(out.total, 3);
  assert.equal(out.fin, true);
});

test('paralelo: «Unir (esperar todas)» recibe todas las ramas; «Unir (primera)» continúa una sola vez', async () => {
  for (const mode of ['Unir (esperar todas)', 'Unir (primera)']) {
    const t = node('webhook'), split = node('parallel', { mode: 'Dividir' }), a = node('node', { tag: 'a' }), b = node('node', { tag: 'b' });
    const merge = node('parallel', { mode }), last = node('node', { tag: 'z' });
    const reg = new FakeRegistry(echo);
    const out = await run(reg, [t, split, a, b, merge, last], [edge(t, split), edge(split, a), edge(split, b), edge(a, merge), edge(b, merge), edge(merge, last)]).done;
    const lastCalls = reg.calls.filter(c => c.params.tag === 'z');
    assert.equal(lastCalls.length, 1, mode);
    if (mode === 'Unir (esperar todas)') assert.equal(lastCalls[0].input.entradas.length, 2);
    assert.ok(out);
  }
});

test('reintentos: un error recuperable se reintenta', async () => {
  let n = 0;
  const reg = new FakeRegistry(job => { if (++n === 1) throw new Error('fallo temporal'); return echo(job); });
  const t = node('webhook'), a = node('http', { tag: 'ok' }, { retries: '2' });
  const out = await run(reg, [t, a], [edge(t, a)]).done;
  assert.equal(out.ok, true);
  assert.equal(reg.calls.length, 2);
});

test('reintentos: un error no recuperable (p.ej. 400) no se reintenta', async () => {
  const reg = new FakeRegistry(() => { throw Object.assign(new Error('HTTP 400: modelo no válido'), { retryable: false }); });
  const t = node('webhook'), a = node('agent', {}, { retries: '3' });
  const { done, runId } = run(reg, [t, a], [edge(t, a)]);
  await assert.rejects(done, /400/);
  assert.equal(reg.calls.length, 1);
  assert.equal(Runs.get(runId).status, 'error');
});

test('cancelación: detiene la tarea en curso y marca la ejecución como cancelada', async () => {
  const reg = new FakeRegistry(() => new Promise(() => {}));
  const t = node('webhook'), a = node('node');
  const { engine, done, runId } = run(reg, [t, a], [edge(t, a)]);
  await waitFor(() => reg.calls.length === 1, { what: 'la tarea' });
  engine.cancel(runId);
  await assert.rejects(done, /cancelada/);
  assert.equal(Runs.get(runId).status, 'cancelled');
});

test('nodo de aprobación: aprobar continúa y rechazar falla', async () => {
  for (const approved of [true, false]) {
    const t = node('webhook'), ap = node('approval', { assignee: 'yo', channel: 'Panel', timeout: '1 h' }), a = node('node', { tag: 'despues' });
    const reg = new FakeRegistry(echo);
    const { engine, done, runId } = run(reg, [t, ap, a], [edge(t, ap), edge(ap, a)], { x: 1 });
    await waitFor(() => engine.pending(runId).includes(ap.id), { what: 'la aprobación' });
    assert.equal(Runs.get(runId).status, 'waiting');
    engine.decide(runId, ap.id, { approved, by: 'test' });
    if (approved) {
      const out = await done;
      assert.equal(out.aprobacion.por, 'test');
      assert.equal(out.despues, true);
    } else {
      await assert.rejects(done, /Rechazado por test/);
      assert.equal(reg.calls.length, 0);
    }
  }
});

test('revisión humana del nodo: muestra los parámetros finales y no ejecuta hasta aprobar', async () => {
  for (const approved of [true, false]) {
    const t = node('webhook'), mail = node('email', { to: '{{ $json.email }}', subject: 'Hola' }, { humanReview: true });
    const reg = new FakeRegistry(() => ({ output: { enviado: true } }));
    const { engine, done, runId } = run(reg, [t, mail], [edge(t, mail)], { email: 'a@b.io' });
    await waitFor(() => engine.pending(runId).includes(mail.id), { what: 'la revisión' });
    assert.equal(reg.calls.length, 0, 'no debe ejecutarse antes de aprobar');
    const step = Steps.byRun(runId).find(s => s.nodeId === mail.id);
    assert.equal(step.status, 'waiting');
    assert.equal(step.meta.revision.params.to, 'a@b.io');
    engine.decide(runId, mail.id, { approved, by: 'test' });
    if (approved) { assert.deepEqual(await done, { enviado: true }); assert.equal(reg.calls.length, 1); }
    else { await assert.rejects(done, /Rechazado/); assert.equal(reg.calls.length, 0); }
  }
});

test('agente: sin configuración usa el proveedor simulado y su respuesta simulada', async () => {
  const reg = new FakeRegistry(job => ({ output: { echo: job.params.mockOutput } }));
  const t = node('webhook'), ag = node('agent', { provider: '', model: '', mockOutput: '{{ ({ n: $json.n * 2 }) }}' });
  const out = await run(reg, [t, ag], [edge(t, ag)], { n: 21 }).done;
  assert.equal(reg.calls[0].provider, 'mock');
  assert.equal(reg.calls[0].params.model, 'mock');
  assert.deepEqual(JSON.parse(JSON.stringify(out.echo)), { n: 42 });
});

test('agente: con un proveedor real la respuesta simulada ni se evalúa ni se envía', async () => {
  const reg = new FakeRegistry(() => ({ output: { ok: true } }), [{ id: 'gw', label: 'Gateway', kind: 'openai', enabled: true, keyEnv: 'K', source: 'env', fingerprint: 'abcd1234' }]);
  const t = node('webhook'), ag = node('agent', { provider: 'gw', model: 'm1', mockOutput: '{{ esto no es JS válido ( }}' });
  const { done, runId } = run(reg, [t, ag], [edge(t, ag)]);
  assert.deepEqual(await done, { ok: true });
  assert.equal(reg.calls[0].provider, 'gw');
  assert.equal(reg.calls[0].params.mockOutput, undefined);
  const logs = (await import('../src/db.js')).Logs.byRun(runId).map(l => l.msg).join('\n');
  assert.match(logs, /clave K \(\.env de Orquesta\) · huella abcd1234/);
});

test('presupuesto de tokens: corta la ejecución al superarlo', async () => {
  const reg = new FakeRegistry(() => ({ output: {}, meta: { usage: { total: 600 } } }));
  const t = node('webhook'), a = node('agent'), b = node('agent'), c = node('agent');
  const { done, runId } = run(reg, [t, a, b, c], [edge(t, a), edge(a, b), edge(b, c)]);
  await assert.rejects(done, /Presupuesto de tokens/);
  assert.equal(reg.calls.length, 2);
  assert.equal(Steps.byRun(runId).find(s => s.nodeId === a.id).meta.usage.total, 600);
});

test('la salida de un agente es dato: sus {{ }} no se evalúan en nodos posteriores', async () => {
  const evil = '{{ globalThis.pwned = true }}';
  const reg = new FakeRegistry(job => (job.nodeType === 'agent' ? { output: { text: evil } } : { output: job.params }));
  const t = node('webhook'), ag = node('agent'), mail = node('email', { to: 'x@y.z', body: '{{ $json.text }}', subject: 'Asunto: {{ $json.text }}' });
  const out = await run(reg, [t, ag, mail], [edge(t, ag), edge(ag, mail)]).done;
  assert.equal(out.body, evil);
  assert.equal(out.subject, `Asunto: ${evil}`);
  assert.equal(globalThis.pwned, undefined);
});

test('modo automático: campos vacíos usan el texto principal del nodo anterior', async () => {
  const reg = new FakeRegistry(job => {
    if (job.nodeType === 'file' && job.params.action === 'Leer') return { output: { ruta: 'C:/x/acta.txt', nombre: 'acta.txt', contenido: 'TEXTO DEL ACTA', bytes: 14 } };
    if (job.nodeType === 'agent') return { output: { text: `RESUMEN DE: ${job.params.input}` } };
    return { output: { escrito: job.params.content } };
  });
  const t = node('webhook'), leer = node('file', { action: 'Leer', path: 'C:/x/acta.txt' });
  const ag = node('agent', { input: '' }), escribir = node('file', { action: 'Escribir', path: 'C:/x/out.md', content: '' }, { humanReview: true });
  const { engine, done, runId } = run(reg, [t, leer, ag, escribir], [edge(t, leer), edge(leer, ag), edge(ag, escribir)]);
  await waitFor(() => engine.pending(runId).includes(escribir.id), { what: 'la revisión' });
  // La revisión enseña el texto real que se va a escribir, no un campo vacío
  assert.equal(Steps.byRun(runId).find(s => s.nodeId === escribir.id).meta.revision.params.content, 'RESUMEN DE: TEXTO DEL ACTA');
  engine.decide(runId, escribir.id, { approved: true, by: 'test' });
  assert.deepEqual(await done, { escrito: 'RESUMEN DE: TEXTO DEL ACTA' });
});

test('modo automático: sin campo de texto conocido se pasa el objeto como JSON; un valor explícito manda', async () => {
  const reg = new FakeRegistry(job => (job.nodeType === 'agent' ? { output: { recibido: job.params.input } } : { output: { a: 1 } }));
  const t = node('webhook'), x = node('http'), ag = node('agent', { input: '' });
  const out = await run(reg, [t, x, ag], [edge(t, x), edge(x, ag)]).done;
  assert.deepEqual(JSON.parse(out.recibido), { a: 1 });
  const ag2 = node('agent', { input: 'fijo' }), t2 = node('webhook');
  assert.equal((await run(reg, [t2, ag2], [edge(t2, ag2)]).done).recibido, 'fijo');
});
