import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeAccess, envCommands } from './access.js';

// Acceso de los agentes (herramientas) y del nodo Comando al disco y a la consola.
// Los permisos (carpetas y comandos exactos por carpeta) los resuelve access.js: pantalla Permisos,
// .env o concedidos al pedirlos. Al proceso de un comando no le llegan las variables con secretos.

const fail = msg => Object.assign(new Error(msg), { retryable: false });
export const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj']);
// Ficheros que suelen tener secretos: no se leen nunca (.env.example y similares sí)
export const SECRET_FILE = /^(\.env(\.(?!example$|sample$|template$)[^.]+)*|.*\.(pem|key|pfx|p12|keystore)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?)$/i;
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH|COOKIE|SESSION)|^(ANTHROPIC|OPENAI|ORQ|SMTP|SLACK|DB_CONNECTIONS|WORKER)_?/i;

export const allowedCommands = envCommands;

export async function listFiles({ ruta, profundidad = 3 } = {}, { env = process.env, access = makeAccess({ env }) } = {}) {
  const root = await access.dir(ruta);
  const depth = Math.min(8, Math.max(1, parseInt(profundidad, 10) || 3));
  const max = 1500, out = [];
  let truncado = false;
  const walk = async (dir, d) => {
    const items = (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
    for (const it of items) {
      if (out.length >= max) { truncado = true; return; }
      if (it.isSymbolicLink()) continue;
      const rel = path.relative(root, path.join(dir, it.name)).split(path.sep).join('/');
      if (it.isDirectory()) {
        if (IGNORE.has(it.name)) { out.push(`${rel}/ (omitida)`); continue; }
        out.push(`${rel}/`);
        if (d < depth) await walk(path.join(dir, it.name), d + 1);
      } else if (it.isFile()) out.push(rel);
    }
  };
  await walk(root, 1);
  return { carpeta: root, profundidad: depth, entradas: out, truncado };
}

// ── Búsqueda (como grep / glob en los agentes de coding)

// Glob → expresión regular sobre rutas relativas con «/»: ** (cualquier nivel), * (dentro de un nivel),
// ? (un carácter) y {a,b} (alternativas). Sin «/», se compara con el nombre del fichero.
function globRegex(glob) {
  let re = '', i = 0;
  const g = String(glob).trim().replace(/\\/g, '/');
  while (i < g.length) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 3 : 2; continue; }
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const end = g.indexOf('}', i); if (end > i) { re += `(?:${g.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`; i = end + 1; continue; } re += '\\{'; }
    else re += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c;
    i++;
  }
  return new RegExp(`^${re}$`, 'i');
}
// Varios patrones separados por comas (las comas dentro de {…} son alternativas, no separan)
const splitGlobs = s => { const out = []; let cur = '', depth = 0; for (const c of String(s || '')) { if (c === ',' && !depth) { out.push(cur); cur = ''; continue; } if (c === '{') depth++; if (c === '}') depth = Math.max(0, depth - 1); cur += c; } return [...out, cur]; };
const globMatcher = globs => {
  const list = splitGlobs(globs).map(s => s.trim()).filter(Boolean).map(g => ({ re: globRegex(g), path: g.includes('/') }));
  return list.length ? rel => list.some(({ re, path: p }) => re.test(p ? rel : rel.split('/').pop())) : () => true;
};

// Recorre los ficheros de una carpeta (sin node_modules, .git…, enlaces ni ficheros con secretos)
export async function* walkFiles(root, maxFiles = 20000) {
  let n = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const items = (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => b.name.localeCompare(a.name));
    for (const it of items) {
      if (it.isSymbolicLink()) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { if (!IGNORE.has(it.name)) stack.push(full); continue; }
      if (!it.isFile() || SECRET_FILE.test(it.name)) continue;
      if (++n > maxFiles) return;
      yield { full, rel: path.relative(root, full).split(path.sep).join('/') };
    }
  }
}

export async function findFiles({ ruta, patron, max = 200 } = {}, { env = process.env, access = makeAccess({ env }) } = {}) {
  const root = await access.dir(ruta);
  if (!String(patron || '').trim()) throw fail('Falta el patrón (p. ej. «**/*.test.js» o «*export*»)');
  const match = globMatcher(patron), limit = Math.min(1000, Math.max(1, parseInt(max, 10) || 200));
  const ficheros = [];
  let truncado = false;
  for await (const f of walkFiles(root)) {
    if (!match(f.rel)) continue;
    if (ficheros.length >= limit) { truncado = true; break; }
    ficheros.push(f.rel);
  }
  return { carpeta: root, patron, total: ficheros.length, truncado, ficheros: ficheros.sort() };
}

