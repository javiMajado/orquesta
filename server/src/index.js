import { env } from './env.js';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Workflows, Runs, Steps, Logs, Settings, Datasets, Batches } from './db.js';
import { Registry } from './registry.js';
import { Engine } from './engine.js';
import { createTriggers } from './triggers.js';
import { createDatasets } from './datasets.js';
import { seedIfEmpty } from './seed.js';
import { makePolicy } from './security.js';
import { resolveLlm, llmDefault, llmCache, setLlmCache } from './llm.js';
import { listAgents, getAgent, createAgent, updateAgent, deleteAgent } from './agents.js';
import { listProjects, getProject, createProject, updateProject, deleteProject, listNotes, addNote, updateNote, deleteNote } from './projects.js';
import { listGrants, grant, updateGrant, revokeGrant } from './grants.js';
import { mountMockJira } from './mock-jira.js';
import { listSchedules } from './schedules.js';
import { parseRunFilters, runsToCsv, EXPORT_MAX_ROWS } from './runs-export.js';
import { listConnections, createConnection, updateConnection, deleteConnection, resolveForWorker, payloadForTest } from './connections.js';

Runs.markInterrupted();
Batches.markInterrupted();
seedIfEmpty();

const app = express();
app.disable('x-powered-by');
const policy = makePolicy({ port: env.PORT, allowedHosts: env.ALLOWED_HOSTS, allowedOrigins: env.ALLOWED_ORIGINS });
app.use(policy.middleware);
app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: 'text/*', limit: '5mb' }));

const registry = new Registry();
const engine = new Engine(registry);

const api = express.Router();
api.use((req, res, next) => {
  if (!env.API_TOKEN || req.get('authorization') === `Bearer ${env.API_TOKEN}`) return next();
  res.status(401).json({ error: 'No autorizado' });
});
const wrap = fn => async (req, res) => {
  try { const r = await fn(req, res); if (r !== undefined && !res.headersSent) res.json(r); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
};
const must = (v, msg = 'No encontrado') => { if (!v) throw Object.assign(new Error(msg), { status: 404 }); return v; };
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));

const triggers = createTriggers({ app, api, engine, hooks: {
  isListening: id => datasets.isListening(id),
  onWebhook: (...a) => datasets.onWebhook(...a),
  validateWebhook: (...a) => datasets.validateWebhook(...a),
} });
const datasets = createDatasets({ engine, registry, broadcast: m => broadcast(m) });
// Workflows con los antiguos «Datos de prueba (JSON)» → campos de entrada + conjunto «Por defecto»
const migrated = datasets.migrateAll();
if (migrated) console.log(`Datos de prueba migrados a casos en ${migrated} workflow${migrated === 1 ? '' : 's'}`);
mountMockJira(app);
// URL del propio Orquesta para expresiones y scripts ($env.ORQ_SELF_URL): p. ej. el Jira simulado
process.env.ORQ_SELF_URL = `http://127.0.0.1:${env.PORT}`;

api.get('/health', wrap(() => ({ ok: true, workers: registry.list().length })));

api.get('/workflows', wrap(() => {
  const last = Runs.lastByWorkflow();
  return Workflows.list().map(w => ({ ...w, lastRun: last[w.id] || null }));
}));
api.post('/workflows', wrap(req => {
  const w = Workflows.create(pick(req.body, ['name', 'description', 'collection', 'active', 'graph']));
  // Importado con el formato antiguo (graph.settings.testInput)
  if (datasets.migrateOne(w)) Object.assign(w, Workflows.get(w.id));
  triggers.sync();
  return w;
}));
api.get('/workflows/:id', wrap(req => must(Workflows.get(req.params.id))));
api.put('/workflows/:id', wrap(req => {
  const w = must(Workflows.update(req.params.id, pick(req.body, ['name', 'description', 'collection', 'active', 'graph'])));
  triggers.sync();
  broadcast({ type: 'workflow', workflow: w });
  return w;
}));
api.delete('/workflows/:id', wrap(req => { must(Workflows.remove(req.params.id)); Datasets.removeByWorkflow(req.params.id); datasets.stopListening(req.params.id, false); triggers.sync(); return { ok: true }; }));
// caseId: ejecuta un caso guardado (values = borrador del panel, opcional). Sin caseId: { input } tal cual.
api.post('/workflows/:id/run', wrap(req => {
  const stopAt = req.body?.stopAt ? String(req.body.stopAt) : undefined;
  if (req.body?.caseId) {
    const { runId } = datasets.runCase(String(req.body.caseId), { stopAt, values: req.body.values });
    return { runId };
  }
  const { runId } = engine.start(req.params.id, { mode: stopAt ? 'hasta-aqui' : 'manual', input: req.body?.input ?? {}, triggerNodeId: req.body?.triggerNodeId, stopAt });
  return { runId };
}));

