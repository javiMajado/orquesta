import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeAccess } from '../src/access.js';
import file from '../src/executors/file.js';
import agent from '../src/executors/agent.js';
import { loadProviders } from '../src/llm/providers.js';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orquesta-acc-')));
const repo = path.join(base, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'README.md'), 'hola');
const env = {}; // sin permisos fijos: todo viene de la UI

// Simula al usuario: responde según `answer` y apunta lo que se le pregunta
function user(answer) {
  const asked = [];
  return { asked, requestApproval: async r => { asked.push(r); return typeof answer === 'function' ? answer(r) : answer; } };
}

test('sin permiso, pregunta; «solo esta vez» vale para el resto de la tarea', async () => {
  const u = user({ approved: true, scope: 'once' });
  const a = makeAccess({ env, grants: [], requestApproval: u.requestApproval });
  assert.equal(await a.dir(repo), repo);
  assert.deepEqual(u.asked.map(r => [r.kind, r.tipo, r.carpeta, r.acceso]), [['permiso', 'carpeta', repo, 'lectura']]);
  await a.file(path.join(repo, 'src', '..', 'README.md'));
  assert.equal(u.asked.length, 1, 'no vuelve a preguntar dentro de la carpeta concedida');
  // Otra tarea empieza sin ese permiso
  const u2 = user({ approved: false, comment: 'no' });
  await assert.rejects(makeAccess({ env, grants: [], requestApproval: u2.requestApproval }).dir(repo), /denegado.*\(no\)/);
});

test('los permisos concedidos llegan con la tarea: lectura no implica escritura', async () => {
  const u = user({ approved: true });
  const a = makeAccess({ env, grants: [{ path: repo, read: true, write: false, commands: [] }], requestApproval: u.requestApproval });
  await a.file(path.join(repo, 'README.md'));
  assert.equal(u.asked.length, 0);
  await a.file(path.join(repo, 'nuevo.txt'), { write: true });
  assert.deepEqual(u.asked.map(r => r.acceso), ['escritura']);
});

test('comandos: exactos y por carpeta (también en subcarpetas)', async () => {
  const u = user({ approved: true });
  const a = makeAccess({ env, grants: [{ path: repo, read: false, write: false, commands: ['npm test'] }], requestApproval: u.requestApproval });
  assert.equal((await a.command('npm   test', path.join(repo, 'src'))).asked, false);
  const r = await a.command('npm run lint', repo);
  assert.equal(r.asked, true);
  assert.deepEqual(u.asked.map(x => [x.tipo, x.comando]), [['comando', 'npm run lint']]);
  assert.deepEqual(a.commandList().sort(), ['npm run lint', 'npm test']);
  await assert.rejects(makeAccess({ env, grants: [{ path: repo, commands: ['npm test'] }] }).command('npm test', base), /fuera de las permitidas/);
});

test('un worker que no acepta permisos del orquestador ni pregunta ni los usa', async () => {
  const u = user({ approved: true });
  const a = makeAccess({ env, grants: null, requestApproval: u.requestApproval });
  await assert.rejects(a.dir(repo), /desactivado/);
  assert.equal(u.asked.length, 0);
  assert.equal(await makeAccess({ env: { ORQ_FILES_ALLOW: repo } }).dir(repo), repo, 'el .env sigue valiendo');
});

test('nodo Fichero: escribir en una carpeta sin permiso lo pide y, si se deniega, falla', async () => {
  const target = path.join(repo, 'salida.md');
  const deny = user({ approved: false });
  await assert.rejects(file({ action: 'Escribir', path: target, content: 'x' }, null, { log: () => {}, env, access: makeAccess({ env, grants: [], requestApproval: deny.requestApproval }) }), /denegado/);
  assert.ok(!fs.existsSync(target));
  const ok = user({ approved: true, scope: 'always' });
  await file({ action: 'Escribir', path: target, content: 'x' }, null, { log: () => {}, env, access: makeAccess({ env, grants: [], requestApproval: ok.requestApproval }) });
  assert.equal(fs.readFileSync(target, 'utf8'), 'x');
});

test('agente: si acaba de pedir permiso para el comando, no vuelve a pedir aprobación de la llamada', async () => {
  const pkg = path.join(base, 'pkg');
  fs.mkdirSync(pkg);
  const CMD = 'node -e "process.exit(0)"';
  const u = user({ approved: true, scope: 'once' });
  const providers = new Map(loadProviders({}).map(p => [p.id, p]));
  const logs = [];
  await agent({ provider: 'mock', model: 'mock', tools: 'ejecutar_comando', mockOutput: 'fin', mockTools: JSON.stringify([{ name: 'ejecutar_comando', input: { comando: CMD, carpeta: pkg } }]) }, null,
    { log: m => logs.push(m), providers, requestApproval: u.requestApproval, access: makeAccess({ env, grants: [], requestApproval: u.requestApproval }) });
  assert.deepEqual(u.asked.map(r => r.kind || r.tool), ['permiso']);
  assert.ok(logs.some(l => /Código de salida 0/.test(l)), logs.join('\n'));
});
