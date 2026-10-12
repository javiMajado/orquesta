// SQLite integrado en Node (node:sqlite): sin módulos nativos que compilar, así funciona igual
// con Node (npm run dev) y dentro de Electron (app de escritorio).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from './env.js';

fs.mkdirSync(path.dirname(path.resolve(env.DB_FILE)), { recursive: true });
export const db = new DatabaseSync(env.DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  active INTEGER DEFAULT 0, graph TEXT NOT NULL, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, seq INTEGER, workflow_id TEXT, workflow_name TEXT, status TEXT, mode TEXT,
  input TEXT, output TEXT, error TEXT, parent_run_id TEXT, started_at INTEGER, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_wf ON runs (workflow_id, started_at DESC);
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, node_id TEXT, node_name TEXT, node_type TEXT,
  status TEXT, worker TEXT, input TEXT, output TEXT, error TEXT, attempt INTEGER DEFAULT 1,
  started_at INTEGER, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS steps_run ON steps (run_id);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts INTEGER, level TEXT, node TEXT, worker TEXT, msg TEXT
);
CREATE INDEX IF NOT EXISTS logs_run ON logs (run_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, driver TEXT NOT NULL, config TEXT NOT NULL,
  secret TEXT, read_only INTEGER DEFAULT 1, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT DEFAULT '', config TEXT NOT NULL,
  created_at INTEGER, updated_at INTEGER
);
`);

// Sentencias preparadas una sola vez y reutilizadas
const cache = new Map();
const q = sql => cache.get(sql) || cache.set(sql, db.prepare(sql)).get(sql);

// Migraciones aditivas para BD creadas con versiones anteriores
const cols = t => q(`PRAGMA table_info(${t})`).all().map(c => c.name);
if (!cols('steps').includes('meta')) db.exec('ALTER TABLE steps ADD COLUMN meta TEXT');
// Colección: agrupa workflows en la lista (texto libre; vacío = sin colección)
// Trazabilidad: por qué salida siguió cada paso (sí/no, cada/fin…) y qué ejecución hija lanzó (sub-workflow)
if (!cols('steps').includes('port')) db.exec('ALTER TABLE steps ADD COLUMN port TEXT');
if (!cols('steps').includes('child_run_id')) db.exec('ALTER TABLE steps ADD COLUMN child_run_id TEXT');
if (!cols('workflows').includes('collection')) db.exec("ALTER TABLE workflows ADD COLUMN collection TEXT DEFAULT ''");

const j = v => (v === undefined ? null : JSON.stringify(v));
const p = s => (s == null ? null : JSON.parse(s));
export const newId = pfx => `${pfx}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

const rowWf = r => r && ({ id: r.id, name: r.name, description: r.description, collection: r.collection || '', active: !!r.active, graph: p(r.graph), createdAt: r.created_at, updatedAt: r.updated_at });
const rowRun = r => r && ({ id: r.id, seq: r.seq, workflowId: r.workflow_id, workflowName: r.workflow_name, status: r.status, mode: r.mode, input: p(r.input), output: p(r.output), error: r.error, parentRunId: r.parent_run_id, startedAt: r.started_at, finishedAt: r.finished_at });
const rowStep = r => r && ({ id: r.id, runId: r.run_id, nodeId: r.node_id, nodeName: r.node_name, nodeType: r.node_type, status: r.status, worker: r.worker, input: p(r.input), output: p(r.output), error: r.error, attempt: r.attempt, meta: p(r.meta), port: r.port || null, childRunId: r.child_run_id || null, startedAt: r.started_at, finishedAt: r.finished_at });