// Conjuntos de datos y casos de prueba
api.get('/workflows/:id/datasets', wrap(req => datasets.list(req.params.id)));
api.post('/workflows/:id/datasets', wrap(req => datasets.createDataset(req.params.id, pick(req.body, ['name', 'common']))));
api.put('/datasets/:id', wrap(req => datasets.updateDataset(req.params.id, pick(req.body, ['name', 'common', 'position']))));
api.delete('/datasets/:id', wrap(req => datasets.removeDataset(req.params.id)));
api.post('/datasets/:id/duplicate', wrap(req => datasets.duplicateDataset(req.params.id)));
api.post('/datasets/:id/cases', wrap(req => datasets.createCase(req.params.id, pick(req.body, ['name', 'values', 'removed', 'expect', 'expectError']))));
api.put('/cases/:id', wrap(req => datasets.updateCase(req.params.id, pick(req.body, ['name', 'values', 'removed', 'expect', 'expectError', 'position']))));
api.delete('/cases/:id', wrap(req => datasets.removeCase(req.params.id)));
api.post('/datasets/:id/run', wrap(req => datasets.runBatch(req.params.id, { caseIds: req.body?.caseIds })));
api.get('/batches/:id', wrap(req => datasets.getBatch(req.params.id)));
api.post('/datasets/:id/generate', wrap(req => datasets.generate(req.params.id, pick(req.body, ['mode', 'count', 'prompt']))));
api.post('/datasets/:id/import', wrap(req => datasets.importData(req.params.id, { text: typeof req.body === 'string' ? req.body : req.body?.text, format: req.body?.format })));
api.post('/workflows/:id/listen', wrap(req => datasets.listen(req.params.id)));
api.delete('/workflows/:id/listen', wrap(req => datasets.stopListening(req.params.id)));
api.post('/runs/:id/save-as-case', wrap(req => datasets.saveRunAsCase(req.params.id, pick(req.body, ['datasetId', 'name']))));

