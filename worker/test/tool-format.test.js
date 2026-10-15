import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtRead, fmtSearch, fmtList, fmtFind } from '../src/executors/agent.js';
import { openChat } from '../src/llm/clients.js';

test('leer_fichero: cabecera y líneas numeradas desde «desde»', () => {
  const r = { ruta: 'C:/r/a.js', lineas: '10-12 de 40', siguiente: 13, texto: 'const a = "x";\nif (a) {\n}' };
  assert.equal(fmtRead(r), '# C:/r/a.js · líneas 10-12 de 40 · siguiente: 13\n10: const a = "x";\n11: if (a) {\n12: }');
  assert.ok(fmtRead(r).length < JSON.stringify(r).length + 20);
});

test('buscar_en_ficheros: agrupado por fichero, con contexto y máx. 5 por fichero', () => {
  const resultados = [
    'src/a-b.js-9- antes', 'src/a-b.js:10: export function x()', 'src/a-b.js-11- después',
    ...Array.from({ length: 7 }, (_, i) => `src/c.js:${i * 10 + 1}: coincidencia ${i}`),
  ];
  const out = fmtSearch({ patron: 'x', coincidencias: 8, ficheros: 2, revisados: 50, resultados });
  assert.equal(out, [
    '«x» · 8 coincidencias en 2 ficheros (revisados 50)',
    'src/a-b.js', '  9- antes', '  10: export function x()', '  11- después',
    'src/c.js', ...Array.from({ length: 5 }, (_, i) => `  ${i * 10 + 1}: coincidencia ${i}`), '  (+2 más en este fichero)',
  ].join('\n'));
  assert.equal(fmtSearch({ patron: 'zzz', coincidencias: 0, ficheros: 0, revisados: 3, resultados: [] }), '«zzz» · 0 coincidencias en 0 ficheros (revisados 3)');
});

test('listar_ficheros: árbol y, si hay muchas entradas, carpetas profundas resumidas', () => {
  const r = { carpeta: 'C:/r', profundidad: 3, truncado: false, entradas: ['README.md', 'node_modules/ (omitida)', 'src/', 'src/a.js', 'src/lib/', 'src/lib/b.js'] };
  assert.equal(fmtList(r), '# C:/r · 6 entradas\nREADME.md\nnode_modules/ (omitida)\nsrc/\n  a.js\n  lib/\n    b.js');
  const many = { carpeta: 'C:/r', profundidad: 2, truncado: false, entradas: ['pkg/', ...Array.from({ length: 400 }, (_, i) => `pkg/f${i}.js`)] };
  assert.equal(fmtList(many), '# C:/r · 401 entradas\npkg/ (400 entradas)');
});

test('buscar_ficheros: una ruta por línea', () => {
  assert.equal(fmtFind({ carpeta: 'C:/r', patron: '*.js', total: 2, truncado: false, ficheros: ['a.js', 'b/c.js'] }), '# «*.js» en C:/r: 2 ficheros\na.js\nb/c.js');
});

test('recorte del historial (simulado/OpenAI): por lotes, sin tocar los 5 últimos turnos', async () => {
  const prev = process.env.ORQ_LLM_COMPACT_AT;
  process.env.ORQ_LLM_COMPACT_AT = '20000';
  try {
    const turns = Array.from({ length: 8 }, (_, i) => [{ name: 'leer_fichero', input: { ruta: `C:/r/f${i}.js` } }]);
    const chat = openChat({ kind: 'mock' }, { user: 'hola', tools: [], mockTools: JSON.stringify(turns) });
    let dropped = 0;
    for (let i = 0; i < 8; i++) {
      const r = await chat.next();
      chat.pushResults(r.calls.map(c => ({ id: c.id, content: 'x'.repeat(3000) })));
      dropped += chat.compact();
    }
    // 8 resultados de 3 000 caracteres: al pasar de 20 000 se recortan los de hace más de 5 turnos
    assert.ok(dropped >= 1 && dropped <= 3, `recortados: ${dropped}`);
    const before = (await chat.next()).usage;
    assert.ok(before.cacheRead + before.cacheWrite + before.input < (8 * 3000) / 4, 'el historial ocupa menos que sin recortar');
  } finally {
    if (prev == null) delete process.env.ORQ_LLM_COMPACT_AT; else process.env.ORQ_LLM_COMPACT_AT = prev;
  }
});
