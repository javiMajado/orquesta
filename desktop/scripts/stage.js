// Prepara desktop/build/app: copia autónoma de Orquesta para empaquetar con electron-builder
// (sin los enlaces de npm workspaces, que electron-builder no resuelve bien).
//   desktop/src  server/src  web/dist  env.example  package.json
//   node_modules/  (dependencias de producción + @orquesta/shared y @orquesta/worker copiados)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = path.join(ROOT, 'desktop', 'build', 'app');
const read = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const copy = (from, to) => fs.cpSync(path.join(ROOT, from), path.join(OUT, to ?? from), { recursive: true });

if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) throw new Error('Falta web/dist: ejecuta antes «npm run build»');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

copy('desktop/src');
copy('desktop/assets');
copy('server/src');
copy('web/dist');
copy('.env.example', 'env.example');

// Paquetes internos como dependencias locales (file:) que npm copia en node_modules; así
// electron-builder los ve en el árbol de dependencias y los mete en el instalador.
for (const [name, dir] of [['shared', 'packages/shared'], ['worker', 'worker']]) {
  const pkg = read(`${dir}/package.json`);
  // Sin referencias a @orquesta/* ("*" iría al registro de npm): las resuelve la raíz
  pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies || {}).filter(([k]) => !k.startsWith('@orquesta/')));
  delete pkg.scripts;
  fs.mkdirSync(path.join(OUT, 'packages', name), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'packages', name, 'package.json'), JSON.stringify(pkg, null, 2));
  copy(`${dir}/src`, `packages/${name}/src`);
}
const deps = { '@orquesta/shared': 'file:packages/shared', '@orquesta/worker': 'file:packages/worker' };
for (const [k, v] of Object.entries(read('server/package.json').dependencies || {})) if (!k.startsWith('@orquesta/')) deps[k] = v;
const desk = read('desktop/package.json');
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({
  name: 'orquesta-desktop', productName: 'Orquesta', version: desk.version, description: 'Orquesta · workflows con agentes IA',
  author: 'Orquesta', private: true, type: 'module', main: 'desktop/src/main.js', dependencies: deps,
}, null, 2));

console.log('[stage] instalando dependencias de producción…');
// --install-links: copia los paquetes file: en vez de crear enlaces simbólicos
execSync('npm install --omit=dev --install-links --no-audit --no-fund --workspaces=false', { cwd: OUT, stdio: 'inherit' });
for (const name of ['shared', 'worker']) {
  const p = path.join(OUT, 'node_modules', '@orquesta', name);
  if (!fs.existsSync(path.join(p, 'src')) || fs.lstatSync(p).isSymbolicLink()) throw new Error(`@orquesta/${name} no quedó copiado en node_modules`);
}
fs.rmSync(path.join(OUT, 'packages'), { recursive: true, force: true }); // ya están en node_modules
console.log(`[stage] listo en ${OUT}`);
