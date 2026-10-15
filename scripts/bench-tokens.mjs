// Banco de medida de tokens (proveedor simulado: sin red ni coste).
//   node scripts/bench-tokens.mjs [etiqueta]   → tabla por configuración y bench/results-<etiqueta>.json
// Tokens ponderados = entrada + 1,25 × escritos en caché + 0,1 × leídos de caché + salida (lo que cuenta
// el presupuesto ORQ_LLM_MAX_TOKENS_PER_RUN).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, measure, VARIANTS } from '../worker/test/bench-scenario.js';

const label = process.argv[2] || 'actual';
const root = makeRepo();
const rows = [];
for (const variant of Object.keys(VARIANTS)) {
  const r = await measure(root, variant);
  rows.push({ variant, solo: r.solo, pair: r.pair });
}
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(`${root}-cache`, { recursive: true, force: true });

const base = rows[0];
const pct = (v, b) => `${Math.round((1 - v / b) * 100)} %`;
const n = v => String(Math.round(v)).padStart(8);
console.log(`\nVariante              ·    entrada  leídos caché  escritos   salida  ponderados  ahorro · 2 en paralelo: ponderados  ahorro`);
for (const r of rows) {
  const s = r.solo;
  console.log(`${r.variant.padEnd(21)} · ${n(s.input)}  ${n(s.cacheRead)}    ${n(s.cacheWrite)} ${n(s.output)}  ${n(s.weighted)}   ${pct(s.weighted, base.solo.weighted).padStart(5)} ·              ${n(r.pair.weighted)}   ${pct(r.pair.weighted, base.pair.weighted).padStart(5)}`);
}
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bench');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `results-${label}.json`);
fs.writeFileSync(file, JSON.stringify({ label, rows }, null, 2));
console.log(`\nGuardado en ${path.relative(process.cwd(), file)}`);
