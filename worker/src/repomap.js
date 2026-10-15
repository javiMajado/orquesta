import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { IGNORE, SECRET_FILE, walkFiles } from './workspace.js';
import { repoCacheDir } from './cache-dir.js';

// Mapa del repositorio: resumen compacto y DETERMINISTA (los mismos bytes para todos los agentes que
// trabajan sobre el mismo commit). Va al principio del system con su marcador de caché: los agentes no
// gastan turnos en listar la raíz ni en releer README/CLAUDE.md, y los que arrancan a la vez comparten la
// caché del proveedor. Se construye desde el árbol del commit (git ls-tree HEAD); sin git, recorriendo la
// carpeta. Se guarda por commit en la carpeta de caché del worker (cache-dir.js).

const VERSION = 1;
const maxChars = () => Number(process.env.ORQ_REPO_MAP_CHARS || 12000); // ~3 000 tokens
const EXCERPT = 4000;

function git(root, args) {
  return new Promise(resolve => execFile('git', ['-C', root, ...args], { maxBuffer: 128 * 1024 * 1024, windowsHide: true, timeout: 30000 },
    (err, stdout) => resolve(err ? null : stdout)));
}

const skip = rel => rel.split('/').some(seg => IGNORE.has(seg)) || SECRET_FILE.test(rel.split('/').pop());

async function listing(root) {
  const head = (await git(root, ['rev-parse', 'HEAD']))?.trim();
  if (head) {
    const out = await git(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
    if (out != null) return { head, files: out.split('\0').filter(f => f && !skip(f)).sort() };
  }
  const files = [];
  for await (const f of walkFiles(root)) files.push(f.rel);
  return { head: null, files: files.sort() };
}

const LANG = {
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python',
  go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#', rb: 'Ruby', php: 'PHP', swift: 'Swift', dart: 'Dart', c: 'C', h: 'C',
  cpp: 'C++', hpp: 'C++', css: 'CSS', scss: 'CSS', html: 'HTML', vue: 'Vue', svelte: 'Svelte', sql: 'SQL', sh: 'Shell', ps1: 'PowerShell',
};
function languages(files) {
  const n = {};
  for (const f of files) { const l = LANG[f.split('.').pop().toLowerCase()]; if (l) n[l] = (n[l] || 0) + 1; }
  const total = Object.values(n).reduce((a, b) => a + b, 0);
  return Object.entries(n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6)
    .map(([l, c]) => `${l} ${Math.round((c / total) * 100)} %`).join(', ');
}

// Árbol de carpetas con el nº de ficheros de cada una, hasta `depth` niveles y como mucho `maxLines`
function tree(files, maxLines) {
  const count = new Map(), kids = new Map();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!count.has(d)) { const parent = parts.slice(0, i - 1).join('/'); (kids.get(parent) || kids.set(parent, []).get(parent)).push(d); }
      count.set(d, (count.get(d) || 0) + 1);
    }
  }
  const render = depth => {
    const out = [];
    const walk = (dir, level) => {
      const list = (kids.get(dir) || []).slice().sort((a, b) => a.localeCompare(b));
      const shown = list.length > 25 ? list.slice().sort((a, b) => count.get(b) - count.get(a) || a.localeCompare(b)).slice(0, 25).sort((a, b) => a.localeCompare(b)) : list;
      for (const d of shown) {
        out.push(`${'  '.repeat(level - 1)}${d.split('/').pop()}/ (${count.get(d)})`);
        if (level < depth) walk(d, level + 1);
      }
      if (shown.length < list.length) out.push(`${'  '.repeat(level - 1)}… ${list.length - shown.length} carpetas más`);
    };
    walk('', 1);
    return out;
  };
  for (let depth = 3; depth >= 1; depth--) {
    const lines = render(depth);
    if (lines.length <= maxLines || depth === 1) return lines.slice(0, maxLines);
  }
  return [];
}

const readText = (root, rel) => fs.readFile(path.join(root, rel), 'utf8').catch(() => null);
const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function packageSummary(pkg, { full }) {
  const out = [];
  const scripts = Object.entries(pkg.scripts || {});
  if (full) {
    if (pkg.name) out.push(`name: ${pkg.name}`);
    if (pkg.workspaces) out.push(`workspaces: ${JSON.stringify(pkg.workspaces)}`);
    for (const k of ['main', 'bin', 'exports']) if (pkg[k]) out.push(`${k}: ${cut(JSON.stringify(pkg[k]), 200)}`);
    if (scripts.length) out.push('scripts:', ...scripts.slice(0, 25).map(([k, v]) => `  ${k}: ${cut(String(v), 100)}`));
  } else if (scripts.length) out.push(`scripts: ${scripts.map(([k]) => k).slice(0, 15).join(', ')}`);
  return out;
}

