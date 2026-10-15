import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolateEnv, waitFor } from './helpers.js';

const dir = isolateEnv();
const { Runs } = await import('../src/db.js');
const { parseRunFilters, runsToCsv, EXPORT_MAX_ROWS } = await import('../src/runs-export.js');

const HEAD = 'id;seq;workflowId;workflowName;status;mode;startedAt;finishedAt;durationMs;parentRunId;error';
const lines = csv => csv.split('\r\n').filter(Boolean);

// Crea una ejecución con el estado indicado; input y output llevan «secretos» para comprobar que no salen
function run({ wf = 'wf_a', name = 'Facturas', status = 'success', error = null, input = { clave: 'sk-NO-EXPORTAR' }, output = { dato: 'OUT-SECRETO' } } = {}) {
  const r = Runs.create({ workflowId: wf, workflowName: name, mode: 'manual', input });
  if (status === 'waiting') Runs.setStatus(r.id, 'waiting');
  else if (status !== 'running') Runs.finish(r.id, { status, output, error });
  return Runs.get(r.id);
}

test('CSV: BOM, cabecera fija, CRLF y fechas ISO', () => {
  const r = run({ error: null });
  const csv = runsToCsv([r]);
  assert.equal(csv.charCodeAt(0), 0xfeff, 'BOM UTF-8 al inicio');
  assert.ok(csv.endsWith('\r\n'));
  const [head, row] = lines(csv.slice(1));
  assert.equal(head, HEAD);
  const cells = row.split(';');
  assert.equal(cells[0], r.id);
  assert.equal(cells[4], 'success');
  assert.equal(cells[6], new Date(r.startedAt).toISOString());
  assert.equal(cells[7], new Date(r.finishedAt).toISOString());
  assert.equal(cells[8], String(r.finishedAt - r.startedAt));
});

test('CSV: escapa el separador, las comillas y los saltos de línea', () => {
  const r = { id: 'EX-1', seq: 1, workflowId: 'w', workflowName: 'a;b "c"\nd', status: 'error', mode: 'manual', startedAt: 1000, finishedAt: 1500, parentRunId: null, error: 'x' };
  const csv = runsToCsv([r]);
  assert.ok(csv.includes(';"a;b ""c""\nd";error;manual;'), csv);
});

test('CSV: neutraliza la inyección de fórmulas (=, +, -, @, tabulador)', () => {
  const names = ['=1+1', '+1', '-2', '@SUM(A1)', 'Normal'];
  const runs = names.map((n, i) => ({ id: `EX-${i}`, seq: i, workflowId: 'w', workflowName: n, status: 'success', mode: 'manual', startedAt: 1, finishedAt: 2, parentRunId: null, error: null }));
  const csv = runsToCsv(runs);
  const got = lines(csv.slice(1)).slice(1).map(l => l.split(';')[3]);
  assert.deepEqual(got, ["'=1+1", "'+1", "'-2", "'@SUM(A1)", 'Normal']);
  const tab = runsToCsv([{ ...runs[0], workflowName: '\tx' }]);
  assert.ok(tab.includes(";'\tx;"), 'tabulador inicial');
});

test('CSV: nunca incluye input ni output de la ejecución', () => {
  const r = run({ wf: 'wf_sec', error: 'fallo' });
  const csv = runsToCsv(Runs.list({ workflowId: 'wf_sec', limit: EXPORT_MAX_ROWS }));
  assert.ok(csv.includes(r.id));
  assert.ok(!csv.includes('sk-NO-EXPORTAR'));
  assert.ok(!csv.includes('OUT-SECRETO'));
});

test('CSV: separador configurable', () => {
  assert.equal(lines(runsToCsv([], { sep: ',' }))[0].slice(1), HEAD.replaceAll(';', ','));
});

test('filtros: validan el estado y coinciden con Runs.list (mismo WHERE que el listado)', () => {
  const a = run({ wf: 'wf_f', status: 'error' });
  run({ wf: 'wf_f', status: 'success' });
  run({ wf: 'wf_g', status: 'error' });
  run({ wf: 'wf_f', status: 'waiting' });
  assert.throws(() => parseRunFilters({ status: 'desconocido' }), e => e.status === 400 && /Estado no válido/.test(e.message));
  assert.deepEqual(parseRunFilters({ workflowId: 'wf_f', status: 'error' }), { workflowId: 'wf_f', status: 'error' });
  assert.deepEqual(parseRunFilters({}), { workflowId: undefined, status: undefined });
  const f = parseRunFilters({ workflowId: 'wf_f', status: 'error' });
  const exported = Runs.list({ ...f, limit: EXPORT_MAX_ROWS });
  assert.deepEqual(exported.map(r => r.id), [a.id]);
  assert.equal(lines(runsToCsv(exported)).length, 2, 'cabecera + una fila');
});

test('la exportación no se queda en las 100 filas del listado', () => {
  for (let i = 0; i < 120; i++) run({ wf: 'wf_bulk' });
  assert.equal(Runs.list({ workflowId: 'wf_bulk' }).length, 100);
  assert.equal(Runs.list({ workflowId: 'wf_bulk', limit: EXPORT_MAX_ROWS }).length, 120);
});

// ── Integración: la ruta real en el servidor (mismo patrón que security.test.js) ──
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

test('GET /api/runs/export.csv: CSV descargable y estado no válido → 400', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/runs/export.csv`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/csv/);
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="ejecuciones-\d{8}\.csv"$/);
  // text() quitaría el BOM al decodificar: se lee como Buffer
  const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.equal(lines(text.slice(1))[0], HEAD);
  const bad = await fetch(`http://127.0.0.1:${port}/api/runs/export.csv?status=nope`);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Estado no válido/);
});
