import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema, parseSchema } from '../src/llm/json-schema.js';
import agent from '../src/executors/agent.js';
import { loadProviders } from '../src/llm/providers.js';

const SQL = {
  type: 'object',
  properties: { sql: { type: 'string', minLength: 1 }, supuestos: { type: 'array', items: { type: 'string' } }, motor: { enum: ['postgres', 'sqlite'] } },
  required: ['sql'],
  additionalProperties: false,
};

test('validador: tipos, obligatorias, propiedades no permitidas, enum y elementos de listas', () => {
  assert.deepEqual(validateSchema(SQL, { sql: 'SELECT 1', supuestos: ['x'], motor: 'postgres' }), []);
  assert.deepEqual(validateSchema(SQL, { supuestos: [1], extra: true, motor: 'mysql' }), [
    '$: falta la propiedad obligatoria «sql»',
    '$.supuestos[0]: debe ser string (es integer)',
    '$.extra: propiedad no permitida (el esquema no la incluye)',
    '$.motor: debe ser uno de "postgres", "sqlite"',
  ]);
  assert.deepEqual(validateSchema(SQL, 'texto'), ['$: debe ser object (es string)']);
  assert.deepEqual(validateSchema({ type: 'number', minimum: 0 }, 3), [], 'un entero vale como number');
  assert.equal(validateSchema({ anyOf: [{ type: 'string' }, { type: 'null' }] }, 5).length, 1);
  assert.throws(() => parseSchema('{ no es json'), /no es JSON válido/);
  assert.throws(() => parseSchema('[1]'), /debe ser un objeto/);
});

// Chat falso: devuelve las respuestas en orden y apunta lo que se le pide corregir
function fakeChat(replies) {
  const seen = { system: '', corrections: [] };
  const open = (_p, opts) => {
    seen.system = opts.system;
    let i = 0;
    return {
      next: async () => ({ text: replies[Math.min(i++, replies.length - 1)], calls: [], usage: { input: 1, output: 1 }, stop: 'end_turn' }),
      pushResults() {},
      pushCorrection(prev, msg) { seen.corrections.push({ prev, msg }); },
    };
  };
  return { open, seen };
}
const providers = new Map(loadProviders({}).map(p => [p.id, p]));
const run = (params, open) => {
  const logs = [];
  return agent({ provider: 'mock', model: 'mock', output: 'JSON', schema: JSON.stringify(SQL), ...params }, 'pregunta', { log: m => logs.push(m), providers, open })
    .then(out => ({ out, logs }));
};

test('agente con esquema: va en las instrucciones y, si la respuesta no lo cumple, se pide corrección', async () => {
  const { open, seen } = fakeChat([
    'Aquí tienes la consulta: SELECT 1',
    '{ "consulta": "SELECT 1" }',
    '```json\n{ "sql": "SELECT 1", "supuestos": ["status KO = fallido"] }\n```',
  ]);
  const { out, logs } = await run({}, open);
  assert.deepEqual(out, { sql: 'SELECT 1', supuestos: ['status KO = fallido'] });
  assert.match(seen.system, /JSON Schema[\s\S]*"required": \[\s*"sql"\s*\]/);
  assert.equal(seen.corrections.length, 2);
  assert.match(seen.corrections[0].msg, /no es JSON válido/);
  assert.match(seen.corrections[1].msg, /falta la propiedad obligatoria «sql»[\s\S]*\$\.consulta: propiedad no permitida/);
  assert.ok(logs.some(l => /se pide corrección 1\/2/.test(l)) && logs.some(l => /Respuesta corregida/.test(l)));
});

test('agente con esquema: tras 2 correcciones sin cumplirlo, el nodo falla sin reintentar', async () => {
  const { open } = fakeChat(['{ "consulta": "SELECT 1" }']);
  await assert.rejects(run({}, open), e => /no cumple el esquema JSON tras 2 correcciones/.test(e.message) && e.retryable === false);
});

test('sin esquema, la salida JSON se comporta como siempre (sin correcciones)', async () => {
  const { open, seen } = fakeChat(['{ "lo_que_sea": 1 }']);
  const { out } = await run({ schema: '' }, open);
  assert.deepEqual(out, { lo_que_sea: 1 });
  assert.equal(seen.corrections.length, 0);
  assert.doesNotMatch(seen.system, /JSON Schema/);
});
