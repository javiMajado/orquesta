import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import agent, { resetWarmup } from '../src/executors/agent.js';
import { clearMockCache } from '../src/llm/clients.js';
import { loadProviders } from '../src/llm/providers.js';
import { makeAccess } from '../src/access.js';

// Banco de medida de tokens con el proveedor simulado (sin red ni coste): un repositorio de prueba de
// ~300 ficheros y un agente tipo «Revisor» con un guion fijo de herramientas. Lo usan
// worker/test/token-bench.test.js (umbrales) y scripts/bench-tokens.mjs (tabla de resultados).

const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

export function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orq-bench-')));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w('package.json', JSON.stringify({ name: 'tienda', private: true, workspaces: ['packages/*'], scripts: { test: 'node --test', dev: 'node server/index.js', build: 'vite build' } }, null, 2));
  w('README.md', `# Tienda\n\nAplicación de ejemplo.\n\n## Arquitectura\n${lines(40, i => `Párrafo ${i} sobre la arquitectura de la tienda, módulos y convenciones del proyecto.`)}\n\n## Puesta en marcha\nnpm install && npm run dev\n`);
  w('CLAUDE.md', `# Contexto para agentes\n\n## Estructura\n${lines(30, i => `- \`packages/m${i}/\` — módulo ${i}: pedidos, pagos y exportación de informes.`)}\n\n## Comandos\nnpm test · npm run dev\n`);
  w('.env', 'SECRET_TOKEN=no-deberia-verse');
  for (let m = 0; m < 30; m++) {
    w(`packages/m${m}/package.json`, JSON.stringify({ name: `@tienda/m${m}`, scripts: { test: 'node --test' } }));
    for (let f = 0; f < 8; f++) {
      w(`packages/m${m}/src/f${f}.js`, lines(120, i => (i % 17 === 0 ? `export function exportRuns${m}_${f}_${i}(rows) { return toCsv(rows); }` : `const v${i} = calcular(${m}, ${f}, ${i}); // lógica del módulo ${m}`)));
    }
    w(`packages/m${m}/test/m${m}.test.js`, lines(40, i => `test('caso ${i}', () => assert.ok(exportRuns${m}_0_0));`));
  }
  const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', 'commit', '-q', '-m', 'inicio']);
  return root;
}

const PROMPT = 'Eres un desarrollador senior haciendo code review. Explora el repositorio centrándote en el foco indicado (como mucho 20 ficheros leídos). Busca errores de lógica, manejo de errores, duplicación, nombres confusos y código difícil de mantener. Cita solo ficheros que hayas visto.\n\n' + lines(12, i => `Regla ${i + 1}: comprueba con cuidado el aspecto ${i + 1} del código antes de dar un hallazgo y explica el motivo con precisión.`);

// Guion de un agente que explora: sin mapa empieza listando la raíz y leyendo README y CLAUDE.md
export function script(root, { map }) {
  const p = rel => path.join(root, rel);
  const explore = [
    [{ name: 'listar_ficheros', input: { ruta: root, profundidad: 2 } }],
    [{ name: 'leer_fichero', input: { ruta: p('README.md') } }],
    [{ name: 'leer_fichero', input: { ruta: p('CLAUDE.md') } }],
  ];
  const work = [
    [{ name: 'buscar_en_ficheros', input: { ruta: root, patron: 'exportRuns|toCsv', regex: true } }],
    [{ name: 'buscar_ficheros', input: { ruta: root, patron: '**/*.test.js' } }],
    [{ name: 'leer_fichero', input: { ruta: p('packages/m3/src/f2.js') } }, { name: 'leer_fichero', input: { ruta: p('packages/m3/test/m3.test.js') } }],
    [{ name: 'leer_fichero', input: { ruta: p('packages/m7/src/f0.js'), desde: 1, lineas: 80 } }],
    [{ name: 'buscar_en_ficheros', input: { ruta: root, patron: 'calcular\\(7', regex: true, contexto: 2 } }],
    [{ name: 'leer_fichero', input: { ruta: p('packages/m7/src/f1.js') } }],
    [{ name: 'leer_fichero', input: { ruta: p('packages/m12/src/f4.js') } }, { name: 'leer_fichero', input: { ruta: p('packages/m12/src/f5.js') } }],
    [{ name: 'buscar_en_ficheros', input: { ruta: root, patron: 'exportRuns12', incluir: 'packages/m12/**' } }],
    [{ name: 'leer_fichero', input: { ruta: p('packages/m20/src/f3.js') } }],
  ];
  return map ? work : [...explore, ...work];
}

// Configuraciones a comparar, acumulativas
export const VARIANTS = {
  antes: { cache: false, json: true, map: false },
  'cache': { cache: true, json: true, map: false },
  'cache+texto': { cache: true, json: false, map: false },
  'cache+texto+mapa': { cache: true, json: false, map: true },
};

const providers = new Map(loadProviders({}).map(p => [p.id, p]));

export async function runAgent(root, variant, { prompt = PROMPT } = {}) {
  const v = VARIANTS[variant];
  const prev = { cache: process.env.ORQ_LLM_PROMPT_CACHE, out: process.env.ORQ_TOOL_OUTPUT, dir: process.env.ORQ_WORKER_CACHE_DIR };
  process.env.ORQ_LLM_PROMPT_CACHE = v.cache ? '' : 'off';
  process.env.ORQ_TOOL_OUTPUT = v.json ? 'json' : '';
  process.env.ORQ_WORKER_CACHE_DIR = path.join(root, '..', `${path.basename(root)}-cache`);
  let meta = null;
  const logs = [];
  try {
    await agent({
      provider: 'mock', model: 'mock', prompt, output: 'JSON', maxTurns: '30',
      tools: 'listar_ficheros, buscar_ficheros, buscar_en_ficheros, leer_fichero',
      input: `Repositorio: ${root}\nFoco: exportación de informes`,
      ...(v.map ? { repo: root } : {}),
      mockTools: JSON.stringify(script(root, v)), mockOutput: '{ "veredicto": "ok", "resumen": "sin hallazgos", "hallazgos": [] }',
    }, null, { log: m => logs.push(m), setMeta: m => { meta = m; }, providers, access: makeAccess({ env: { ORQ_FILES_ALLOW: root } }) });
  } finally {
    process.env.ORQ_LLM_PROMPT_CACHE = prev.cache ?? '';
    process.env.ORQ_TOOL_OUTPUT = prev.out ?? '';
    if (prev.dir == null) delete process.env.ORQ_WORKER_CACHE_DIR; else process.env.ORQ_WORKER_CACHE_DIR = prev.dir;
  }
  return { usage: meta.usage, logs };
}

// Un agente solo, y dos a la vez (revisión + seguridad, con distinto prompt) sobre el mismo repo
export async function measure(root, variant) {
  clearMockCache(); resetWarmup();
  const solo = await runAgent(root, variant);
  clearMockCache(); resetWarmup();
  const pair = await Promise.all([runAgent(root, variant), runAgent(root, variant, { prompt: `${PROMPT}\n\nCéntrate además en la seguridad: inyecciones, secretos y permisos.` })]);
  const sum = k => pair.reduce((n, r) => n + (r.usage[k] || 0), 0);
  return {
    solo: solo.usage,
    pair: { input: sum('input'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), output: sum('output'), weighted: sum('weighted') },
    pairLogs: pair.map(r => r.logs),
  };
}
