import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openChat } from '../src/llm/clients.js';

// Cliente Anthropic (SDK real) contra un servidor HTTP local que guarda las peticiones y responde según
// un guion: marcadores de caché, uso de caché, reintentos sin caché o sin limpieza de contexto.
let server, url, reqs = [], script = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      reqs.push({ headers: req.headers, body: JSON.parse(body) });
      const step = script.shift() || reply('fin');
      res.writeHead(step.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(step.body));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => { reqs = []; script = []; });

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 };
const reply = text => ({ body: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage } });
const toolTurn = id => ({ body: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'tool_use', id, name: 'leer', input: { ruta: 'a' } }], stop_reason: 'tool_use', usage } });
const bad = message => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message } } });
const provider = () => ({ kind: 'anthropic', host: '127.0.0.1', secret: () => ({ baseUrl: url, key: 'k' }) });
const tools = [{ def: { name: 'buscar', description: 'b', input_schema: { type: 'object', properties: {} } } }, { def: { name: 'leer', description: 'l', input_schema: { type: 'object', properties: {} } } }];
const markers = b => JSON.stringify(b).split('"cache_control"').length - 1;
const strip = v => JSON.parse(JSON.stringify(v, (k, x) => (k === 'cache_control' ? undefined : x)));

test('marcadores: última herramienta, dos últimas secciones del system y último mensaje (máx. 4)', async () => {
  script = [toolTurn('t1'), reply('ok')];
  const chat = openChat(provider(), { model: 'm', system: ['MAPA', 'PROMPT'], user: 'hola', maxTokens: 100, tools, promptCache: 'auto' });
  const r1 = await chat.next();
  chat.pushResults(r1.calls.map(c => ({ id: c.id, content: 'contenido' })));
  const r2 = await chat.next();
  const [a, b] = reqs.map(r => r.body);
  assert.deepEqual(a.tools.map(t => !!t.cache_control), [false, true]);
  assert.deepEqual(a.system.map(s => [s.text, !!s.cache_control]), [['MAPA', true], ['PROMPT', true]]);
  assert.ok(a.messages.at(-1).content.at(-1).cache_control);
  assert.equal(markers(a), 4);
  assert.equal(markers(b), 4);
  // El marcador se mueve: en la 2.ª petición solo el último mensaje lo lleva, y lo anterior no cambia
  assert.ok(!JSON.stringify(b.messages.slice(0, -1)).includes('cache_control'));
  assert.deepEqual(strip(b.messages.slice(0, a.messages.length)), strip(a.messages));
  assert.deepEqual(r2.usage, { input: 10, output: 5, cacheRead: 900, cacheWrite: 40 });
  // Limpieza de contexto en el servidor (hay herramientas)
  assert.deepEqual(a.context_management, { edits: [{ type: 'clear_tool_uses_20250919' }] });
  assert.match(reqs[0].headers['anthropic-beta'], /context-management-2025-06-27/);
});

test('si el proveedor rechaza cache_control, se reintenta sin caché y se recuerda (modo auto)', async () => {
  const p = { kind: 'anthropic', host: 'gw', secret: () => ({ baseUrl: `${url}/sin-cache`, key: 'k' }) };
  script = [bad('cache_control: Extra inputs are not permitted'), reply('ok'), reply('otra')];
  const chat = openChat(p, { model: 'm', system: 'PROMPT', user: 'hola', maxTokens: 100, tools: [], promptCache: 'auto' });
  assert.equal((await chat.next()).text, 'ok');
  assert.equal(reqs.length, 2);
  assert.equal(markers(reqs[1].body), 0);
  assert.equal(reqs[1].body.system, 'PROMPT', 'sin caché, el system va como texto');
  await openChat(p, { model: 'm', system: 'PROMPT', user: 'hola', maxTokens: 100, tools: [], promptCache: 'auto' }).next();
  assert.equal(markers(reqs[2].body), 0, 'la siguiente conversación ya no la manda');
});

test('modo off: sin marcadores; un 400 de cache_control con modo on no se oculta', async () => {
  script = [reply('ok')];
  await openChat(provider(), { model: 'm', system: 'P', user: 'hola', maxTokens: 100, tools, promptCache: 'off' }).next();
  assert.equal(markers(reqs[0].body), 0);
  const p = { kind: 'anthropic', host: 'gw', secret: () => ({ baseUrl: `${url}/on`, key: 'k' }) };
  script = [bad('cache_control no soportado')];
  await assert.rejects(openChat(p, { model: 'm', system: 'P', user: 'hola', maxTokens: 100, tools: [], promptCache: 'on' }).next(), /cache_control/);
});

test('si el proveedor no admite context_management, se reintenta sin él', async () => {
  const p = { kind: 'anthropic', host: 'gw', secret: () => ({ baseUrl: `${url}/sin-ctx`, key: 'k' }) };
  script = [bad('context_management: Extra inputs are not permitted'), reply('ok')];
  await openChat(p, { model: 'm', system: 'P', user: 'hola', maxTokens: 100, tools, promptCache: 'auto' }).next();
  assert.equal(reqs.length, 2);
  assert.ok(!('context_management' in reqs[1].body));
  assert.ok(!reqs[1].headers['anthropic-beta']);
});

test('precalentar: misma petición con max_tokens 0; si falla, se ignora', async () => {
  script = [reply('')];
  const chat = openChat(provider(), { model: 'm', system: ['MAPA', 'P'], user: 'hola', maxTokens: 100, tools, promptCache: 'auto' });
  const u = await chat.prewarm();
  assert.equal(reqs[0].body.max_tokens, 0);
  assert.equal(u.cacheWrite, 40);
  script = [bad('max_tokens: must be at least 1')];
  assert.equal(await chat.prewarm(), null);
  assert.match(chat.prewarmError, /max_tokens/);
});

test('precalentar con temperature obsoleta: se reintenta sin ella, como un turno normal', async () => {
  script = [bad('`temperature` is deprecated for this model.'), reply('')];
  const chat = openChat(provider(), { model: 'modelo-sin-temp-prewarm', system: ['MAPA', 'P'], user: 'hola', maxTokens: 100, temperature: 0, tools, promptCache: 'auto' });
  assert.equal((await chat.prewarm()).cacheWrite, 40);
  assert.equal(reqs.length, 2);
  assert.ok(!('temperature' in reqs[1].body));
});