// Títulos (# y ##) de un Markdown, fuera de los bloques de código
function headings(text, max = 20) {
  const out = [];
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (!fence && /^#{1,2}\s+\S/.test(line)) out.push(cut(line.trim(), 100));
    if (out.length >= max) break;
  }
  return out;
}

export async function buildRepoMap(root) {
  const { head, files } = await listing(root);
  const has = new Set(files);
  const name = path.basename(root);
  const out = [
    `# Mapa del repositorio «${name}»`,
    `Raíz: ${root.split(path.sep).join('/')}${head ? ` · commit ${head.slice(0, 12)}` : ''} · ${files.length.toLocaleString('es')} ficheros${head ? ' versionados' : ''} (sin node_modules, .git, dist… ni ficheros con secretos)`,
    'Rutas relativas a la raíz. Es una foto del último commit: lo que no esté confirmado puede no aparecer.',
  ];
  const langs = languages(files);
  if (langs) out.push(`Lenguajes: ${langs}`);

  const rootFiles = files.filter(f => !f.includes('/'));
  if (rootFiles.length) out.push('', '## Ficheros en la raíz', cut(rootFiles.slice(0, 40).join(', '), 1200) + (rootFiles.length > 40 ? ` … y ${rootFiles.length - 40} más` : ''));

  const docs = [];
  if (has.has('package.json')) {
    try { docs.push('', '## package.json', ...packageSummary(JSON.parse(await readText(root, 'package.json')), { full: true })); } catch {}
  }
  const pkgs = files.filter(f => f.endsWith('/package.json') && f.split('/').length <= 4).slice(0, 30);
  if (pkgs.length) {
    docs.push('', '## Paquetes');
    for (const f of pkgs) {
      try { const pkg = JSON.parse(await readText(root, f)); docs.push(`- ${path.posix.dirname(f)}/${pkg.name ? ` (${pkg.name})` : ''}${packageSummary(pkg, { full: false }).map(s => ` · ${s}`).join('')}`); } catch {}
    }
  }
  const manifests = ['pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json'].filter(f => has.has(f));
  if (manifests.length) docs.push('', `Otros manifiestos: ${manifests.join(', ')}`);
  const entries = files.filter(f => f.split('/').length <= 4 && /(^|\/)(index|main|server|app|cli)\.(m?[jt]sx?|cjs|py|go|rs)$/.test(f)).slice(0, 25);
  if (entries.length) docs.push('', '## Puntos de entrada probables', ...entries.map(f => `- ${f}`));

  const mdFiles = ['README.md', 'CLAUDE.md', 'AGENTS.md', ...files.filter(f => /^docs\/[^/]+\.md$/i.test(f)).slice(0, 8)].filter(f => has.has(f));
  for (const f of mdFiles) {
    const text = await readText(root, f);
    const hs = text ? headings(text) : [];
    if (hs.length) docs.push('', `## Índice de ${f}`, ...hs);
  }

  // El árbol se ajusta al espacio que dejan las demás secciones
  const budget = maxChars();
  const fixed = [...out, ...docs].join('\n').length;
  const lines = tree(files, Math.max(10, Math.floor((budget - fixed - 1500) / 28)));
  const body = [...out, '', '## Carpetas (nº de ficheros)', ...lines, ...docs].join('\n');

  // Extracto de las instrucciones del proyecto para agentes, con lo que quepa
  const guide = has.has('CLAUDE.md') ? 'CLAUDE.md' : has.has('AGENTS.md') ? 'AGENTS.md' : null;
  let text = body.length > budget ? `${body.slice(0, budget)}\n…` : body;
  const room = Math.min(EXCERPT, budget - text.length - 80);
  if (guide && room > 400) {
    const g = (await readText(root, guide) || '').trim();
    if (g) text += `\n\n## ${guide} (extracto)\n${g.length > room ? `${g.slice(0, room)}\n… (sigue en ${guide})` : g}`;
  }
  return { text, head, files: files.length };
}

// Con caché: en disco por commit (todos los agentes reciben los mismos bytes) y, sin git, 60 s en memoria
const memory = new Map();
export async function repoMap(root, { env = process.env } = {}) {
  const head = (await git(root, ['rev-parse', 'HEAD']))?.trim() || null;
  const key = `${root}|${head || ''}`;
  const hit = memory.get(key);
  if (hit && (head || hit.at > Date.now() - 60000)) return hit.map;
  let map = null;
  const file = head ? path.join(repoCacheDir(root, env), `map-v${VERSION}-${head}.txt`) : null;
  if (file) {
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text != null) map = { text, head, cached: true };
  }
  if (!map) {
    map = await buildRepoMap(root);
    if (file) {
      await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
      await fs.writeFile(file, map.text, 'utf8').catch(() => {});
    }
  }
  memory.set(key, { map, at: Date.now() });
  return map;
}
