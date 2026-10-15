import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { editText, createText } from '../src/workspace.js';
import { makeAccess } from '../src/access.js';
import format, { detectFormatter, changedFiles } from '../src/executors/format.js';
import agent from '../src/executors/agent.js';
import { loadProviders } from '../src/llm/providers.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orq-edit-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const dir = (name, files = {}) => {
  const root = path.join(tmp, name);
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }
  fs.mkdirSync(root, { recursive: true });
  return root;
};
const rw = root => makeAccess({ env: { ORQ_FILES_ALLOW: root } });
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('editar_fichero: sustituye un trozo único, respeta CRLF y BOM, y explica los errores', async () => {
  const root = dir('edit', { 'a.js': '﻿const a = 1;\r\nconst b = 2;\r\nconst b2 = 2;\r\n', 'c.js': 'x\nx\n' });
  const access = rw(root);
  const r = await editText({ ruta: path.join(root, 'a.js'), texto_antiguo: 'const b = 2;\nconst b2', texto_nuevo: 'const b = 3;\nconst b2' }, { access });
  assert.equal(r.linea, 2);
  assert.equal(read(root, 'a.js'), '﻿const a = 1;\r\nconst b = 3;\r\nconst b2 = 2;\r\n');
  await assert.rejects(editText({ ruta: path.join(root, 'a.js'), texto_antiguo: 'no está', texto_nuevo: 'y' }, { access }), /No se encuentra texto_antiguo/);
  await assert.rejects(editText({ ruta: path.join(root, 'c.js'), texto_antiguo: 'x', texto_nuevo: 'y' }, { access }), /aparece 2 veces/);
  assert.equal((await editText({ ruta: path.join(root, 'c.js'), texto_antiguo: 'x', texto_nuevo: 'y', todas: true }, { access })).sustituciones, 2);
  await assert.rejects(editText({ ruta: path.join(root, 'nuevo.js'), texto_antiguo: 'x', texto_nuevo: 'y' }, { access }), /usa crear_fichero/);
});

test('crear_fichero: crea carpetas intermedias, no pisa, y nunca en node_modules, .git ni .env', async () => {
  const root = dir('create');
  const access = rw(root);
  const r = await createText({ ruta: path.join(root, 'src', 'nuevo', 'x.js'), contenido: 'export const x = 1;\n' }, { access });
  assert.equal(r.lineas, 2);
  assert.equal(read(root, 'src/nuevo/x.js'), 'export const x = 1;\n');
  await assert.rejects(createText({ ruta: path.join(root, 'src', 'nuevo', 'x.js'), contenido: 'y' }, { access }), /Ya existe/);
  await assert.rejects(createText({ ruta: path.join(root, 'node_modules', 'p', 'i.js'), contenido: 'y' }, { access }), /node_modules/);
  await assert.rejects(createText({ ruta: path.join(root, '.env'), contenido: 'K=1' }, { access }), /secretos/);
  await assert.rejects(createText({ ruta: 'relativa.js', contenido: 'y' }, { access }), /ruta absoluta/);
});

test('sin permiso de escritura, ni edita ni crea', async () => {
  const root = dir('ro', { 'a.js': 'a' });
  const other = dir('otra');
  const access = makeAccess({ env: { ORQ_FILES_ALLOW: other } });
  await assert.rejects(editText({ ruta: path.join(root, 'a.js'), texto_antiguo: 'a', texto_nuevo: 'b' }, { access }), /fuera de las carpetas permitidas/);
  await assert.rejects(createText({ ruta: path.join(root, 'b.js'), contenido: 'b' }, { access }), /fuera de las permitidas|fuera de las carpetas permitidas/);
  assert.equal(read(root, 'a.js'), 'a');
});

