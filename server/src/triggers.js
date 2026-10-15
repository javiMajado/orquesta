import cron from 'node-cron';
import crypto from 'node:crypto';
import { Workflows } from './db.js';

const norm = p => '/' + String(p || '').trim().replace(/^\/+|\/+$/g, '');

function checkAuth(node, req) {
  const auth = node.params?.auth || 'Ninguna';
  if (auth === 'API key') {
    const key = process.env.WEBHOOK_API_KEY;
    return !!key && req.get('x-api-key') === key;
  }
  if (auth === 'HMAC') {
    const secret = process.env.WEBHOOK_HMAC_SECRET;
    const sig = String(req.get('x-signature') || '').replace(/^sha256=/, '');
    if (!secret || !sig || !req.rawBody) return false;
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }
  return true;
}

// hooks (opcional): { isListening(wfId), onWebhook(wf, node, input, req), validateWebhook(node, input) } — datasets.js
export function createTriggers({ app, api, engine, hooks = {} }) {
  let tasks = [];

  // Reprograma todos los nodos Cron de los workflows activos.
  function sync() {
    tasks.forEach(t => t.stop());
    tasks = [];
    for (const wf of Workflows.list()) {
      if (!wf.active) continue;
      for (const n of wf.graph?.nodes || []) {
        if (n.type !== 'cron') continue;
        const expr = n.params?.expr;
        if (!cron.validate(expr)) { console.warn(`[cron] expresión inválida en «${wf.name}» → ${n.name}: ${expr}`); continue; }
        tasks.push(cron.schedule(expr, () => {
          try { engine.start(wf.id, { mode: 'cron', triggerNodeId: n.id, input: { disparado: new Date().toISOString() } }); }
          catch (e) { console.error('[cron]', e.message); }
        }, { timezone: n.params?.tz || undefined }));
      }
    }
  }

  // Webhooks: cualquier método en /hooks/<ruta>
  app.all('/hooks/*', async (req, res) => {
    const path = norm(req.params[0]);
    const matches = [];
    for (const wf of Workflows.list()) {
      // Un workflow inactivo también responde mientras está en modo escucha (captura de datos reales)
      if (!wf.active && !hooks.isListening?.(wf.id)) continue;
      for (const n of wf.graph?.nodes || []) {
        if (n.type === 'webhook' && norm(n.params?.path) === path && (n.params?.method || 'POST') === req.method) matches.push({ wf, n });
      }
    }
    if (!matches.length) return res.status(404).json({ error: `Ningún workflow activo escucha ${req.method} /hooks${path}` });
    const authed = matches.filter(m => checkAuth(m.n, req));
    if (!authed.length) return res.status(401).json({ error: 'Autenticación de webhook inválida' });

    const input = {
      body: req.body, query: req.query, method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['authorization', 'cookie', 'x-api-key'].includes(k))),
    };
    // «Validar llamadas reales»: 400 si falta un campo obligatorio o el tipo no coincide
    const checked = authed.map(m => ({ ...m, errors: hooks.validateWebhook?.(m.n, input) || [] }));
    const allowed = checked.filter(m => !m.errors.length);
    if (!allowed.length) return res.status(400).json({ error: 'Entrada no válida', fields: checked[0].errors });
    for (const { wf, n } of allowed) { try { hooks.onWebhook?.(wf, n, input, req); } catch (e) { console.error('[escucha]', e.message); } }
    const started = allowed.map(({ wf, n }) => engine.start(wf.id, { mode: 'webhook', triggerNodeId: n.id, input }));
    if (allowed[0].n.params?.respond === 'Al terminar') {
      try { return res.json((await started[0].done) ?? {}); }
      catch (e) { return res.status(500).json({ error: e.message, runId: started[0].runId }); }
    }
    res.status(202).json({ runIds: started.map(s => s.runId) });
  });

  // Eventos internos: POST /api/events/<tópico> con el payload en el cuerpo
  api.post('/events/:topic', (req, res) => {
    const runIds = [];
    for (const wf of Workflows.list()) {
      if (!wf.active) continue;
      for (const n of wf.graph?.nodes || []) {
        if (n.type === 'event' && n.params?.topic === req.params.topic) {
          runIds.push(engine.start(wf.id, { mode: 'evento', triggerNodeId: n.id, input: { topic: req.params.topic, payload: req.body } }).runId);
        }
      }
    }
    res.status(runIds.length ? 202 : 404).json({ runIds });
  });

  return { sync };
}
