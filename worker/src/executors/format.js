import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { runCommand } from '../workspace.js';

// Nodo «Formatear código»: aplica el formateador DEL PROYECTO a los ficheros cambiados (git diff respecto
// a HEAD + ficheros nuevos sin versionar). Así el estilo lo decide la herramienta del repo y no un LLM.
// Detección, por orden: script «format» de package.json (todo el proyecto, como lo defina el repo);
// Biome o Prettier en las dependencias o con su configuración; ruff / black (pyproject.toml); gofmt (go.mod).
// El permiso es el del comando base («npx prettier --write»…): se pide una vez por carpeta y después los
// ficheros se añaden como argumentos (solo rutas con caracteres seguros, nunca empezando por «-»).
// Salida: { formateador, motivo, ficheros, cambiados, todos, codigo?, salida? }

const fail = msg => Object.assign(new Error(msg), { retryable: false });
const git = (root, args) => new Promise(resolve => execFile('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 30000 }, (err, out) => resolve(err ? null : out)));
const read = (root, rel) => fs.readFile(path.join(root, rel), 'utf8').catch(() => null);
const exists = (root, rel) => fs.stat(path.join(root, rel)).then(() => true, () => false);

const WEB = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc', 'css', 'scss', 'less', 'html', 'vue', 'svelte', 'md', 'mdx', 'yml', 'yaml', 'graphql'];
const BIOME = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc', 'css'];
const SAFE = /^[A-Za-z0-9._@+\/-]+$/;

export async function detectFormatter(root) {
  let json = null;
  const raw = await read(root, 'package.json');
  if (raw) { try { json = JSON.parse(raw); } catch {} }
  if (json?.scripts?.format) return { base: 'npm run format', files: false, motivo: 'script «format» de package.json' };
  const deps = { ...(json?.dependencies || {}), ...(json?.devDependencies || {}) };
  if (deps['@biomejs/biome'] || await exists(root, 'biome.json') || await exists(root, 'biome.jsonc')) return { base: 'npx biome format --write', files: true, exts: BIOME, motivo: 'Biome' };
  const prettierCfg = ['.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.yml', '.prettierrc.yaml', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs'];
  if (deps.prettier || json?.prettier) return { base: 'npx prettier --write', files: true, exts: WEB, motivo: 'Prettier (dependencias)' };
  for (const f of prettierCfg) if (await exists(root, f)) return { base: 'npx prettier --write', files: true, exts: WEB, motivo: `Prettier (${f})` };
  const py = await read(root, 'pyproject.toml');
  if (py && /\[tool\.ruff/.test(py)) return { base: 'ruff format', files: true, exts: ['py', 'pyi'], motivo: 'ruff (pyproject.toml)' };
  if (py && /\[tool\.black/.test(py)) return { base: 'black', files: true, exts: ['py', 'pyi'], motivo: 'black (pyproject.toml)' };
  if (await exists(root, 'go.mod')) return { base: 'gofmt -w', files: true, exts: ['go'], motivo: 'gofmt (go.mod)' };
  return null;
}

// Ficheros cambiados respecto a HEAD más los nuevos sin versionar (respetando .gitignore)
export async function changedFiles(root) {
  const diff = await git(root, ['diff', '--name-only', '-z', 'HEAD']);
  if (diff == null) throw fail(`${root} no es un repositorio git (o git no está instalado): no se puede saber qué ficheros han cambiado`);
  const extra = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']) || '';
  const all = [...new Set([...diff.split('\0'), ...extra.split('\0')].filter(Boolean))].sort();
  const out = [];
  for (const f of all) if (await exists(root, f)) out.push(f); // los borrados no se formatean
  return out;
}

const hashOf = async (root, rel) => crypto.createHash('sha1').update(await fs.readFile(path.join(root, rel)).catch(() => Buffer.alloc(0))).digest('hex');

export default async function format(params, _input, { signal, log, timeoutMs, access }) {
  const root = await access.dir(String(params.carpeta || '').trim());
  const todos = await changedFiles(root);
  if (!todos.length) { log('No hay ficheros cambiados: nada que formatear'); return { formateador: null, motivo: 'sin cambios', ficheros: [], cambiados: [], todos }; }

  const manual = String(params.comando || '').trim();
  const f = manual ? { base: manual, files: params.conFicheros !== 'No', exts: null, motivo: 'comando del nodo' } : await detectFormatter(root);
  if (!f) {
    log('No se ha detectado formateador (script «format», Biome, Prettier, ruff, black o gofmt): se deja como está');
    return { formateador: null, motivo: 'no detectado', ficheros: [], cambiados: [], todos };
  }
  let files = [];
  if (f.files) {
    const ok = todos.filter(r => !f.exts || f.exts.includes(r.split('.').pop().toLowerCase()));
    files = ok.filter(r => SAFE.test(r) && !r.startsWith('-'));
    const skipped = ok.filter(r => !files.includes(r));
    if (skipped.length) log(`Se omiten ${skipped.length} ficheros con caracteres no seguros para la línea de comandos: ${skipped.slice(0, 5).join(', ')}`);
    if (!files.length) { log(`${f.motivo}: ninguno de los ${todos.length} ficheros cambiados es de un tipo que formatee`); return { formateador: f.base, motivo: f.motivo, ficheros: [], cambiados: [], todos }; }
  }
  log(`Formateador: ${f.motivo} → «${f.base}»${f.files ? ` · ${files.length} fichero${files.length === 1 ? '' : 's'}` : ' (todo el proyecto, como lo define el repo)'}`);

  // Permiso del comando base (se pide una vez) y después se ejecuta con los ficheros, en tandas
  const checked = await access.command(f.base, root);
  const before = Object.fromEntries(await Promise.all(todos.map(async r => [r, await hashOf(root, r)])));
  const batches = f.files ? Array.from({ length: Math.ceil(files.length / 40) }, (_, i) => files.slice(i * 40, i * 40 + 40)) : [[]];
  let last;
  for (const b of batches) {
    last = await runCommand({ comando: [f.base, ...b].join(' '), carpeta: root, asked: checked.asked }, { access, signal, log, timeoutMs: Math.max(1000, (timeoutMs || 600000) - 2000) });
    if (last.error) throw fail(`${last.error}: ${f.base}`);
    if (!last.ok) {
      if (params.failOnError === 'Sí') throw fail(`El formateador terminó con código ${last.codigo}\n${last.salida.slice(-2000)}`);
      log(`Aviso: el formateador terminó con código ${last.codigo}; se sigue (algún fichero puede no haberse formateado)`);
      break;
    }
  }
  const cambiados = [];
  for (const r of todos) if (before[r] !== await hashOf(root, r)) cambiados.push(r);
  log(cambiados.length ? `Formateados ${cambiados.length}: ${cambiados.slice(0, 8).join(', ')}${cambiados.length > 8 ? '…' : ''}` : 'Ya estaban bien formateados');
  return { formateador: f.base, motivo: f.motivo, ficheros: f.files ? files : todos, cambiados, todos, codigo: last.codigo, salida: last.salida.slice(-4000) };
}
