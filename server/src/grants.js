import fs from 'node:fs';
import path from 'node:path';
import { Settings, newId } from './db.js';

// Permisos que da el usuario en runtime: carpetas (lectura / escritura) y comandos permitidos dentro
// de cada carpeta. Se conceden en la pantalla Permisos o al pedirlos un nodo («Permitir siempre»), y
// viajan al worker con cada tarea. ORQ_FILES_ALLOW / ORQ_COMMANDS_ALLOW del .env siguen valiendo como
// permisos fijos (no se editan desde aquí).

const KEY = 'grants';
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const norm = s => String(s || '').trim().replace(/\s+/g, ' ');
const split = v => String(v || '').split(';').map(norm).filter(Boolean);
const cleanCommands = c => [...new Set((Array.isArray(c) ? c : split(c)).map(norm).filter(Boolean))];

const all = () => Settings.get(KEY, []);
const save = list => Settings.set(KEY, list);

function cleanPath(p) {
  if (!p || !path.isAbsolute(String(p))) throw bad('Indica la ruta absoluta de la carpeta');
  const abs = path.resolve(String(p));
  let st;
  try { st = fs.statSync(abs); } catch { throw bad(`No existe la carpeta ${abs}`); }
  if (!st.isDirectory()) throw bad(`No es una carpeta: ${abs}`);
  return fs.realpathSync(abs);
}

export function listGrants() {
  return {
    grants: all(),
    env: { folders: split(process.env.ORQ_FILES_ALLOW), commands: split(process.env.ORQ_COMMANDS_ALLOW) },
  };
}

// Añade o amplía el permiso de una carpeta (nunca lo reduce: para eso, updateGrant)
export function grant({ path: p, read = false, write = false, commands = [], by = 'usuario' }) {
  const folder = cleanPath(p);
  const list = all();
  const cur = list.find(g => same(g.path, folder));
  if (cur) {
    Object.assign(cur, { read: cur.read || !!read || !!write, write: cur.write || !!write, commands: cleanCommands([...cur.commands, ...cleanCommands(commands)]), updatedAt: Date.now() });
    save(list);
    return cur;
  }
  const g = { id: newId('pm'), path: folder, read: !!read || !!write, write: !!write, commands: cleanCommands(commands), by, createdAt: Date.now(), updatedAt: Date.now() };
  save([...list, g]);
  return g;
}

export function updateGrant(id, { read, write, commands }) {
  const list = all();
  const g = list.find(x => x.id === id);
  if (!g) return null;
  if (write !== undefined) g.write = !!write;
  if (read !== undefined) g.read = !!read || g.write;
  if (write) g.read = true;
  if (commands !== undefined) g.commands = cleanCommands(commands);
  g.updatedAt = Date.now();
  save(list);
  return g;
}

export function revokeGrant(id) {
  const list = all();
  const next = list.filter(g => g.id !== id);
  save(next);
  return next.length !== list.length;
}

// Lo que recibe el worker con cada tarea
export const grantsForWorker = () => all().map(({ path: p, read, write, commands }) => ({ path: p, read, write, commands }));
