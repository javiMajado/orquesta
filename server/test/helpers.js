import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// BD temporal y entorno controlado ANTES de importar db.js / env.js
export function isolateEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orquesta-test-'));
  Object.assign(process.env, { DB_FILE: path.join(dir, 'test.db'), ORQ_LLM_DEFAULT: '', ...extra });
  return dir;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 3000, what = 'condición' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Timeout esperando ${what}`);
    await sleep(10);
  }
}

// Registry falso: ejecuta las tareas con un handler en lugar de mandarlas a workers
export class FakeRegistry {
  constructor(handler, providers = [{ id: 'mock', label: 'Simulado', kind: 'mock', enabled: true, defaultModel: 'mock' }]) {
    this.handler = handler;
    this.providers = providers;
    this.strategy = 'carga';
    this.calls = [];
    this.inflight = new Map(); // runId -> rechazos pendientes
  }
  llmProviders() { return this.providers; }
  async dispatch(job) {
    this.calls.push(job);
    const r = await new Promise((resolve, reject) => {
      const list = this.inflight.get(job.runId) || [];
      list.push(reject);
      this.inflight.set(job.runId, list);
      Promise.resolve().then(() => this.handler(job)).then(resolve, reject);
    });
    return { worker: 'falso', meta: null, ...r };
  }
  cancelRun(runId) {
    const err = Object.assign(new Error('Ejecución cancelada'), { cancelled: true });
    (this.inflight.get(runId) || []).forEach(rej => rej(err));
    this.inflight.delete(runId);
  }
}

let seq = 0;
export const node = (type, params = {}, exec = {}, name) => {
  const id = `t${++seq}`;
  return { id, type, name: name || `${type}-${id}`, x: 0, y: 0, params, exec: { retries: '0', timeout: '5 s', ...exec } };
};
export const edge = (from, to, port = 'out') => ({ id: `e${++seq}`, from: from.id, to: to.id, port });
