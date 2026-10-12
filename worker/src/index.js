import WebSocket from 'ws';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { executors } from './executors/index.js';
import { loadProviders } from './llm/providers.js';
import { listModels } from './llm/clients.js';
import { makeAccess } from './access.js';

// Conecta un worker al orquestador, declara sus capacidades y ejecuta las tareas que recibe.
// acceptGrants: aplicar los permisos que concede el usuario en el orquestador (y preguntarle los que
// falten). El embebido sí; uno externo solo con WORKER_ACCEPT_GRANTS=true (si no, solo su .env).
export function startWorker({ url, id, caps, max = 4, token = '', runtime, acceptGrants = false }) {
  let ws, retry = 0, stopped = false;
  const running = new Map();
  const approvals = new Map(); // reqId -> { resolve, reject, taskId } · aprobaciones pedidas por herramientas
  const tag = `[${id}]`;
  // Las claves se quedan en este proceso; al orquestador solo viaja describe()
  const providers = new Map(caps.includes('llm') ? loadProviders().map(p => [p.id, p]) : []);
  const llm = [...providers.values()].map(p => p.describe());

  function connect() {
    ws = new WebSocket(url);
    const send = o => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
    ws.on('open', () => {
      retry = 0;
      send({ type: 'hello', id, caps, max, token, llm, host: os.hostname(), runtime: runtime || `Node ${process.versions.node} · ${os.hostname()}` });
      console.log(`${tag} conectado a ${url} · capacidades: ${caps.join(', ')} · máx ${max}`);
      for (const p of llm) {
        const key = p.kind === 'mock' ? 'sin clave' : `${p.keyEnv} (${p.sourceLabel}${p.fingerprint ? ` · huella ${p.fingerprint}` : ''})`;
        console.log(`${tag} LLM ${p.id} · ${p.label} · ${key} · ${p.enabled ? 'activo' : `desactivado: ${p.reason}`}`);
      }
    });
    ws.on('message', async raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'cancel') { running.get(m.taskId)?.abort(); return; }
      if (m.type === 'approval') {
        const a = approvals.get(m.reqId);
        if (!a) return;
        approvals.delete(m.reqId);
        if (m.error) a.reject(new Error(m.error)); else a.resolve({ approved: !!m.approved, by: m.by || '', comment: m.comment || '' });
        return;
      }
      if (m.type === 'models') {
        const p = providers.get(m.provider);
        try {
          if (!p?.enabled) throw new Error(p ? p.reason : `Proveedor «${m.provider}» desconocido`);
          send({ type: 'models', reqId: m.reqId, ok: true, models: await listModels(p, { signal: AbortSignal.timeout(15000) }) });
        } catch (e) { send({ type: 'models', reqId: m.reqId, ok: false, error: e.message }); }
        return;
      }
      if (m.type !== 'task') return;
      const ac = new AbortController();
      running.set(m.taskId, ac);
      let meta = null;
      try {
        const fn = executors[m.nodeType];
        if (!fn) throw new Error(`Este worker no sabe ejecutar nodos «${m.nodeType}»`);
        const requestApproval = request => new Promise((resolve, reject) => {
          if (ac.signal.aborted) return reject(new Error('Cancelado'));
          const reqId = crypto.randomUUID();
          approvals.set(reqId, { resolve, reject, taskId: m.taskId });
          ac.signal.addEventListener('abort', () => { if (approvals.delete(reqId)) reject(new Error('Cancelado')); }, { once: true });
          send({ type: 'approval', taskId: m.taskId, reqId, request });
        });
        const access = makeAccess({ grants: acceptGrants ? (Array.isArray(m.grants) ? m.grants : []) : null, requestApproval });
        const output = await fn(m.params || {}, m.input, {
          signal: ac.signal, timeoutMs: m.timeoutMs, providers, setMeta: v => { meta = v; },
          log: msg => send({ type: 'log', taskId: m.taskId, msg: String(msg) }),
          // Pide aprobación humana al orquestador (permisos, ejecutar un comando…) y espera
          requestApproval, access,
        });
        send({ type: 'result', taskId: m.taskId, ok: true, meta, output: output === undefined ? null : JSON.parse(JSON.stringify(output)) });
      } catch (e) {
        send({ type: 'result', taskId: m.taskId, ok: false, meta, error: e?.message || String(e), retryable: e?.retryable !== false });
      } finally {
        running.delete(m.taskId);
      }
    });
    ws.on('close', code => {
      running.forEach(ac => ac.abort());
      running.clear();
      if (stopped) return;
      if (code === 4001) { console.error(`${tag} token rechazado por el orquestador`); return; }
      const d = Math.min(15000, 500 * 2 ** retry++);
      console.log(`${tag} desconectado · reintento en ${d} ms`);
      setTimeout(connect, d);
    });
    ws.on('error', () => {});
  }

  connect();
  return { close() { stopped = true; ws?.close(); } };
}

// Ejecución directa: npm run worker
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import('./env.js');
  startWorker({
    url: process.env.ORQ_URL || 'ws://localhost:3000/ws/worker',
    id: process.env.WORKER_ID || `worker-${os.hostname()}`,
    caps: (process.env.WORKER_CAPS || 'node').split(',').map(s => s.trim()).filter(Boolean),
    max: Number(process.env.WORKER_MAX || 4),
    token: process.env.WORKER_TOKEN || '',
    acceptGrants: process.env.WORKER_ACCEPT_GRANTS === 'true',
  });
}