export const Workflows = {
  list: () => q('SELECT * FROM workflows ORDER BY updated_at DESC').all().map(rowWf),
  get: id => rowWf(q('SELECT * FROM workflows WHERE id = ?').get(id)),
  findByName: name => rowWf(q('SELECT * FROM workflows WHERE name = ?').get(name)),
  create({ name = 'Nuevo workflow', description = '', collection = '', active = false, graph = { nodes: [], edges: [] } }) {
    const id = newId('wf'), now = Date.now();
    q('INSERT INTO workflows (id, name, description, collection, active, graph, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, name, description, String(collection || '').trim(), active ? 1 : 0, j(graph), now, now);
    return this.get(id);
  },
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    const n = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    q('UPDATE workflows SET name=?, description=?, collection=?, active=?, graph=?, updated_at=? WHERE id=?')
      .run(n.name, n.description, String(n.collection || '').trim(), n.active ? 1 : 0, j(n.graph), Date.now(), id);
    return this.get(id);
  },
  remove: id => q('DELETE FROM workflows WHERE id = ?').run(id).changes > 0,
};

export const Runs = {
  create({ workflowId, workflowName, mode, input, parentRunId }) {
    const seq = q('SELECT COALESCE(MAX(seq), 1000) + 1 AS s FROM runs').get().s;
    const id = `EX-${seq}`;
    q('INSERT INTO runs (id, seq, workflow_id, workflow_name, status, mode, input, parent_run_id, started_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, seq, workflowId, workflowName, 'running', mode, j(input), parentRunId || null, Date.now());
    return this.get(id);
  },
  get: id => rowRun(q('SELECT * FROM runs WHERE id = ?').get(id)),
  setStatus: (id, status) => q('UPDATE runs SET status = ? WHERE id = ?').run(status, id),
  finish: (id, { status, output, error }) =>
    q('UPDATE runs SET status=?, output=?, error=?, finished_at=? WHERE id=?').run(status, j(output), error || null, Date.now(), id),
  list({ workflowId, status, limit = 100 } = {}) {
    return q(`SELECT * FROM runs WHERE (@wf IS NULL OR workflow_id = @wf) AND (@st IS NULL OR status = @st)
      ORDER BY started_at DESC LIMIT @limit`).all({ wf: workflowId || null, st: status || null, limit }).map(rowRun);
  },
  lastByWorkflow() {
    const rows = q('SELECT workflow_id, status, MAX(started_at) AS started_at FROM runs GROUP BY workflow_id').all();
    return Object.fromEntries(rows.map(r => [r.workflow_id, { status: r.status, startedAt: r.started_at }]));
  },
  // Última ejecución de cada workflow lanzada de una forma concreta (p. ej. 'cron')
  lastByWorkflowMode(mode) {
    const rows = q('SELECT id, workflow_id, status, MAX(started_at) AS started_at FROM runs WHERE mode = ? GROUP BY workflow_id').all(mode);
    return Object.fromEntries(rows.map(r => [r.workflow_id, { runId: r.id, status: r.status, startedAt: r.started_at }]));
  },
  markInterrupted: () =>
    q("UPDATE runs SET status='interrupted', error='El servidor se reinició durante la ejecución', finished_at=? WHERE status IN ('running','waiting')").run(Date.now()),
};

export const Steps = {
  start({ runId, nodeId, nodeName, nodeType, input }) {
    return q('INSERT INTO steps (run_id, node_id, node_name, node_type, status, input, started_at) VALUES (?,?,?,?,?,?,?)')
      .run(runId, nodeId, nodeName, nodeType, 'running', j(input), Date.now()).lastInsertRowid;
  },
  // meta: proveedor/modelo/tokens del LLM y parámetros pendientes de revisión humana
  update(id, { status, worker, output, error, attempt, finishedAt, meta, port, childRunId }) {
    q(`UPDATE steps SET status=COALESCE(?,status), worker=COALESCE(?,worker), output=COALESCE(?,output),
      error=COALESCE(?,error), attempt=COALESCE(?,attempt), finished_at=COALESCE(?,finished_at), meta=COALESCE(?,meta),
      port=COALESCE(?,port), child_run_id=COALESCE(?,child_run_id) WHERE id=?`)
      .run(status ?? null, worker ?? null, output === undefined ? null : j(output), error ?? null, attempt ?? null, finishedAt ?? null, meta == null ? null : j(meta), port ?? null, childRunId ?? null, id);
  },
  byRun: runId => q('SELECT * FROM steps WHERE run_id = ? ORDER BY id').all(runId).map(rowStep),
};

export const Logs = {
  add({ runId, level, node, worker, msg }) {
    const ts = Date.now();
    const id = q('INSERT INTO logs (run_id, ts, level, node, worker, msg) VALUES (?,?,?,?,?,?)')
      .run(runId, ts, level, node || null, worker || null, String(msg)).lastInsertRowid;
    return { id, runId, ts, level, node: node || null, worker: worker || null, msg: String(msg) };
  },
  byRun: runId => q('SELECT id, run_id AS runId, ts, level, node, worker, msg FROM logs WHERE run_id = ? ORDER BY id').all(runId),
};

export const Settings = {
  get(key, def) { const r = q('SELECT value FROM settings WHERE key = ?').get(key); return r ? p(r.value) : def; },
  set(key, value) { q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, j(value)); },
};