test('agente: edita y crea ficheros con las herramientas', async () => {
  const root = dir('agente', { 'src/a.js': 'export const a = 1;\n' });
  const providers = new Map(loadProviders({}).map(p => [p.id, p]));
  const mockTools = JSON.stringify([[{ name: 'editar_fichero', input: { ruta: path.join(root, 'src', 'a.js'), texto_antiguo: 'a = 1', texto_nuevo: 'a = 2' } }], [{ name: 'crear_fichero', input: { ruta: path.join(root, 'src', 'b.js'), contenido: 'export const b = 1;\n' } }]]);
  const logs = [];
  await agent({ provider: 'mock', model: 'mock', tools: 'leer_fichero, editar_fichero, crear_fichero', mockTools, mockOutput: 'hecho' }, null, { log: m => logs.push(m), providers, access: rw(root) });
  assert.equal(read(root, 'src/a.js'), 'export const a = 2;\n');
  assert.equal(read(root, 'src/b.js'), 'export const b = 1;\n');
  assert.ok(!logs.some(l => /error/.test(l)), logs.join('\n'));
});

test('formateador: detección por proyecto', async () => {
  assert.deepEqual((await detectFormatter(dir('f1', { 'package.json': JSON.stringify({ scripts: { format: 'prettier --write .' } }) }))).base, 'npm run format');
  assert.equal((await detectFormatter(dir('f2', { 'package.json': JSON.stringify({ devDependencies: { prettier: '^3' } }) }))).base, 'npx prettier --write');
  assert.equal((await detectFormatter(dir('f3', { 'package.json': '{}', '.prettierrc': '{}' }))).base, 'npx prettier --write');
  assert.equal((await detectFormatter(dir('f4', { 'package.json': JSON.stringify({ devDependencies: { '@biomejs/biome': '1' } }) }))).base, 'npx biome format --write');
  assert.equal((await detectFormatter(dir('f5', { 'pyproject.toml': '[tool.ruff]\nline-length = 100' }))).base, 'ruff format');
  assert.equal((await detectFormatter(dir('f6', { 'go.mod': 'module x' }))).base, 'gofmt -w');
  assert.equal(await detectFormatter(dir('f7', { 'README.md': '#' })), null);
});

test('formatear: solo los ficheros cambiados y nuevos, con el permiso del comando base', async () => {
  const root = dir('fmt', { 'a.js': 'a\n', 'b.js': 'b\n', 'c.md': 'c\n', 'fmt.cjs': "const fs=require('fs');for(const f of process.argv.slice(2))fs.writeFileSync(f,fs.readFileSync(f,'utf8').toUpperCase());" });
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-qm', 'x');
  fs.writeFileSync(path.join(root, 'a.js'), 'cambiado\n');
  fs.writeFileSync(path.join(root, 'nuevo.js'), 'nuevo\n');
  fs.writeFileSync(path.join(root, 'raro;rm.js'), 'raro\n');
  assert.deepEqual(await changedFiles(root), ['a.js', 'nuevo.js', 'raro;rm.js']);
  const access = makeAccess({ env: { ORQ_FILES_ALLOW: root, ORQ_COMMANDS_ALLOW: 'node fmt.cjs' } });
  const logs = [];
  const r = await format({ carpeta: root, comando: 'node fmt.cjs', conFicheros: 'Sí' }, null, { log: m => logs.push(m), access });
  assert.deepEqual(r.ficheros, ['a.js', 'nuevo.js'], 'el de nombre raro no llega a la línea de comandos');
  assert.deepEqual(r.cambiados, ['a.js', 'nuevo.js']);
  assert.equal(read(root, 'a.js'), 'CAMBIADO\n');
  assert.equal(read(root, 'b.js'), 'b\n', 'los no cambiados no se tocan');
  assert.equal(read(root, 'raro;rm.js'), 'raro\n');
  // Sin permiso para ese comando (y sin poder preguntar), falla sin ejecutar nada
  const noCmd = makeAccess({ env: { ORQ_FILES_ALLOW: root } });
  await assert.rejects(format({ carpeta: root, comando: 'node fmt.cjs' }, null, { log: () => {}, access: noCmd }), /comandos desactivada|no permitido/i);
});
