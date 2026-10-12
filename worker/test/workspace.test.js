import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orquesta-ws-'));
const repo = path.join(base, 'repo');
const outside = path.join(base, 'fuera');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.mkdirSync(path.join(repo, 'node_modules', 'x'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(repo, 'README.md'), 'uno\ndos\ntres\ncuatro');
fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const a = 1;');
fs.writeFileSync(path.join(repo, '.env'), 'SECRETO=1');
fs.writeFileSync(path.join(repo, '.env.example'), 'SECRETO=');
fs.writeFileSync(path.join(repo, 'img.bin'), Buffer.from([1, 0, 2]));
fs.writeFileSync(path.join(outside, 'x.txt'), 'no');

// Comandos de prueba: node con código de salida y con eco de variables de entorno
const EXIT3 = 'node -e "console.log(\'hola\'), process.exit(3)"';
const ENV = 'node -e "console.log(process.env.ANTHROPIC_API_KEY || \'sin-clave\', process.env.ORQ_TEST_VAR || \'sin-orq\')"';
Object.assign(process.env, { ORQ_FILES_ALLOW: repo, ORQ_COMMANDS_ALLOW: `${EXIT3}; ${ENV}`, ANTHROPIC_API_KEY: 'sk-falsa', ORQ_TEST_VAR: 'x' });

const W = await import('../src/workspace.js');
const { default: command } = await import('../src/executors/command.js');
const { default: agent } = await import('../src/executors/agent.js');
const { loadProviders } = await import('../src/llm/providers.js');

test('listar_ficheros: recorre la carpeta permitida y omite node_modules', async () => {
  const r = await W.listFiles({ ruta: repo });
  assert.ok(r.entradas.includes('README.md'));
  assert.ok(r.entradas.includes('src/app.js'));
  assert.ok(r.entradas.includes('node_modules/ (omitida)'));
  assert.ok(!r.entradas.some(e => e.startsWith('node_modules/x')));
  await assert.rejects(W.listFiles({ ruta: outside }), /fuera de las permitidas/);
  await assert.rejects(W.listFiles({ ruta: path.join(repo, '..') }), /fuera de las permitidas/);
});

test('leer_fichero: por tramos, sin secretos ni binarios ni fuera de la carpeta', async () => {
  const r = await W.readText({ ruta: path.join(repo, 'README.md'), desde: 2, lineas: 2 });
  assert.equal(r.texto, 'dos\ntres');
  assert.equal(r.lineas, '2-3 de 4');
  assert.equal(r.siguiente, 4);
  await assert.rejects(W.readText({ ruta: path.join(repo, '.env') }), /secretos/);
  assert.equal((await W.readText({ ruta: path.join(repo, '.env.example') })).texto, 'SECRETO=');
  await assert.rejects(W.readText({ ruta: path.join(repo, 'img.bin') }), /binario/);
  await assert.rejects(W.readText({ ruta: path.join(outside, 'x.txt') }), /fuera de las carpetas/);
});

test('comandos: solo los de la lista exacta y en una carpeta permitida', async () => {
  await assert.rejects(W.checkCommand({ comando: 'npm test', carpeta: repo }), /no permitido/);
  await assert.rejects(W.checkCommand({ comando: `${EXIT3} && del *`, carpeta: repo }), /no permitido/);
  await assert.rejects(W.checkCommand({ comando: EXIT3, carpeta: outside }), /fuera de las permitidas/);
  await assert.rejects(W.checkCommand({ comando: EXIT3, carpeta: repo }, { env: { ORQ_FILES_ALLOW: repo } }), /desactivada/);
});

test('nodo Comando: devuelve código y salida; con «Fallar» = Sí, falla si no es 0', async () => {
  const ctx = { log: () => {}, timeoutMs: 30000 };
  const r = await command({ comando: EXIT3, carpeta: repo, failOnError: 'No' }, null, ctx);
  assert.equal(r.codigo, 3);
  assert.equal(r.ok, false);
  assert.match(r.salida, /hola/);
  await assert.rejects(command({ comando: EXIT3, carpeta: repo, failOnError: 'Sí' }, null, ctx), /código 3/);
});

test('al comando no le llegan las variables con secretos ni las ORQ_*', async () => {
  const r = await command({ comando: ENV, carpeta: repo }, null, { log: () => {}, timeoutMs: 30000 });
  assert.match(r.salida, /sin-clave sin-orq/);
});

// Agente con el proveedor simulado que «pide» herramientas de verdad (mockTools)
const providers = new Map(loadProviders({}).map(p => [p.id, p]));
const run = (params, extra = {}) => {
  const logs = [];
  return agent({ provider: 'mock', model: 'mock', ...params }, null, { log: m => logs.push(m), providers, ...extra }).then(out => ({ out, logs }));
};

test('agente: usa listar_ficheros y leer_fichero sin pedir aprobación', async () => {
  const asked = [];
  const { logs } = await run({
    tools: 'listar_ficheros, leer_fichero', mockOutput: 'fin',
    mockTools: JSON.stringify([{ name: 'listar_ficheros', input: { ruta: repo } }, { name: 'leer_fichero', input: { ruta: path.join(repo, 'README.md') } }]),
  }, { requestApproval: r => { asked.push(r); return { approved: true }; } });
  assert.equal(asked.length, 0);
  assert.ok(!logs.some(l => /error/.test(l)), logs.join('\n'));
});

test('agente: una herramienta no habilitada en el nodo no se ejecuta', async () => {
  const { logs } = await run({ tools: 'leer_fichero', mockTools: JSON.stringify([{ name: 'ejecutar_comando', input: { comando: EXIT3, carpeta: repo } }]) });
  assert.ok(logs.some(l => /no habilitada/.test(l)));
});

test('agente: ejecutar_comando pide aprobación; si se rechaza no se ejecuta', async () => {
  const asked = [];
  const mockTools = JSON.stringify([{ name: 'ejecutar_comando', input: { comando: EXIT3, carpeta: repo } }]);
  let r = await run({ tools: 'ejecutar_comando', mockTools }, { requestApproval: q => { asked.push(q); return { approved: false, comment: 'hoy no' } } });
  assert.deepEqual(asked.map(q => [q.tool, q.comando]), [['ejecutar_comando', EXIT3]]);
  assert.ok(r.logs.some(l => /rechazó.*hoy no/.test(l)));
  assert.ok(!r.logs.some(l => /^\$ /.test(l)), 'no se lanzó el comando');

  r = await run({ tools: 'ejecutar_comando', mockTools }, { requestApproval: () => ({ approved: true, by: 'ana' }) });
  assert.ok(r.logs.some(l => /^\$ /.test(l)));
  assert.ok(r.logs.some(l => /Código de salida 3/.test(l)));

  // Un comando fuera de la lista ni siquiera llega a pedir aprobación
  asked.length = 0;
  r = await run({ tools: 'ejecutar_comando', mockTools: JSON.stringify([{ name: 'ejecutar_comando', input: { comando: 'rm -rf /', carpeta: repo } }]) }, { requestApproval: q => { asked.push(q); return { approved: true }; } });
  assert.equal(asked.length, 0);
  assert.ok(r.logs.some(l => /no permitido/.test(l)));
});

test('agente: con «Aprobar cada comando» = No se ejecuta sin preguntar', async () => {
  const { logs } = await run({ tools: 'ejecutar_comando', approveTools: 'No', mockTools: JSON.stringify([{ name: 'ejecutar_comando', input: { comando: EXIT3, carpeta: repo } }]) });
  assert.ok(logs.some(l => /Código de salida 3/.test(l)));
});

test('buscar_en_ficheros: texto, regex, filtros y contexto; nunca node_modules, secretos ni binarios', async () => {
  fs.mkdirSync(path.join(repo, 'src', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'runs', 'export.js'), 'import x from "y";\nexport function exportRunsCsv(runs) {\n  return runs.map(r => r.id).join(",");\n}\n');
  fs.writeFileSync(path.join(repo, 'node_modules', 'x', 'index.js'), 'export function exportRunsCsv() {}');
  fs.writeFileSync(path.join(repo, '.env'), 'EXPORT_TOKEN=secreto');
  let r = await W.searchText({ ruta: repo, patron: 'exportRunsCsv' });
  assert.deepEqual(r.resultados, ['src/runs/export.js:2: export function exportRunsCsv(runs) {']);
  r = await W.searchText({ ruta: repo, patron: 'EXPORT' });
  assert.ok(!r.resultados.some(l => l.startsWith('.env') || l.includes('node_modules')), 'ni .env ni node_modules');
  assert.ok(!r.resultados.some(l => l.startsWith('img.bin')), 'ni binarios');
  r = await W.searchText({ ruta: repo, patron: 'export|csv', regex: true, incluir: '*.js', contexto: 1 });
  assert.ok(r.resultados.includes('src/runs/export.js-1- import x from "y";'));
  assert.ok(r.resultados.includes('src/runs/export.js-3- return runs.map(r => r.id).join(",");'), 'la línea siguiente, como contexto');
  assert.equal((await W.searchText({ ruta: repo, patron: 'export', mayusculas: true, incluir: 'README.md' })).coincidencias, 0);
  r = await W.searchText({ ruta: repo, patron: 'e', maxResultados: 2 });
  assert.equal(r.resultados.length, 2);
  assert.equal(r.truncado, true);
  await assert.rejects(W.searchText({ ruta: repo, patron: '(' , regex: true }), /no válida/);
  await assert.rejects(W.searchText({ ruta: outside, patron: 'no' }), /fuera de las permitidas/);
});

test('buscar_ficheros: globs por nombre y por ruta', async () => {
  assert.deepEqual((await W.findFiles({ ruta: repo, patron: '*export*' })).ficheros, ['src/runs/export.js']);
  assert.deepEqual((await W.findFiles({ ruta: repo, patron: 'src/**/*.js' })).ficheros, ['src/app.js', 'src/runs/export.js']);
  assert.deepEqual((await W.findFiles({ ruta: repo, patron: '{README.md,package.json}' })).ficheros, ['README.md']);
  assert.ok(!(await W.findFiles({ ruta: repo, patron: '**/*' })).ficheros.some(f => f.includes('node_modules') || f === '.env'));
});
