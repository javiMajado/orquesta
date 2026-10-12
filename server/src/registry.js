import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { Settings } from './db.js';
import { env } from './env.js';

export class NoWorkerError extends Error {}

// Lo que un worker cuenta de cada proveedor LLM. Nunca incluye la clave; se filtra por si acaso.
const PROVIDER_FIELDS = ['id', 'label', 'kind', 'host', 'keyEnv', 'source', 'sourceLabel', 'fingerprint', 'enabled', 'reason', 'defaultModel'];
const cleanProvider = p => Object.fromEntries(PROVIDER_FIELDS.map(k => [k, k === 'enabled' ? !!p?.[k] : String(p?.[k] ?? '')]));
export class CancelledError extends Error {
  constructor() { super('Ejecución cancelada'); this.cancelled = true; }
}

// Registro de workers conectados por WebSocket + asignación de tareas.
export class Registry extends EventEmitter {
  constructor() {
    super();
    this.workers = new Map();   // id -> worker
    this.pending = new Map();   // taskId -> tarea en curso
    this.requests = new Map();  // reqId -> petición de lista de modelos
    this.queue = [];            // tareas esperando un hueco libre
    this.rr = 0;
    this.affinity = new Map();
    this.disabled = new Set(Settings.get('disabledWorkers', []));
  }

  get strategy() { return Settings.get('strategy', 'carga'); }