api.get('/runs', wrap(req => Runs.list({ workflowId: req.query.workflowId, status: req.query.status, limit: Math.min(500, Number(req.query.limit) || 100) })));
// Exportación CSV del listado: mismos filtros, sin el límite de 500 filas. Debe ir ANTES de /runs/:id
// (si no, «export.csv» se tomaría como id). Responde directamente: wrap solo sirve JSON.
api.get('/runs/export.csv', (req, res) => {
  try {
    const runs = Runs.list({ ...parseRunFilters(req.query), limit: EXPORT_MAX_ROWS });
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.type('text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="ejecuciones-${day}.csv"`);
    if (runs.length >= EXPORT_MAX_ROWS) res.set('X-Export-Truncated', '1');
    res.send(runsToCsv(runs));
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
api.get('/runs/:id', wrap(req => {
  const r = must(Runs.get(req.params.id));
  return { ...r, steps: Steps.byRun(r.id), logs: Logs.byRun(r.id), pending: engine.pending(r.id) };
}));
// Traza: pasos de la ejecución en orden, con las ejecuciones hijas (sub-workflows) anidadas dentro de su paso
function trace(id, depth = 0) {
  const r = Runs.get(id);
  if (!r) return null;
  const steps = Steps.byRun(id).map(({ input, output, ...s }) => ({
    ...s, ...(s.childRunId && depth < 6 ? { child: trace(s.childRunId, depth + 1) } : {}),
  }));
  return { id: r.id, workflowId: r.workflowId, workflowName: r.workflowName, status: r.status, mode: r.mode, error: r.error, startedAt: r.startedAt, finishedAt: r.finishedAt, pending: engine.pending(r.id), steps };
}
api.get('/runs/:id/trace', wrap(req => must(trace(req.params.id))));
api.post('/runs/:id/cancel', wrap(req => { engine.cancel(req.params.id); return { ok: true }; }));
api.post('/runs/:id/approvals/:nodeId', wrap(req => {
  engine.decide(req.params.id, req.params.nodeId, { approved: !!req.body?.approved, by: req.body?.by || 'panel', comment: req.body?.comment || '', scope: req.body?.scope === 'always' ? 'always' : 'once' });
  return { ok: true };
}));

api.get('/workers', wrap(() => registry.list()));
// Nodos Cron de los workflows activos: horario, próxima y última ejecución
api.get('/schedules', wrap(() => listSchedules()));

// Proveedores LLM conectados y qué usará un nodo Agente con los parámetros dados
api.get('/llm', wrap(() => {
  const providers = registry.llmProviders();
  return { default: { ...llmDefault(), resolved: resolveLlm({}, providers) }, providers };
}));
api.get('/llm/resolve', wrap(req => resolveLlm({ provider: req.query.provider || '', model: req.query.model || '' }, registry.llmProviders())));
// Conexiones a bases de datos (las contraseñas nunca se devuelven)
api.get('/connections', wrap(() => listConnections()));
api.post('/connections', wrap(req => createConnection(req.body || {})));
api.put('/connections/:id', wrap(req => must(updateConnection(req.params.id, req.body || {}))));
api.delete('/connections/:id', wrap(req => { must(deleteConnection(req.params.id)); return { ok: true }; }));
// Probar: { id } de una guardada o el formulario completo; se hace un SELECT 1 en un worker «db»
api.post('/connections/test', wrap(async req => {
  const b = req.body || {};
  const env = String(b.id || '').startsWith('env:');
  const connection = env ? null : b.driver ? payloadForTest(b) : must(resolveForWorker(b.id), 'Conexión no encontrada');
  const t0 = Date.now();
  await registry.dispatch({
    runId: 'prueba-conexion', cap: 'db', nodeType: 'db', input: null, timeoutMs: 15000,
    params: { conn: env ? b.id.slice(4) : connection.name, connection, query: 'SELECT 1 AS ok', params: '[]' },
  });
  return { ok: true, ms: Date.now() - t0 };
}));
// Agentes personalizados (los nodos Agente los referencian por id)
api.get('/agents', wrap(() => listAgents()));
api.get('/agents/:id', wrap(req => must(getAgent(req.params.id))));
api.post('/agents', wrap(req => createAgent(req.body || {})));
api.put('/agents/:id', wrap(req => must(updateAgent(req.params.id, req.body || {}))));
api.delete('/agents/:id', wrap(req => { must(deleteAgent(req.params.id)); return { ok: true }; }));
// Proyectos y sus notas (memoria para los agentes; solo se usan las aprobadas)
const notesChanged = projectId => broadcast({ type: 'notes', projectId });
api.get('/projects', wrap(() => listProjects()));
api.post('/projects', wrap(req => createProject(pick(req.body, ['name', 'path', 'description']))));
api.get('/projects/:id', wrap(req => must(getProject(req.params.id))));
api.put('/projects/:id', wrap(req => must(updateProject(req.params.id, pick(req.body, ['name', 'path', 'description'])))));
api.delete('/projects/:id', wrap(req => { must(deleteProject(req.params.id)); notesChanged(req.params.id); return { ok: true }; }));
api.get('/projects/:id/notes', wrap(req => must(listNotes(req.params.id))));
api.post('/projects/:id/notes', wrap(req => { const n = addNote(req.params.id, pick(req.body, ['text', 'paths'])); notesChanged(n.projectId); return n; }));
api.put('/notes/:id', wrap(req => { const n = must(updateNote(req.params.id, pick(req.body, ['text', 'paths', 'status']))); notesChanged(n.projectId); return n; }));
api.delete('/notes/:id', wrap(req => { must(deleteNote(req.params.id)); notesChanged(null); return { ok: true }; }));
// Permisos de carpetas y comandos concedidos por el usuario (los del .env se muestran aparte)
api.get('/permissions', wrap(() => listGrants()));
api.post('/permissions', wrap(req => grant({ ...pick(req.body, ['path', 'read', 'write', 'commands']), by: req.body?.by || 'panel' })));
api.put('/permissions/:id', wrap(req => must(updateGrant(req.params.id, pick(req.body, ['read', 'write', 'commands'])))));
api.delete('/permissions/:id', wrap(req => { must(revokeGrant(req.params.id)); return { ok: true }; }));
api.get('/llm/models', wrap(async req => ({ models: await registry.models(String(req.query.provider || '')) })));
api.patch('/workers/:id', wrap(req => { registry.setEnabled(req.params.id, !!req.body?.enabled); return registry.list(); }));
api.get('/settings', wrap(() => ({ strategy: registry.strategy, llmCache: llmCache() })));
api.put('/settings', wrap(req => {
  if (['carga', 'rr', 'afinidad'].includes(req.body?.strategy)) Settings.set('strategy', req.body.strategy);
  if (req.body?.llmCache && typeof req.body.llmCache === 'object') setLlmCache(req.body.llmCache);
  registry.changed();
  return { strategy: registry.strategy, llmCache: llmCache() };
}));

app.use('/api', api);

// Frontend compilado (npm run build)
const dist = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res, next) => (req.path.startsWith('/api') || req.path.startsWith('/hooks') ? next() : res.sendFile(path.join(dist, 'index.html'))));
}

// WebSockets: /ws/worker (workers) y /ws/ui (eventos en vivo para la interfaz)
const server = http.createServer(app);
const wssWorker = new WebSocketServer({ noServer: true });
const wssUi = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const why = policy.check(req.headers);
  if (why) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws/worker') {
    wssWorker.handleUpgrade(req, socket, head, ws => registry.attach(ws));
  } else if (url.pathname === '/ws/ui') {
    if (env.API_TOKEN && url.searchParams.get('token') !== env.API_TOKEN) { socket.destroy(); return; }
    wssUi.handleUpgrade(req, socket, head, ws => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.send(JSON.stringify({ type: 'workers', workers: registry.list() }));
    });
  } else socket.destroy();
});
setInterval(() => {
  for (const wss of [wssWorker, wssUi]) {
    wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
  }
}, 20000).unref();

