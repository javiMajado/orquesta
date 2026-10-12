import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { isolateEnv, waitFor } from './helpers.js';

const dir = isolateEnv({ WORKER_TOKEN: 'secreto-de-prueba' });
const { makePolicy } = await import('../src/security.js');
const { Registry } = await import('../src/registry.js');

test('política: Host y Origin', () => {
  const pol = makePolicy({ port: 3000, allowedHosts: ['orquesta'], allowedOrigins: ['https://orq.miempresa.com'] });
  assert.equal(pol.check({ host: 'localhost:3000' }), null);
  assert.equal(pol.check({ host: '127.0.0.1:3000', origin: 'http://localhost:5173' }), null);
  assert.equal(pol.check({ host: 'orquesta:3000' }), null);
  assert.equal(pol.check({ host: 'localhost:3000', origin: 'https://orq.miempresa.com' }), null);
  assert.match(pol.check({ host: 'evil.com' }), /Host no permitido/);              // DNS rebinding
  assert.match(pol.check({ host: 'localhost:3000', origin: 'https://evil.com' }), /Origen no permitido/);
  assert.match(pol.check({ host: 'localhost:3000', origin: 'null' }), /Origen no permitido/);
  assert.match(pol.check({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }), /cross-site/); // <img src>
  assert.match(pol.check({}), /Host no permitido/);
});

// WebSocket falso para probar el registro sin red
class FakeWs extends EventEmitter {
  constructor() { super(); this.sent = []; this.closed = null; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code) { this.closed = code; this.emit('close'); }
}

test('registro: un worker sin el token correcto se rechaza', () => {
  const reg = new Registry();
  for (const token of [undefined, '', 'otro']) {
    const ws = new FakeWs();
    reg.attach(ws);
    ws.emit('message', JSON.stringify({ type: 'hello', id: 'intruso', caps: ['llm'], token }));
    assert.equal(ws.closed, 4001);
  }
  assert.equal(reg.list().length, 0);
});

test('registro: de los proveedores LLM solo se guardan metadatos, nunca campos extra como la clave', () => {
  const reg = new Registry();
  const ws = new FakeWs();
  reg.attach(ws);
  ws.emit('message', JSON.stringify({ type: 'hello', id: 'w1', caps: ['llm'], token: 'secreto-de-prueba',
    llm: [{ id: 'gw', label: 'Gateway', kind: 'openai', enabled: true, keyEnv: 'K', source: 'shell', fingerprint: 'abcd1234', key: 'sk-NO', apiKey: 'sk-NO' }] }));
  assert.equal(ws.closed, null);
  const [w] = reg.list();
  assert.equal(w.llm[0].fingerprint, 'abcd1234');
  assert.ok(!JSON.stringify(reg.list()).includes('sk-NO'));
  assert.equal(reg.llmProviders()[0].id, 'gw');
  assert.equal(reg.candidates('llm', null, 'gw').length, 1);
  assert.equal(reg.candidates('llm', null, 'otro').length, 0);
});

// ── Integración: el servidor real ────────────────────────────────────────────
const free = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const port = await free();
const root = fileURLToPath(new URL('../..', import.meta.url));
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC|ORQ_LLM|OPENAI|GEMINI)/.test(k)));
const srv = spawn(process.execPath, ['server/src/index.js'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...childEnv, PORT: String(port), HOST: '', DB_FILE: path.join(dir, 'srv.db'), EMBEDDED_WORKER: 'false', WORKER_TOKEN: '' },
});
let out = '';
srv.stdout.on('data', d => { out += d; });
srv.stderr.on('data', d => { out += d; });
after(() => srv.kill());
await waitFor(() => out.includes('Agentes IA por defecto'), { timeout: 15000, what: 'el servidor' });

// http.request y no fetch: fetch descarta la cabecera Host (prohibida en el estándar)
const req = (headers = {}, p = '/api/health', method = 'GET') => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, res => { res.resume(); resolve(res.statusCode); });
  r.on('error', reject);
  r.end();
});

test('servidor: escucha solo en 127.0.0.1 y genera un WORKER_TOKEN temporal', async () => {
  assert.match(out, /solo este equipo/);
  assert.match(out, /WORKER_TOKEN no definido/);
  assert.equal(await req(), 200);
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
  if (lan) {
    const reachable = await new Promise(r => {
      const s = net.connect(port, lan.address, () => { s.destroy(); r(true); });
      s.on('error', () => r(false));
      s.setTimeout(2000, () => { s.destroy(); r(false); });
    });
    assert.equal(reachable, false, `no debe responder en ${lan.address}`);
  }
});

test('servidor: rechaza Host y Origin ajenos en la API y en los webhooks', async () => {
  assert.equal(await req({ host: 'evil.com' }), 403);
  assert.equal(await req({ origin: 'https://evil.com' }), 403);
  assert.equal(await req({ origin: 'https://evil.com', 'content-type': 'text/plain' }, '/hooks/tickets', 'POST'), 403);
  assert.equal(await req({ 'sec-fetch-site': 'cross-site' }, '/hooks/tickets', 'GET'), 403);
  assert.equal(await req({ origin: `http://localhost:${port}` }), 200);
});

const wsResult = (p, opts) => new Promise(resolve => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`, opts);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', id: 'intruso', caps: ['node'], token: 'adivinado' })));
  ws.on('close', code => resolve(code));
  ws.on('error', () => resolve('error'));
  ws.on('unexpected-response', (_q, res) => resolve(res.statusCode));
});

test('servidor: un worker sin token no puede registrarse y una web ajena no abre WebSockets', async () => {
  assert.equal(await wsResult('/ws/worker'), 4001);
  assert.equal(await wsResult('/ws/ui', { origin: 'https://evil.com' }), 403);
  const r = await fetch(`http://127.0.0.1:${port}/api/workers`).then(x => x.json());
  assert.equal(r.length, 0);
});
