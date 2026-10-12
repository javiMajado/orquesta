import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import file from '../src/executors/file.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orquesta-file-'));
const allowed = path.join(base, 'permitida');
const outside = path.join(base, 'fuera');
fs.mkdirSync(allowed); fs.mkdirSync(outside);
fs.writeFileSync(path.join(allowed, 'doc.txt'), '﻿hola\nmundo');
fs.writeFileSync(path.join(outside, 'secreto.txt'), 'no');
const env = { ORQ_FILES_ALLOW: allowed };
const ctx = { log: () => {}, env };
const run = p => file(p, null, ctx);

test('lee un fichero dentro de la carpeta permitida (sin BOM)', async () => {
  const r = await run({ action: 'Leer', path: path.join(allowed, 'doc.txt') });
  assert.equal(r.contenido, 'hola\nmundo');
  assert.equal(r.nombre, 'doc.txt');
});

test('sin ORQ_FILES_ALLOW el nodo está desactivado', async () => {
  await assert.rejects(file({ action: 'Leer', path: path.join(allowed, 'doc.txt') }, null, { log: () => {}, env: {} }), /desactivado/);
});

test('no sale de la carpeta: ruta ajena, «..», relativa o la propia carpeta', async () => {
  await assert.rejects(run({ action: 'Leer', path: path.join(outside, 'secreto.txt') }), /fuera de las carpetas/);
  await assert.rejects(run({ action: 'Leer', path: path.join(allowed, '..', 'fuera', 'secreto.txt') }), /fuera de las carpetas/);
  await assert.rejects(run({ action: 'Leer', path: 'doc.txt' }), /ruta absoluta/);
  await assert.rejects(run({ action: 'Escribir', path: path.join(outside, 'x.txt'), content: 'x' }), /fuera de las carpetas/);
  await assert.rejects(run({ action: 'Leer', path: allowed }), /fuera de las carpetas/);
  // Una carpeta hermana con el mismo prefijo no cuenta como «dentro»
  fs.mkdirSync(allowed + '-bis');
  fs.writeFileSync(path.join(allowed + '-bis', 'x.txt'), 'x');
  await assert.rejects(run({ action: 'Leer', path: path.join(allowed + '-bis', 'x.txt') }), /fuera de las carpetas/);
});

test('escribir: por defecto no sobrescribe; Sobrescribir y Añadir funcionan; no crea carpetas', async () => {
  const out = path.join(allowed, 'salida.md');
  await run({ action: 'Escribir', path: out, content: 'uno' });
  await assert.rejects(run({ action: 'Escribir', path: out, content: 'dos' }), /Ya existe/);
  await run({ action: 'Escribir', path: out, content: 'dos', ifExists: 'Sobrescribir' });
  await run({ action: 'Escribir', path: out, content: '+', ifExists: 'Añadir' });
  assert.equal(fs.readFileSync(out, 'utf8'), 'dos+');
  await run({ action: 'Escribir', path: path.join(allowed, 'obj.json'), content: { a: 1 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(allowed, 'obj.json'), 'utf8')), { a: 1 });
  await assert.rejects(run({ action: 'Escribir', path: path.join(allowed, 'nueva', 'x.txt'), content: 'x' }), /No existe la carpeta/);
});

// PDF mínimo válido con el texto dado (una página, Helvetica)
function makePdf(text) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('lee el texto de un PDF', async () => {
  const pdf = path.join(allowed, 'doc.pdf');
  fs.writeFileSync(pdf, makePdf('Hola desde un PDF'));
  const r = await run({ action: 'Leer', path: pdf });
  assert.match(r.contenido, /Hola desde un PDF/);
  assert.equal(r.paginas, 1);
  fs.writeFileSync(path.join(allowed, 'roto.pdf'), 'no soy un pdf');
  await assert.rejects(run({ action: 'Leer', path: path.join(allowed, 'roto.pdf') }), /No se pudo abrir el PDF/);
});

test('límite de tamaño', async () => {
  const small = { log: () => {}, env: { ...env, ORQ_FILES_MAX_BYTES: '3' } };
  await assert.rejects(file({ action: 'Leer', path: path.join(allowed, 'doc.txt') }, null, small), /límite/);
  await assert.rejects(file({ action: 'Escribir', path: path.join(allowed, 'big.txt'), content: 'abcdef' }, null, small), /límite/);
});