function broadcast(msg) {
  const s = JSON.stringify(msg);
  wssUi.clients.forEach(c => c.readyState === 1 && c.send(s));
}
engine.on('event', broadcast);
let wt = null;
registry.on('change', () => {
  if (wt) return;
  wt = setTimeout(() => { wt = null; broadcast({ type: 'workers', workers: registry.list() }); }, 150);
});

server.listen(env.PORT, env.HOST, async () => {
  console.log(`Orquesta escuchando en http://${env.HOST === '0.0.0.0' ? 'localhost' : env.HOST}:${env.PORT}${env.HOST === '127.0.0.1' ? ' (solo este equipo)' : ` · ¡expuesto en ${env.HOST}!`}`);
  if (env.WORKER_TOKEN_GENERATED) console.log('WORKER_TOKEN no definido: se ha generado uno temporal; solo el worker embebido puede conectarse.');
  const def = llmDefault();
  console.log(`Agentes IA por defecto: ${def.provider ? `${def.provider} · ${def.model || 'modelo por defecto del proveedor'}` : 'simulado (sin coste) · define ORQ_LLM_DEFAULT para usar un LLM real'}`);
  triggers.sync();
  if (process.env.EMBEDDED_WORKER !== 'false') {
    const { startWorker } = await import('@orquesta/worker');
    // llm siempre incluye el proveedor simulado; los reales solo si están configurados en ORQ_LLM_PROVIDERS
    const caps = (process.env.EMBEDDED_WORKER_CAPS || 'node,db,llm').split(',').map(s => s.trim()).filter(Boolean);
    startWorker({ url: `ws://127.0.0.1:${env.PORT}/ws/worker`, id: 'worker-embebido', caps, max: Number(process.env.EMBEDDED_WORKER_MAX || 4), token: env.WORKER_TOKEN, runtime: 'Embebido en el servidor', acceptGrants: true });
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
