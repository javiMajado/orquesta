import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeRepo, measure } from './bench-scenario.js';

// Umbrales del banco de medida (proveedor simulado): que ninguna mejora de tokens se pierda sin querer.
// Tabla completa: node scripts/bench-tokens.mjs
const root = makeRepo();
after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(`${root}-cache`, { recursive: true, force: true }); });

test('caché, salidas compactas y mapa del repo reducen los tokens ponderados', async () => {
  const antes = await measure(root, 'antes');
  const cache = await measure(root, 'cache');
  const texto = await measure(root, 'cache+texto');
  const mapa = await measure(root, 'cache+texto+mapa');
  assert.equal(antes.solo.cacheRead, 0, 'sin caché no se lee nada de caché');
  assert.ok(cache.solo.weighted < antes.solo.weighted * 0.6, `caché: ${cache.solo.weighted} vs ${antes.solo.weighted}`);
  assert.ok(texto.solo.weighted < cache.solo.weighted * 0.8, `texto: ${texto.solo.weighted} vs ${cache.solo.weighted}`);
  assert.ok(mapa.solo.weighted <= texto.solo.weighted, `mapa: ${mapa.solo.weighted} vs ${texto.solo.weighted}`);
  assert.ok(mapa.solo.weighted < antes.solo.weighted * 0.35, `total: ${mapa.solo.weighted} vs ${antes.solo.weighted}`);

  // Dos agentes a la vez con el mismo mapa: solo uno precalienta; el otro reutiliza la caché
  const warmed = mapa.pairLogs.filter(l => l.some(m => /Caché precalentada/.test(m)));
  assert.equal(warmed.length, 1, 'precalienta exactamente uno');
  assert.ok(mapa.pair.weighted < mapa.solo.weighted * 2, `paralelo: ${mapa.pair.weighted} vs 2 × ${mapa.solo.weighted}`);
});
