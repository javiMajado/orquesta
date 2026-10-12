import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import db from '../src/executors/db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orquesta-db-'));
const file = path.join(dir, 'datos.db');
const ctx = { log: () => {} };
const conn = (readOnly, extra = {}) => ({ id: `t-${readOnly}`, name: 't', driver: 'sqlite', file, readOnly, version: 1, ...extra });

test('lectura y escritura: crea, inserta y consulta', async () => {
  const rw = conn(false);
  await db({ connection: rw, query: 'CREATE TABLE clientes (id INTEGER PRIMARY KEY, email TEXT)' }, null, ctx);
  const ins = await db({ connection: rw, query: 'INSERT INTO clientes (email) VALUES (?)', params: '["ana@x.com"]' }, null, ctx);
  assert.equal(ins.rowCount, 1);
  const r = await db({ connection: rw, query: 'SELECT email FROM clientes' }, null, ctx);
  assert.deepEqual(r.rows, [{ email: 'ana@x.com' }]);
});

test('solo lectura: consulta sí, modificar no', async () => {
  const ro = conn(true);
  const r = await db({ connection: ro, query: 'SELECT COUNT(*) AS n FROM clientes' }, null, ctx);
  assert.equal(r.rows[0].n, 1);
  await assert.rejects(db({ connection: ro, query: 'DELETE FROM clientes' }, null, ctx), /solo lectura/);
  await assert.rejects(db({ connection: ro, query: 'INSERT INTO clientes (email) VALUES (?)', params: '["x"]' }, null, ctx), /solo lectura/);
  await assert.rejects(db({ connection: conn(true, { id: 'otro', file: path.join(dir, 'no-existe.db') }), query: 'SELECT 1' }, null, ctx), /debe existir/);
});

test('conexiones del .env por nombre (con o sin prefijo env:) y errores claros', async () => {
  process.env.DB_CONNECTIONS = JSON.stringify({ local: { driver: 'sqlite', file } });
  for (const conn of ['local', 'env:local']) {
    const r = await db({ conn, query: 'SELECT COUNT(*) AS n FROM clientes' }, null, ctx);
    assert.equal(r.rows[0].n, 1);
  }
  await assert.rejects(db({ conn: '', query: 'SELECT 1' }, null, ctx), /Elige una conexión/);
  await assert.rejects(db({ conn: 'nada', query: 'SELECT 1' }, null, ctx), /no existe/);
  await assert.rejects(db({ conn: 'local', query: 'SELECT ?', params: 'no-json' }, null, ctx), /array JSON/);
  delete process.env.DB_CONNECTIONS;
});