  attach(ws) {
    let w = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'hello') {
        if (env.WORKER_TOKEN && m.token !== env.WORKER_TOKEN) { ws.close(4001, 'token inválido'); return; }
        if (!m.id) { ws.close(4002, 'falta id'); return; }
        const prev = this.workers.get(m.id);
        if (prev && prev.ws !== ws) { try { prev.ws.close(4003, 'reemplazado'); } catch {} }
        w = { id: m.id, caps: m.caps || [], max: Math.max(1, m.max || 4), runtime: m.runtime || '', host: m.host || '',
          llm: Array.isArray(m.llm) ? m.llm.map(cleanProvider) : [],
          load: 0, tasks: prev?.tasks || 0, ws, connectedAt: Date.now(), lastSeen: Date.now() };
        this.workers.set(w.id, w);
        this.changed();
        this.drain();
        return;
      }
      if (!w) return;
      w.lastSeen = Date.now();
      if (m.type === 'result') {
        const t = this.pending.get(m.taskId);
        if (!t) return;
        this.pending.delete(m.taskId);
        clearTimeout(t.timer);
        w.load = Math.max(0, w.load - 1);
        w.tasks++;
        if (m.ok) t.resolve({ output: m.output, worker: w.id, meta: m.meta || null });
        else t.reject(Object.assign(new Error(m.error || 'Error en el worker'), { retryable: m.retryable !== false, meta: m.meta || null }));
        this.changed();
        this.drain();
      } else if (m.type === 'log') {
        this.pending.get(m.taskId)?.onLog?.(m.msg, w.id);
      } else if (m.type === 'approval') {
        this.approval(w, m);
      } else if (m.type === 'models') {
        const r = this.requests.get(m.reqId);
        if (!r) return;
        this.requests.delete(m.reqId);
        clearTimeout(r.timer);
        if (m.ok) r.resolve(m.models || []); else r.reject(new Error(m.error || 'No se pudieron listar los modelos'));
      }
    });
    ws.on('close', () => {
      if (!w) return;
      if (this.workers.get(w.id)?.ws === ws) this.workers.delete(w.id);
      for (const [tid, t] of this.pending) {
        if (t.workerId === w.id && t.ws === ws) {
          this.pending.delete(tid);
          clearTimeout(t.timer);
          t.reject(new Error(`El worker ${w.id} se desconectó`));
        }
      }
      this.changed();
    });
  }

  // provider: si se indica, solo valen workers con ese proveedor LLM activo
  candidates(cap, pin, provider) {
    return [...this.workers.values()].filter(w =>
      w.caps.includes(cap) && !this.disabled.has(w.id) && (!pin || pin === 'auto' || w.id === pin)
      && (!provider || w.llm.some(p => p.id === provider && p.enabled)));
  }

  pick(job) {
    const free = this.candidates(job.cap, job.pin, job.provider).filter(w => w.load < w.max);
    if (!free.length) return null;
    const s = this.strategy;
    if (s === 'rr') { this.rr++; return free[this.rr % free.length]; }
    if (s === 'afinidad' && job.affKey) {
      const prev = free.find(x => x.id === this.affinity.get(job.affKey));
      if (prev) return prev;
    }
    const w = free.sort((a, b) => a.load / a.max - b.load / b.max || a.tasks - b.tasks)[0];
    if (job.affKey) this.affinity.set(job.affKey, w.id);
    return w;
  }

  // job: { runId, cap, pin, provider, affKey, nodeType, params, input, timeoutMs, grants, onLog, onQueued, onAssigned, onApproval }
  dispatch(task) {
    return new Promise((resolve, reject) => {
      if (!this.candidates(task.cap, task.pin, task.provider).length) {
        return reject(new NoWorkerError(task.pin && task.pin !== 'auto'
          ? `El worker «${task.pin}» no está conectado, está desactivado${task.provider ? ` o no tiene activo el proveedor «${task.provider}»` : ''}`
          : task.provider ? `Ningún worker online tiene activo el proveedor LLM «${task.provider}»`
          : `No hay workers online con capacidad «${task.cap}»`));
      }
      const job = { ...task, resolve, reject };
      if (this.assign(job)) return;
      job.queueTimer = setTimeout(() => {
        this.queue = this.queue.filter(x => x !== job);
        reject(new Error('Timeout esperando un worker libre'));
      }, task.timeoutMs);
      this.queue.push(job);
      task.onQueued?.();
    });
  }

  assign(job) {
    const w = this.pick(job);
    if (!w) return false;
    clearTimeout(job.queueTimer);
    const taskId = crypto.randomUUID();
    w.load++;
    const onTimeout = () => {
      if (!this.pending.has(taskId)) return;
      this.pending.delete(taskId);
      w.load = Math.max(0, w.load - 1);
      try { w.ws.send(JSON.stringify({ type: 'cancel', taskId })); } catch {}
      job.reject(new Error(`Timeout tras ${Math.round(job.timeoutMs / 1000)} s en ${w.id}`));
      this.changed();
      this.drain();
    };
    const timer = setTimeout(onTimeout, job.timeoutMs);
    this.pending.set(taskId, { resolve: job.resolve, reject: job.reject, workerId: w.id, ws: w.ws, timer, onLog: job.onLog, onApproval: job.onApproval, runId: job.runId, deadline: Date.now() + job.timeoutMs, timeoutMs: job.timeoutMs, onTimeout });
    w.ws.send(JSON.stringify({ type: 'task', taskId, nodeType: job.nodeType, params: job.params, input: job.input, timeoutMs: job.timeoutMs, grants: job.grants || [] }));
    job.onAssigned?.(w);
    this.changed();
    return true;
  }

  // Una herramienta pide aprobación humana a mitad de tarea. El timeout de la tarea se pausa
  // mientras se espera (una persona puede tardar más que el timeout del nodo).
  async approval(w, m) {
    const t = this.pending.get(m.taskId);
    if (!t || t.workerId !== w.id) return;
    const reply = o => { try { w.ws.send(JSON.stringify({ type: 'approval', reqId: m.reqId, ...o })); } catch {} };
    if (!t.onApproval) return reply({ error: 'Este nodo no admite aprobaciones' });
    clearTimeout(t.timer);
    const left = Math.max(1000, t.deadline - Date.now());
    t.waiting = (t.waiting || 0) + 1;
    try { reply(await t.onApproval(m.request || {}, w.id)); }
    catch (e) { reply(e.cancelled ? { error: 'Cancelado' } : { approved: false, by: 'orquestador', comment: e.message }); }
    finally {
      if (--t.waiting === 0 && this.pending.get(m.taskId) === t) {
        t.deadline = Date.now() + left;
        t.timer = setTimeout(t.onTimeout, left);
      }
    }
  }

  drain() {
    for (let i = 0; i < this.queue.length;) {
      if (this.assign(this.queue[i])) this.queue.splice(i, 1);
      else i++;
    }
  }

  cancelRun(runId) {
    this.queue = this.queue.filter(job => {
      if (job.runId !== runId) return true;
      clearTimeout(job.queueTimer);
      job.reject(new CancelledError());
      return false;
    });
    for (const [tid, t] of this.pending) {
      if (t.runId !== runId) continue;
      this.pending.delete(tid);
      clearTimeout(t.timer);
      const w = this.workers.get(t.workerId);
      if (w) { w.load = Math.max(0, w.load - 1); try { w.ws.send(JSON.stringify({ type: 'cancel', taskId: tid })); } catch {} }
      t.reject(new CancelledError());
    }
    this.changed();
    this.drain();
  }

  setEnabled(id, enabled) {
    if (enabled) this.disabled.delete(id); else this.disabled.add(id);
    Settings.set('disabledWorkers', [...this.disabled]);
    this.changed();
    this.drain();
  }

  list() {
    return [...this.workers.values()].map(w => ({
      id: w.id, caps: w.caps, max: w.max, load: w.load, tasks: w.tasks, runtime: w.runtime, host: w.host, llm: w.llm,
      enabled: !this.disabled.has(w.id), connectedAt: w.connectedAt, lastSeen: w.lastSeen,
    })).sort((a, b) => a.id.localeCompare(b.id));
  }

  // Proveedores LLM de todos los workers conectados, agrupados por id
  llmProviders() {
    const out = new Map();
    for (const w of this.workers.values()) {
      if (this.disabled.has(w.id)) continue;
      for (const p of w.llm) {
        const cur = out.get(p.id) || { ...p, workers: [] };
        if (p.enabled && !cur.enabled) Object.assign(cur, p);
        cur.workers.push(w.id);
        out.set(p.id, cur);
      }
    }
    return [...out.values()];
  }

  // Pide a un worker con el proveedor activo su lista de modelos
  models(provider) {
    const w = this.candidates('llm', null, provider)[0];
    if (!w) return Promise.reject(new NoWorkerError(`Ningún worker online tiene activo el proveedor LLM «${provider}»`));
    return new Promise((resolve, reject) => {
      const reqId = crypto.randomUUID();
      const timer = setTimeout(() => { this.requests.delete(reqId); reject(new Error('El worker no respondió a tiempo')); }, 20000);
      this.requests.set(reqId, { resolve, reject, timer });
      w.ws.send(JSON.stringify({ type: 'models', reqId, provider }));
    });
  }

  changed() { this.emit('change'); }
}