// Busca un texto o una expresión regular en los ficheros de texto de una carpeta. Devuelve líneas
// «ruta:línea: texto» (y, con contexto, las vecinas como «ruta-línea- texto»), como grep.
export async function searchText({ ruta, patron, regex = false, mayusculas = false, incluir = '', contexto = 0, maxResultados = 50 } = {}, { env = process.env, access = makeAccess({ env }) } = {}) {
  const root = await access.dir(ruta);
  const p = String(patron ?? '');
  if (!p.trim()) throw fail('Falta el patrón a buscar');
  if (p.length > 300) throw fail('El patrón es demasiado largo (máx. 300 caracteres)');
  let re;
  try { re = new RegExp(regex ? p : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), mayusculas ? '' : 'i'); }
  catch (e) { throw fail(`Expresión regular no válida: ${e.message}`); }
  const include = globMatcher(incluir);
  const ctx = Math.min(5, Math.max(0, parseInt(contexto, 10) || 0));
  const max = Math.min(200, Math.max(1, parseInt(maxResultados, 10) || 50));
  const maxBytes = 1024 * 1024;
  const resultados = [], conCoincidencias = new Set();
  let revisados = 0, total = 0, shown = 0, truncado = false;
  for await (const f of walkFiles(root)) {
    if (!include(f.rel)) continue;
    const st = await fs.stat(f.full).catch(() => null);
    if (!st || st.size > maxBytes) continue;
    const buf = await fs.readFile(f.full).catch(() => null);
    if (!buf || buf.subarray(0, 8000).includes(0)) continue; // binario
    revisados++;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      total++;
      conCoincidencias.add(f.rel);
      if (shown >= max) { truncado = true; continue; }
      shown++;
      const cut = s => (s.length > 220 ? `${s.slice(0, 220)}…` : s).trim();
      for (let j = Math.max(0, i - ctx); j < i; j++) resultados.push(`${f.rel}-${j + 1}- ${cut(lines[j])}`);
      resultados.push(`${f.rel}:${i + 1}: ${cut(lines[i])}`);
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + ctx); j++) resultados.push(`${f.rel}-${j + 1}- ${cut(lines[j])}`);
    }
  }
  return {
    carpeta: root, patron: p, coincidencias: total, ficheros: conCoincidencias.size, revisados, truncado,
    ...(truncado ? { aviso: `Hay ${total} coincidencias y se muestran las primeras: afina el patrón o usa «incluir»` } : {}),
    resultados,
  };
}

export async function readText({ ruta, desde = 1, lineas = 400 } = {}, { env = process.env, access = makeAccess({ env }) } = {}) {
  const target = await access.file(ruta);
  if (SECRET_FILE.test(path.basename(target))) throw fail(`No se leen ficheros que suelen contener secretos: ${path.basename(target)}`);
  const st = await fs.stat(target);
  if (!st.isFile()) throw fail(`No es un fichero: ${target}`);
  const maxBytes = Number(env.ORQ_FILES_MAX_BYTES || 5 * 1024 * 1024);
  if (st.size > maxBytes) throw fail(`El fichero ocupa ${st.size.toLocaleString('es')} bytes y el límite es ${maxBytes.toLocaleString('es')} (ORQ_FILES_MAX_BYTES)`);
  const buf = await fs.readFile(target);
  if (buf.subarray(0, 8000).includes(0)) throw fail(`Es un fichero binario: ${target}`);
  const all = buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  const from = Math.max(1, parseInt(desde, 10) || 1);
  const count = Math.min(2000, Math.max(1, parseInt(lineas, 10) || 400));
  let texto = all.slice(from - 1, from - 1 + count).join('\n');
  if (texto.length > 60000) texto = texto.slice(0, 60000) + '\n(… recortado a 60 000 caracteres)';
  const hasta = Math.min(all.length, from - 1 + count);
  return { ruta: target, lineas: `${from}-${hasta} de ${all.length}`, ...(hasta < all.length ? { siguiente: hasta + 1 } : {}), texto };
}

// ── Escritura (herramientas editar_fichero y crear_fichero de los agentes)
// Necesitan permiso de escritura en la carpeta (si falta, se pide). Nunca dentro de carpetas omitidas
// (node_modules, .git…) ni en ficheros que suelen tener secretos.
const MAX_WRITE = 1024 * 1024;
function guardWrite(target) {
  if (target.split(path.sep).some(seg => IGNORE.has(seg))) throw fail(`No se escribe dentro de ${target.split(path.sep).find(seg => IGNORE.has(seg))}/: ${target}`);
  if (SECRET_FILE.test(path.basename(target))) throw fail(`No se escriben ficheros que suelen contener secretos: ${path.basename(target)}`);
}
const countOf = (text, part) => { let n = 0; for (let i = text.indexOf(part); i !== -1; i = text.indexOf(part, i + part.length)) n++; return n; };

