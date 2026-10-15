import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildRepoMap, repoMap } from '../src/repomap.js';
import { repoCacheDir } from '../src/cache-dir.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orq-map-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const env = { ...process.env, ORQ_WORKER_CACHE_DIR: path.join(tmp, 'cache') };

function repo(name, { git = true } = {}) {
  const root = path.join(tmp, name);
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w('package.json', JSON.stringify({ name: 'demo', workspaces: ['packages/*'], scripts: { test: 'node --test', dev: 'node server.js' } }));
  w('README.md', '# Demo\n\n## Uso\ntexto\n```\n# no es un título\n```\n## Licencia\n');
  w('CLAUDE.md', '# Contexto\n\nUsa ESM y comentarios en español.\n');
  w('.env', 'TOKEN=secreto');
  w('server/index.js', 'export default 1;\n');
  w('packages/a/package.json', JSON.stringify({ name: '@demo/a', scripts: { build: 'x' } }));
  w('packages/a/src/index.js', 'export const a = 1;\n');
  w('node_modules/x/index.js', 'no');
  if (git) {
    const g = args => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    g(['init', '-q']); g(['add', '-A']); g(['-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', 'x']);
  }
  return root;
}

test('mapa: estructura, scripts, paquetes, entradas e índice de la documentación; sin secretos ni node_modules', async () => {
  const root = repo('con-git');
  const { text, head } = await buildRepoMap(root);
  assert.ok(head);
  assert.match(text, /# Mapa del repositorio «con-git»/);
  assert.match(text, /commit [0-9a-f]{12}/);
  assert.match(text, /test: node --test/);
  assert.match(text, /packages\/a\/ \(@demo\/a\) · scripts: build/);
  assert.match(text, /- server\/index\.js/);
  assert.match(text, /## Índice de README\.md\n# Demo\n## Uso\n## Licencia/);
  assert.match(text, /## CLAUDE\.md \(extracto\)\n# Contexto/);
  assert.doesNotMatch(text, /\.env|TOKEN=|node_modules\/x/);
});

test('mapa: mismos bytes en cada llamada y guardado por commit en la caché del worker', async () => {
  const root = repo('determinista');
  const a = await repoMap(root, { env });
  const b = await repoMap(root, { env });
  assert.equal(a.text, b.text);
  assert.equal((await buildRepoMap(root)).text, a.text);
  assert.ok(fs.existsSync(path.join(repoCacheDir(root, env), `map-v1-${a.head}.txt`)));
});

test('mapa: respeta el límite de tamaño y funciona sin git', async () => {
  const root = repo('sin-git', { git: false });
  for (let i = 0; i < 300; i++) { fs.mkdirSync(path.join(root, `mod${i}`), { recursive: true }); fs.writeFileSync(path.join(root, `mod${i}`, 'x.js'), ''); }
  const prev = process.env.ORQ_REPO_MAP_CHARS;
  process.env.ORQ_REPO_MAP_CHARS = '3000';
  try {
    const { text, head } = await buildRepoMap(root);
    assert.equal(head, null);
    assert.ok(text.length <= 3100, `longitud ${text.length}`);
    assert.match(text, /carpetas más/);
    assert.doesNotMatch(text, /\.env|TOKEN=/);
  } finally {
    if (prev == null) delete process.env.ORQ_REPO_MAP_CHARS; else process.env.ORQ_REPO_MAP_CHARS = prev;
  }
});
