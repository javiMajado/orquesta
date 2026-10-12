import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotShellEnv, publicEnv } from '@orquesta/shared/env';

// Instantánea simulada: SHELL_KEY «venía del shell»; FILE_KEY la añadiría el .env de Orquesta
snapshotShellEnv({ SHELL_KEY: 'x' });
const { loadProviders, fingerprint } = await import('../src/llm/providers.js');
const { isPrivateIp, checkUrl, hostAllowed } = await import('../src/llm/net-guard.js');
const { default: agent } = await import('../src/executors/agent.js');

const GW = (keyEnv, extra = {}) => ({ id: 'gw', label: 'Gateway', kind: 'openai', baseUrl: 'https://gw.example.com', keyEnv, ...extra });
const env = (providers, extra = {}) => ({ SHELL_KEY: 'sk-shell-123', FILE_KEY: 'sk-file-456', ORQ_LLM_PROVIDERS: JSON.stringify(providers), ...extra });

test('sin configuración solo existe el proveedor simulado', () => {
  const ps = loadProviders({});
  assert.deepEqual(ps.map(p => [p.id, p.kind, p.enabled]), [['mock', 'mock', true]]);
});

test('una clave heredada del shell queda desactivada salvo ORQ_LLM_ALLOW_SHELL=true', () => {
  const [off] = loadProviders(env([GW('SHELL_KEY')]));
  assert.equal(off.source, 'shell');
  assert.equal(off.enabled, false);
  assert.match(off.reason, /ORQ_LLM_ALLOW_SHELL/);
  const [on] = loadProviders(env([GW('SHELL_KEY')], { ORQ_LLM_ALLOW_SHELL: 'true' }));
  assert.equal(on.enabled, true);
  assert.equal(on.source, 'shell');
});

test('una clave del .env de Orquesta (cuenta de servicio) está activa y se identifica como tal', () => {
  const [p] = loadProviders(env([GW('FILE_KEY')]));
  assert.equal(p.enabled, true);
  assert.equal(p.source, 'env');
  assert.equal(p.sourceLabel, '.env de Orquesta');
  assert.equal(p.host, 'gw.example.com');
});

test('describe() no contiene la clave; solo una huella que no la revela', () => {
  const [p] = loadProviders(env([GW('FILE_KEY')]));
  const d = JSON.stringify(p.describe());
  assert.ok(!d.includes('sk-file-456'));
  assert.equal(p.fingerprint, fingerprint('sk-file-456'));
  assert.match(p.fingerprint, /^[0-9a-f]{8}$/);
  assert.ok(!'sk-file-456'.includes(p.fingerprint));
  assert.ok(!JSON.stringify(p).includes('sk-file-456'), 'ni siquiera serializando el objeto');
});

test('configuraciones incompletas se desactivan con un motivo claro', () => {
  const ps = loadProviders(env([GW('NO_EXISTE'), { id: 'x', kind: 'gemini-nativo', keyEnv: 'FILE_KEY' }, GW('', { id: 'sin' })]));
  assert.match(ps[0].reason, /NO_EXISTE está vacía/);
  assert.match(ps[1].reason, /no soportado/);
  assert.match(ps[2].reason, /keyEnv/);
});

test('$env y env de scripts no exponen variables con secretos', () => {
  const e = publicEnv({ ORQ_SOPORTE_EMAIL: 'a@b.c', ORQ_API_KEY: 'x', ORQ_TOKEN: 'x', ORQ_LLM_ALLOW_SHELL: 'true', ORQ_DB_PASSWORD: 'x', ANTHROPIC_API_KEY: 'x' });
  assert.deepEqual(e, { ORQ_SOPORTE_EMAIL: 'a@b.c' });
});

test('agente simulado: respuesta simulada, metadatos sin clave y límite de entrada', async () => {
  const providers = new Map(loadProviders({}).map(p => [p.id, p]));
  const logs = [];
  let meta;
  const ctx = { providers, log: m => logs.push(m), setMeta: m => { meta = m; } };
  const out = await agent({ provider: 'mock', model: 'mock', output: 'JSON', mockOutput: { jiras: [1, 2] } }, { texto: 'doc' }, ctx);
  assert.deepEqual(out, { jiras: [1, 2] });
  assert.equal(meta.llm.provider, 'mock');
  assert.equal(meta.usage.estimado, true);
  assert.ok(logs.some(l => /Simulado.*sin clave/.test(l)));

  process.env.ORQ_LLM_MAX_INPUT_CHARS = '100';
  await assert.rejects(agent({ provider: 'mock', model: 'mock' }, 'x'.repeat(500), ctx), e => /límite es 100/.test(e.message) && e.retryable === false);
  delete process.env.ORQ_LLM_MAX_INPUT_CHARS;
  await assert.rejects(agent({ provider: 'gw' }, 'x', ctx), e => e.retryable === false);
});

test('http_request: IPs internas siempre bloqueadas', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.20.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '100.64.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});

test('http_request: solo dominios de ORQ_AGENT_HTTP_ALLOW que no resuelvan a la red interna', async () => {
  const pub = async () => [{ address: '93.184.216.34', family: 4 }];
  const loop = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(checkUrl('https://api.github.com', { env: {}, lookup: pub }), /desactivada/);
  const e = { ORQ_AGENT_HTTP_ALLOW: 'api.github.com, *.atlassian.net' };
  await checkUrl('https://api.github.com/repos', { env: e, lookup: pub });
  await checkUrl('https://miempresa.atlassian.net/rest', { env: e, lookup: pub });
  await assert.rejects(checkUrl('http://localhost:3000/api/workflows', { env: e, lookup: loop }), /no permitido/);
  await assert.rejects(checkUrl('http://127.0.0.1:3000/api', { env: e, lookup: loop }), /IPs directas/);
  await assert.rejects(checkUrl('file:///etc/passwd', { env: e, lookup: pub }), /Protocolo/);
  await assert.rejects(checkUrl('https://api.github.com', { env: e, lookup: loop }), /dirección interna/); // DNS manipulado
  assert.equal(hostAllowed('evilatlassian.net', ['*.atlassian.net']), false);
});
