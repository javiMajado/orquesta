import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeInputs, validateInput, effectiveValues, buildTriggerInput, valuesFromInput, inferFields,
  flattenTestInput, missingRequired, caseSummary, diffFromCommon, checkExpectations, parseCsv, coerce,
} from '../src/inputs.js';

const N = (id, type, params = {}, name = id) => ({ id, type, name, params });
const E = (from, to, port = 'out') => ({ id: `${from}-${to}`, from, to, port });
const hook = N('t', 'webhook', { method: 'POST', path: '/tickets' }, 'Ticket entrante');
const paths = r => r.used.map(u => u.path).sort();

test('$json tras el disparador cuenta', () => {
  const g = { nodes: [hook, N('a', 'http', { url: 'https://x/{{ $json.body.email }}' })], edges: [E('t', 'a')] };
  assert.deepEqual(paths(analyzeInputs(g, 't')), ['body.email']);
});

test('$json tras un agente no cuenta', () => {
  const g = { nodes: [hook, N('a', 'agent', { input: 'x' }), N('b', 'email', { to: '{{ $json.cliente }}', body: 'y' })], edges: [E('t', 'a'), E('a', 'b')] };
  assert.deepEqual(paths(analyzeInputs(g, 't')), []);
});

test('$json tras Condición o Aprobación sigue siendo la entrada', () => {
  const g = {
    nodes: [hook, N('c', 'if', { expr: '$json.body.vip === true' }), N('ap', 'approval', {}), N('m', 'email', { to: '{{ $json.body.email }}', body: 'x' })],
    edges: [E('t', 'c'), E('c', 'ap', 'true'), E('ap', 'm')],
  };
  assert.deepEqual(paths(analyzeInputs(g, 't')), ['body.email', 'body.vip']);
});

test('$node["disparador"] cuenta en cualquier nodo', () => {
  const g = {
    nodes: [hook, N('a', 'agent', { input: 'x' }), N('d', 'db', { params: `{{ [$node["Ticket entrante"].body.producto] }}` })],
    edges: [E('t', 'a'), E('a', 'd')],
  };
  const r = analyzeInputs(g, 't');
  assert.deepEqual(paths(r), ['body.producto']);
  assert.deepEqual(r.used[0].nodes, ['d']);
});

test('$json entero y $json[k] son dinámicos', () => {
  const g = { nodes: [hook, N('a', 'agent', { input: '{{ $json }}' }), N('b', 'node', { code: 'return $json[k]' })], edges: [E('t', 'a'), E('t', 'b')] };
  const r = analyzeInputs(g, 't');
  assert.deepEqual(r.dynamic.map(d => d.nodeId).sort(), ['a', 'b']);
  assert.equal(r.dynamic.find(d => d.nodeId === 'b').reason, 'acceso calculado');
});

test('agente con entrada vacía tras el disparador = dinámico', () => {
  const g = { nodes: [hook, N('a', 'agent', { input: '' })], edges: [E('t', 'a')] };
  assert.equal(analyzeInputs(g, 't').dynamic[0].nodeId, 'a');
});

test('no declarados e ignorados', () => {
  const t = { ...hook, params: { ...hook.params, inputFields: [{ key: 'email', path: 'body.email', type: 'email', required: true }], ignoredInputs: ['body.x'] } };
  const g = { nodes: [t, N('a', 'http', { url: '{{ $json.body.email }}{{ $json.body.x }}{{ $json.body.producto }}' })], edges: [E('t', 'a')] };
  assert.deepEqual(analyzeInputs(g, 't').undeclared.map(u => u.key), ['producto']);
});

test('valores efectivos con removed', () => {
  const ds = { common: { canal: 'Web', email: 'a@b.c' } };
  assert.deepEqual(effectiveValues(ds, { values: { asunto: 'x' }, removed: ['email'] }), { canal: 'Web', asunto: 'x' });
});

test('entrada construida y valores de vuelta', () => {
  const fields = [{ key: 'email', path: 'body.email' }];
  const input = buildTriggerInput(hook, fields, { email: 'a@b.c', extra: 1 });
  assert.deepEqual(input.body, { email: 'a@b.c', extra: 1 });
  assert.equal(input.method, 'POST');
  assert.deepEqual(valuesFromInput(hook, fields, input), { email: 'a@b.c', extra: 1 });
});

test('validación por tipo', () => {
  const f = [
    { key: 'e', type: 'email', required: true }, { key: 'n', type: 'number' }, { key: 'o', type: 'option', options: ['A'] },
    { key: 'l', type: 'list' }, { key: 'r', type: 'text', required: true },
  ];
  const errs = validateInput(f, { e: 'no', n: 'x', o: 'B', l: 'x', r: '' });
  assert.deepEqual(errs.map(e => `${e.key}:${e.message}`), ['e:No es un email válido', 'n:Debe ser un número', 'o:Valor no permitido', 'l:Debe ser una lista', 'r:Obligatorio']);
  assert.deepEqual(validateInput(f, { e: 'a@b.c', n: '3', o: 'A', l: [], r: 'ok' }), []);
});

test('obligatorios que faltan y resumen', () => {
  const fields = [{ key: 'email', required: true }, { key: 'vip', type: 'boolean' }];
  const ds = { common: { vip: false } };
  assert.deepEqual(missingRequired(fields, ds, { values: {} }), ['email']);
  assert.deepEqual(missingRequired(fields, ds, { values: {}, expectError: true }), []);
  assert.equal(caseSummary(fields, ds, { values: { vip: true } }), 'cambia: vip → Sí');
  assert.equal(caseSummary(fields, { common: { email: 'x' } }, { values: {}, removed: ['email'], expectError: true }), 'quita: email · debe fallar');
});

test('diferencias con los comunes', () => {
  assert.deepEqual(diffFromCommon({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }), { values: { b: 3, c: 4 }, removed: [] });
  assert.deepEqual(diffFromCommon({ a: 1 }, { a: '' }), { values: {}, removed: ['a'] });
});

test('expectativas', () => {
  const steps = [{ nodeName: 'Analista', status: 'success', output: { prioridad: 'alta' } }, { nodeName: 'Revisión', status: 'success' }];
  const ok = checkExpectations({ expect: [{ type: 'visits', node: 'Revisión' }, { type: 'equals', node: 'Analista', path: 'prioridad', value: 'alta' }] }, { status: 'success' }, steps);
  assert.equal(ok.pass, true);
  const ko = checkExpectations({ expect: [{ type: 'equals', node: 'Analista', path: 'prioridad', value: 'baja' }] }, { status: 'success' }, steps);
  assert.equal(ko.pass, false);
  assert.equal(checkExpectations({ expectError: true }, { status: 'error' }, []).pass, true);
});

test('inferir, aplanar, CSV y conversión', () => {
  assert.deepEqual(inferFields(hook, { body: { email: 'a@b.c', vip: true } }).map(f => `${f.key}:${f.type}:${f.path}`), ['email:email:body.email', 'vip:boolean:body.vip']);
  assert.deepEqual(flattenTestInput(hook, { body: { a: 1 } }), { a: 1 });
  assert.deepEqual(parseCsv('_name;email\n"Uno; dos";a@b.c\n'), [{ _name: 'Uno; dos', email: 'a@b.c' }]);
  assert.equal(coerce({ type: 'boolean' }, 'Sí'), true);
  assert.deepEqual(coerce({ type: 'list' }, 'a|b'), ['a', 'b']);
});