// Sustituye un trozo exacto de un fichero existente. Debe aparecer una sola vez (salvo todas: true).
// Respeta los saltos de línea del fichero (CRLF/LF) y su BOM.
export async function editText({ ruta, texto_antiguo, texto_nuevo = '', todas = false } = {}, { env = process.env, access = makeAccess({ env }) } = {}) {
  const target = await access.file(ruta, { write: true });
  guardWrite(target);
  const st = await fs.stat(target).catch(() => null);
  if (!st?.isFile()) throw fail(`No existe el fichero ${target}: para uno nuevo usa crear_fichero`);
  if (st.size > MAX_WRITE) throw fail(`El fichero es demasiado grande para editarlo (${st.size.toLocaleString('es')} bytes)`);
  const buf = await fs.readFile(target);
  if (buf.subarray(0, 8000).includes(0)) throw fail(`Es un fichero binario: ${target}`);
  let text = buf.toString('utf8');
  const bom = text.startsWith('﻿');
  if (bom) text = text.slice(1);
  const crlf = text.includes('\r\n');
  const norm = s => { const t = String(s ?? '').replace(/\r\n/g, '\n'); return crlf ? t.replace(/\n/g, '\r\n') : t; };
  const oldS = norm(texto_antiguo), newS = norm(texto_nuevo);
  if (!oldS) throw fail('Falta texto_antiguo: el trozo exacto a sustituir (para un fichero nuevo usa crear_fichero)');
  if (oldS === newS) throw fail('texto_antiguo y texto_nuevo son iguales: no hay nada que cambiar');
  const n = countOf(text, oldS);
  if (!n) throw fail(`No se encuentra texto_antiguo en ${target}. Léelo antes con leer_fichero y cópialo exactamente (espacios, sangría y saltos de línea incluidos), sin los números de línea`);
  if (n > 1 && !todas) throw fail(`texto_antiguo aparece ${n} veces en ${target}: añade líneas de alrededor para que sea único, o usa todas: true para cambiarlas todas`);
  const at = text.indexOf(oldS);
  const linea = text.slice(0, at).split('\n').length;
  text = todas ? text.split(oldS).join(newS) : text.slice(0, at) + newS + text.slice(at + oldS.length);
  await fs.writeFile(target, (bom ? '﻿' : '') + text, 'utf8');
  return { ruta: target, sustituciones: todas ? n : 1, linea };
}

// Crea un fichero nuevo (y las carpetas que falten). Si ya existe, falla: para cambiarlo, editar_fichero.
export async function createText({ ruta, contenido = '' } = {}, { env = process.env, access = makeAccess({ env }) } = {}) {
  if (!ruta || typeof ruta !== 'string' || !path.isAbsolute(ruta)) throw fail(`Usa una ruta absoluta: ${ruta || '(vacía)'}`);
  const abs = path.resolve(ruta);
  guardWrite(abs);
  if (await fs.stat(abs).catch(() => null)) throw fail(`Ya existe ${abs}: para cambiarlo usa editar_fichero`);
  const text = String(contenido ?? '');
  if (Buffer.byteLength(text) > MAX_WRITE) throw fail('El contenido es demasiado grande');
  // La carpeta existente más cercana debe permitir escritura; las que falten se crean dentro de ella
  let dir = path.dirname(abs);
  while (!(await fs.stat(dir).catch(() => null))) { const up = path.dirname(dir); if (up === dir) break; dir = up; }
  await access.dirWrite(dir);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const target = await access.file(abs, { write: true });
  guardWrite(target);
  await fs.writeFile(target, text, { encoding: 'utf8', flag: 'wx' });
  return { ruta: target, lineas: text ? text.split('\n').length : 0 };
}

const cleanEnv = src => Object.fromEntries(Object.entries(src).filter(([k]) => !SECRET_ENV.test(k)));

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

// Comprueba (o pide) el permiso del comando en esa carpeta, sin ejecutarlo
export const checkCommand = ({ comando, carpeta } = {}, { env = process.env, access = makeAccess({ env }) } = {}) => access.command(comando, carpeta);

// args ya comprobados con checkCommand ({ comando, carpeta, asked }) o sin comprobar
export async function runCommand(args, { env = process.env, access = makeAccess({ env }), signal, log = () => {}, timeoutMs = 600000, maxChars = 20000 } = {}) {
  const { comando, carpeta } = args.asked !== undefined ? args : await checkCommand(args, { access });
  log(`$ ${comando}  (en ${carpeta})`);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(comando, { cwd: carpeta, shell: true, env: cleanEnv(process.env), windowsHide: true, detached: process.platform !== 'win32' });
    let salida = '', cortado = false, why = '';
    const add = d => {
      salida += d.toString('utf8');
      if (salida.length > maxChars * 2) { salida = salida.slice(-maxChars); cortado = true; }
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const stop = reason => { why = reason; killTree(child); };
    const timer = setTimeout(() => stop(`Tiempo agotado (${Math.round(timeoutMs / 1000)} s)`), timeoutMs);
    const onAbort = () => stop('Cancelado');
    signal?.addEventListener('abort', onAbort);
    child.on('error', e => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(fail(`No se pudo ejecutar «${comando}»: ${e.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (why === 'Cancelado') return reject(Object.assign(new Error('Cancelado'), { retryable: false }));
      if (salida.length > maxChars) { salida = salida.slice(-maxChars); cortado = true; }
      const codigo = why ? null : code;
      log(`Código de salida ${codigo ?? '—'} · ${((Date.now() - t0) / 1000).toFixed(1)} s${why ? ` · ${why}` : ''}`);
      resolve({ comando, carpeta, codigo, ok: codigo === 0, salida: (cortado ? '(… solo el final de la salida)\n' : '') + salida, duracionMs: Date.now() - t0, ...(why ? { error: why } : {}) });
    });
  });
}
