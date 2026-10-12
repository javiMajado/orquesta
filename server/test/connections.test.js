import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isolateEnv, FakeRegistry, waitFor, node, edge } from './helpers.js';

const dir = isolateEnv({ DB_CONNECTIONS: JSON.stringify({ legado: { driver: 'pg', url: 'postgres://u:secreta@h:5432/d' } }) });
const { encrypt, decrypt } = await import('../src/secrets.js');
const C = await import('../src/connections.js');
const { db, Workflows, Steps } = await import('../src/db.js');
const { Engine } = await import('../src/engine.js');

const PG = { name: 'CRM', driver: 'pg', config: { host: 'db.local', port: 5432, database: 'crm', user: 'lector', ssl: 'no' }, password: 'S3creta!' };

test('cifrado: ida y vuelta, y el texto cifrado no contiene la contraseña', () => {
  const blob = encrypt('S3creta!');
  assert.ok(!blob.includes('S3creta'));
  assert.equal(decrypt(blob), 'S3creta!');
  assert.notEqual(encrypt('S3creta!'), blob, 'IV aleatorio');
  assert.ok(fs.readdirSync(dir).includes('secret.key'));
});

test('la contraseña no sale nunca hacia la UI ni se guarda en claro', () => {
  const c = C.createConnection(PG);
  assert.equal(c.readOnly, true, 'solo lectura por defecto');
  assert.equal(c.hasPassword, true);
  const all = JSON.stringify(C.listConnections());
  assert.ok(!all.includes('S3creta'));
  assert.ok(!all.includes('secreta'), 'tampoco la del .env');
  const raw = JSON.stringify(db.prepare('SELECT * FROM connections').all());
  assert.ok(!raw.includes('S3creta'));
  C.deleteConnection(c.id);
});

test('editar sin contraseña la conserva; vacía la borra; el worker recibe la descifrada', () => {
  const c = C.createConnection({ ...PG, name: 'CRM2' });
  C.updateConnection(c.id, { name: 'CRM2', driver: 'pg', config: { database: 'crm_v2' } });
  let w = C.resolveForWorker(c.id);
  assert.equal(w.password, 'S3creta!');
  assert.equal(w.database, 'crm_v2');
  assert.equal(C.resolveForWorker('CRM2').id, c.id, 'también por nombre');
  C.updateConnection(c.id, { driver: 'pg', password: '' });
  assert.equal(C.resolveForWorker(c.id).password, '');
  assert.equal(C.resolveForWorker('env:legado'), null, 'las del .env las resuelve el worker');
  C.deleteConnection(c.id);
});

test('validación del formulario', () => {
  assert.throws(() => C.createConnection({ ...PG, name: '' }), /nombre/);
  assert.throws(() => C.createConnection({ ...PG, config: { ...PG.config, host: '' } }), /servidor/);
  assert.throws(() => C.createConnection({ name: 'x', driver: 'sqlite', config: { file: 'relativa.db' } }), /ruta absoluta/);
  assert.throws(() => C.createConnection({ name: 'x', driver: 'mysql', config: {} }), /no soportado/);
  const a = C.createConnection({ ...PG, name: 'Dup' });
  assert.throws(() => C.createConnection({ ...PG, name: 'Dup' }), /Ya existe/);
  C.deleteConnection(a.id);
});

test('nodo BD: la revisión humana no muestra la contraseña; el worker recibe la conexión resuelta', async () => {
  const c = C.createConnection({ ...PG, name: 'Revisada' });
  const reg = new FakeRegistry(() => ({ output: { rows: [] } }));
  const t = node('webhook'), q = node('db', { conn: c.id, query: 'SELECT 1', params: '' }, { humanReview: true });
  const wf = Workflows.create({ name: 'bd', graph: { nodes: [t, q], edges: [edge(t, q)] } });
  const engine = new Engine(reg);
  const { done, runId } = engine.start(wf.id, {});
  await waitFor(() => engine.pending(runId).includes(q.id), { what: 'la revisión' });
  const meta = Steps.byRun(runId).find(s => s.nodeId === q.id).meta;
  assert.ok(!JSON.stringify(meta).includes('S3creta'), 'la tarjeta de revisión no lleva la contraseña');
  engine.decide(runId, q.id, { approved: true, by: 't' });
  await done;
  const got = reg.calls[0].params.connection;
  assert.equal(got.password, 'S3creta!');
  assert.equal(got.readOnly, true);
  assert.ok(!JSON.stringify(Steps.byRun(runId)).includes('S3creta'), 'ni en los pasos guardados');
  C.deleteConnection(c.id);
});
