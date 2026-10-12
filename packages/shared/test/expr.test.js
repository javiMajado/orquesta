import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, renderParams } from '../src/expr.js';
import { parseDuration } from '../src/types.js';

const ctx = { $json: { a: 1, b: 'x', list: [1, 2] }, $node: { Lector: { cliente: 'm@a.io' } } };

test('una expresión completa devuelve el valor tal cual', () => {
  assert.deepEqual(render('{{ $json.list }}', ctx), [1, 2]);
});
test('varias expresiones se interpolan como texto', () => {
  assert.equal(render('{{ $json.a }} y {{ $json.b }}', ctx), '1 y x');
});
test('acceso a otros nodos', () => {
  assert.equal(render('Para: {{ $node["Lector"].cliente }}', ctx), 'Para: m@a.io');
});
test('renderParams respeta los campos excluidos', () => {
  assert.deepEqual(renderParams({ code: '{{ x }}', to: '{{ $json.b }}' }, ctx, ['code']), { code: '{{ x }}', to: 'x' });
});
test('parseDuration', () => {
  assert.equal(parseDuration('90 s'), 90000);
  assert.equal(parseDuration('5 minutos'), 300000);
  assert.equal(parseDuration('4 h'), 14400000);
});
