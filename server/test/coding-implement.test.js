import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateEnv } from './helpers.js';

isolateEnv();
const { CODING } = await import('../src/seed-coding.js');
const { render } = await import('@orquesta/shared/expr');

const wf = CODING.codingImplement();
const byName = n => wf.graph.nodes.find(x => x.name === n);
const branch = (body, arquitecto = {}) => render(byName('Crear rama').params.comando, { $json: arquitecto, $node: { Inicio: { body }, Arquitecto: arquitecto } });

test('Implementar feature: nombre de rama seguro para la línea de comandos', () => {
  assert.equal(branch({ rama: 'fix/login-roto' }), 'git switch -c fix/login-roto', 'la de body.rama manda');
  assert.equal(branch({ rama: '' , feature: 'x' }, { rama: 'feature/exportar-csv' }), 'git switch -c feature/exportar-csv', 'si no, la del Arquitecto');
  assert.equal(branch({ feature: 'Exportar ejecuciones a CSV (con filtros) ÁÉÍ' }), 'git switch -c feature/exportar-ejecuciones-a-csv-con-filtros-aei');
  // Nada que la shell pueda interpretar: ; & | $ ` comillas, espacios, «..»
  assert.equal(branch({ rama: 'Mi Rama; rm -rf / && echo $HOME `x` "y"' }), 'git switch -c feature/mi-rama-rm-rf/echo-home-x-y');
  assert.equal(branch({ rama: '../../etc' }), 'git switch -c feature/etc');
  assert.equal(branch({ rama: '-x' }), 'git switch -c feature/x', 'nunca empieza por «-»');
  assert.equal(branch({ rama: '!!!' }), 'git switch -c feature/nueva');
  assert.ok(branch({ rama: 'a'.repeat(200) }).length <= 'git switch -c feature/'.length + 60);
});

test('Implementar feature: grafo completo y cambios sin confirmar → se para', () => {
  const ids = new Set(wf.graph.nodes.map(n => n.id));
  for (const e of wf.graph.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `arista ${e.id}`);
  const ifNode = byName('¿Sin cambios?');
  assert.deepEqual(wf.graph.edges.filter(e => e.from === ifNode.id).map(e => [e.port, wf.graph.nodes.find(n => n.id === e.to).name]).sort(),
    [['false', 'Hay cambios sin confirmar'], ['true', 'Arquitecto']]);
  assert.equal(byName('Implementador').params.repo, '{{ $node["Inicio"].body.repo }}');
  assert.equal(byName('Formatear').type, 'format');
});