// Conexiones a bases de datos dadas de alta desde la UI. «secret» = contraseña cifrada (secrets.js);
// nunca sale hacia la UI.
const rowConn = r => r && ({ id: r.id, name: r.name, driver: r.driver, config: p(r.config) || {}, readOnly: !!r.read_only, hasSecret: !!r.secret, secret: r.secret, createdAt: r.created_at, updatedAt: r.updated_at });
export const Connections = {
  list: () => q('SELECT * FROM connections ORDER BY name').all().map(rowConn),
  get: id => rowConn(q('SELECT * FROM connections WHERE id = ?').get(id)),
  findByName: name => rowConn(q('SELECT * FROM connections WHERE name = ?').get(name)),
  create({ name, driver, config, secret, readOnly }) {
    const id = newId('cx'), now = Date.now();
    q('INSERT INTO connections (id, name, driver, config, secret, read_only, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, name, driver, j(config), secret ?? null, readOnly ? 1 : 0, now, now);
    return this.get(id);
  },
  // secret: undefined = no cambia · null = se borra · texto = nuevo valor cifrado
  update(id, { name, driver, config, secret, readOnly }) {
    const cur = this.get(id);
    if (!cur) return null;
    q('UPDATE connections SET name=?, driver=?, config=?, secret=?, read_only=?, updated_at=? WHERE id=?')
      .run(name ?? cur.name, driver ?? cur.driver, j(config ?? cur.config), secret === undefined ? cur.secret ?? null : secret, (readOnly ?? cur.readOnly) ? 1 : 0, Date.now(), id);
    return this.get(id);
  },
  remove: id => q('DELETE FROM connections WHERE id = ?').run(id).changes > 0,
};

// Agentes personalizados: configuración reutilizable (proveedor, modelo, instrucciones…) que los
// nodos Agente referencian por id (params.agentId)
const rowAgent = r => r && ({ id: r.id, name: r.name, description: r.description || '', config: p(r.config) || {}, createdAt: r.created_at, updatedAt: r.updated_at });
export const Agents = {
  list: () => q('SELECT * FROM agents ORDER BY name').all().map(rowAgent),
  get: id => rowAgent(q('SELECT * FROM agents WHERE id = ?').get(id)),
  findByName: name => rowAgent(q('SELECT * FROM agents WHERE name = ?').get(name)),
  create({ name, description = '', config }) {
    const id = newId('ag'), now = Date.now();
    q('INSERT INTO agents (id, name, description, config, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(id, name, description, j(config), now, now);
    return this.get(id);
  },
  update(id, { name, description, config }) {
    const cur = this.get(id);
    if (!cur) return null;
    q('UPDATE agents SET name=?, description=?, config=?, updated_at=? WHERE id=?')
      .run(name ?? cur.name, description ?? cur.description, j(config ?? cur.config), Date.now(), id);
    return this.get(id);
  },
  remove: id => q('DELETE FROM agents WHERE id = ?').run(id).changes > 0,
};
