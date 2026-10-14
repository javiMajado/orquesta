import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openChat } from '../src/llm/clients.js';

// Cliente OpenAI contra fetch simulado: registra las llamadas y responde según el guion.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(script) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    const step = script[calls.length - 1] || script[script.length - 1];
    return new Response(JSON.stringify(step.body), { status: step.status });
  };
  return calls;
}

const OPENCODE = { id: 'oc', label: 'OpenCode Go', kind: 'openai', host: 'opencode.ai', secret: () => ({ baseUrl: 'https://opencode.ai/inference/go/v1', key: 'sk-x' }) };
const ok = text => ({ status: 200, body: { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } } });
const depTemp = { status: 400, body: { error: { message: "Upstream request failed: [invalid_request_error] `temperature` is deprecated for this model." } } };

test('si el modelo no acepta temperature se reintenta sin ella y no se vuelve a mandar', async () => {
  const calls = mockFetch([depTemp, ok('hola')]);
  const chat = openChat(OPENCODE, { model: 'modelo-sin-temp', user: 'hola', maxTokens: 10, temperature: 0.5, tools: [] });
  const r = await chat.next();
  assert.equal(r.text, 'hola');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.temperature, 0.5);
  assert.ok(!('temperature' in calls[1].body));

  // Se recuerda para el resto del proceso: la siguiente conversación ya no la manda
  const calls2 = mockFetch([ok('adiós')]);
  const chat2 = openChat(OPENCODE, { model: 'modelo-sin-temp', user: 'hola', maxTokens: 10, temperature: 0.5, tools: [] });
  await chat2.next();
  assert.equal(calls2.length, 1);
  assert.ok(!('temperature' in calls2[0].body));
});

test('un 400 que no es por temperature no se reintenta', async () => {
  const bad = { status: 400, body: { error: { message: 'petición mal formada' } } };
  const calls = mockFetch([bad, ok('no debería llegar')]);
  const chat = openChat(OPENCODE, { model: 'otro-modelo', user: 'hola', maxTokens: 10, temperature: 0.5, tools: [] });
  await assert.rejects(chat.next(), /petición mal formada/);
  assert.equal(calls.length, 1);
});

test('a opencode.ai se le mandan x-opencode-session y user-agent propio; a otros hosts, no', async () => {
  const calls = mockFetch([ok('x')]);
  await openChat(OPENCODE, { model: 'm1', user: 'hola', maxTokens: 10, tools: [] }).next();
  assert.match(calls[0].headers['x-opencode-session'], /^orquesta-/);
  assert.match(calls[0].headers['user-agent'], /^orquesta\//);

  const otro = { ...OPENCODE, host: 'gw.example.com', secret: () => ({ baseUrl: 'https://gw.example.com', key: 'k' }) };
  const calls2 = mockFetch([ok('x')]);
  await openChat(otro, { model: 'm2', user: 'hola', maxTokens: 10, tools: [] }).next();
  assert.ok(!('x-opencode-session' in calls2[0].headers));
  assert.ok(!('user-agent' in calls2[0].headers));
});
