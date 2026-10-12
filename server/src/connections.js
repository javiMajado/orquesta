import path from 'node:path';
import { Connections } from './db.js';
import { encrypt, decrypt } from './secrets.js';

// Conexiones a BD: las dadas de alta en la UI (tabla connections) + las de DB_CONNECTIONS del .env
// (solo lectura en la UI, id «env:<nombre>»). Las contraseñas no salen nunca hacia la UI.

const DRIVERS = ['pg', 'sqlite'];
const SSL = ['no', 'si', 'sin-verificar'];

function envConnections() {
  try {
    return Object.entries(JSON.parse(process.env.DB_CONNECTIONS || '{}')).map(([name, c]) => ({
      id: `env:${name}`, name, driver: c.driver, readOnly: !!c.readOnly, source: 'env',
      config: c.driver === 'sqlite' ? { file: c.file } : { url: String(c.url || '').replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:••••@') },
    }));
  } catch { return []; }
}

const pub = c => ({ id: c.id, name: c.name, driver: c.driver, config: c.config, readOnly: c.readOnly, hasPassword: !!c.hasSecret, source: 'ui', updatedAt: c.updatedAt });

export function listConnections() {
  return [...Connections.list().map(pub), ...envConnections()];
}

export function getConnection(id) {
  const c = Connections.get(id);
  return c ? pub(c) : null;
}

// Valida y normaliza lo que llega del formulario
function clean(body, { partial = false } = {}) {
  const name = String(body?.name ?? '').trim();
  const driver = body?.driver;
  if (!partial || body?.name !== undefined) {
    if (!name) throw Object.assign(new Error('El nombre es obligatorio'), { status: 400 });
    if (name.startsWith('env:')) throw Object.assign(new Error('El nombre no puede empezar por «env:»'), { status: 400 });
  }
  if (!DRIVERS.includes(driver)) throw Object.assign(new Error('Tipo de conexión no soportado (PostgreSQL o SQLite)'), { status: 400 });
  const c = body.config || {};
  let config;
  if (driver === 'pg') {
    const port = Number(c.port || 5432);
    if (!c.host) throw Object.assign(new Error('Falta el servidor'), { status: 400 });
    if (!c.database) throw Object.assign(new Error('Falta la base de datos'), { status: 400 });
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('Puerto no válido'), { status: 400 });
    config = { host: String(c.host).trim(), port, database: String(c.database).trim(), user: String(c.user || '').trim(), ssl: SSL.includes(c.ssl) ? c.ssl : 'no' };
  } else {
    if (!c.file || !path.isAbsolute(String(c.file))) throw Object.assign(new Error('Indica la ruta absoluta del fichero SQLite'), { status: 400 });
    config = { file: path.resolve(String(c.file)) };
  }
  return { name, driver, config, readOnly: body.readOnly !== false };
}

function dupCheck(name, id) {
  const other = Connections.findByName(name);
  if (other && other.id !== id) throw Object.assign(new Error(`Ya existe una conexión llamada «${name}»`), { status: 409 });
}

export function createConnection(body) {
  const v = clean(body);
  dupCheck(v.name);
  return pub(Connections.create({ ...v, secret: v.driver === 'pg' ? encrypt(body.password) : null }));
}

// password: undefined/omitido = sin cambios · '' = borrar · texto = nueva
export function updateConnection(id, body) {
  const cur = Connections.get(id);
  if (!cur) return null;
  const v = clean({ ...pub(cur), ...body, config: { ...cur.config, ...(body.config || {}) } });
  dupCheck(v.name, id);
  const secret = v.driver !== 'pg' ? null : body.password === undefined ? undefined : body.password === '' ? null : encrypt(body.password);
  return pub(Connections.update(id, { ...v, secret }));
}

export const deleteConnection = id => Connections.remove(id);

// Lo que necesita el worker para conectarse (incluye la contraseña descifrada). Solo para tareas.
// Acepta id o nombre. Devuelve null si es una conexión del .env (el worker la resuelve por nombre).
export function resolveForWorker(ref) {
  if (!ref || String(ref).startsWith('env:')) return null;
  const c = Connections.get(ref) || Connections.findByName(ref);
  if (!c) return null;
  return { id: c.id, name: c.name, driver: c.driver, readOnly: c.readOnly, version: c.updatedAt, ...c.config, ...(c.driver === 'pg' ? { password: decrypt(c.secret) } : {}) };
}

// Payload para «Probar conexión» de un formulario aún sin guardar (o con la contraseña guardada)
export function payloadForTest(body) {
  const v = clean(body);
  let password = body.password;
  if (v.driver === 'pg' && password === undefined && body.id) password = decrypt(Connections.get(body.id)?.secret);
  return { id: body.id || 'prueba', name: v.name, driver: v.driver, readOnly: v.readOnly, version: Date.now(), ...v.config, ...(v.driver === 'pg' ? { password: password || '' } : {}) };
}
