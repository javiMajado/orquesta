import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateEnv, FakeRegistry, waitFor, node, edge } from './helpers.js';

const dir = fs.realpathSync(isolateEnv());
const repo = path.join(dir, 'repo');
fs.mkdirSync(repo);
const G = await import('../src/grants.js');
const { Engine } = await import('../src/engine.js');
const { Workflows } = await import('../src/db.js');

test('conceder, ampliar sin reducir, editar y revocar', () => {
  assert.throws(() => G.grant({ path: 'relativa' }), /absoluta/);
  assert.throws(() => G.grant({ path: path.join(dir, 'no-existe') }), /No existe/);
  const g = G.grant({ path: repo, read: true });
  G.grant({ path: repo, commands: 'npm test; npm test ;npm run  lint' });
  let cur = G.listGrants().grants.find(x => x.id === g.id);
  assert.deepEqual([cur.read, cur.write, cur.commands], [true, false, ['npm test', 'npm run lint']]);
  assert.equal(G.listGrants().grants.length, 1, 'misma carpeta = mismo permiso');
  G.updateGrant(g.id, { write: true, commands: [] });
  cur = G.listGrants().grants[0];
  assert.deepEqual([cur.read, cur.write, cur.commands], [true, true, []]);
  assert.deepEqual(G.grantsForWorker(), [{ path: repo, read: true, write: true, commands: [] }]);
  assert.equal(G.revokeGrant(g.id), true);
  assert.equal(G.listGrants().grants.length, 0);
});

// El worker pide un permiso que falta; según el botón, se guarda o no
function ask(request) {
  const reg = new FakeRegistry(async job => ({ output: { grants: job.grants, decision: await job.onApproval({ kind: 'permiso', ...request }, 'falso') } }));
  const t = node('webhook'), c = node('command', { comando: 'npm test', carpeta: repo });
  const wf = Workflows.create({ name: `t-${Math.random()}`, graph: { nodes: [t, c], edges: [edge(t, c)] } });
  const engine = new Engine(reg);
  return { engine, c, ...engine.start(wf.id, {}) };
}

test('permiso pedido al ejecutar: «Solo esta vez» no se guarda; «Permitir siempre» sí', async () => {
  let r = ask({ tipo: 'comando', comando: 'npm test', carpeta: repo });
  await waitFor(() => r.engine.pending(r.runId).includes(r.c.id), { what: 'el permiso' });
  r.engine.decide(r.runId, r.c.id, { approved: true, scope: 'once', by: 'ana' });
  assert.equal((await r.done).decision.scope, 'once');
  assert.equal(G.listGrants().grants.length, 0);

  r = ask({ tipo: 'comando', comando: 'npm test', carpeta: repo });
  await waitFor(() => r.engine.pending(r.runId).includes(r.c.id), { what: 'el permiso' });
  r.engine.decide(r.runId, r.c.id, { approved: true, scope: 'always', by: 'ana' });
  await r.done;
  assert.deepEqual(G.grantsForWorker(), [{ path: repo, read: false, write: false, commands: ['npm test'] }]);

  // La siguiente tarea ya lo recibe
  r = ask({ tipo: 'carpeta', carpeta: repo, acceso: 'lectura' });
  await waitFor(() => r.engine.pending(r.runId).includes(r.c.id), { what: 'el permiso' });
  r.engine.decide(r.runId, r.c.id, { approved: false, by: 'ana' });
  const out = await r.done;
  assert.deepEqual(out.grants[0].commands, ['npm test']);
  assert.equal(out.decision.approved, false);
  assert.equal(G.listGrants().grants[0].read, false, 'denegar no concede nada');
});
