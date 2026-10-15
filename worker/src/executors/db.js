import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Nodo «Base de datos». Parámetros: conn (conexión), query, params (array; p.ej. {{ [$json.email] }}).
// La conexión llega resuelta por el orquestador (p.connection, dada de alta en la pantalla Conexiones)
// o se busca por nombre en DB_CONNECTIONS de este worker.
// «Solo lectura»: SQLite abre el fichero en modo lectura; PostgreSQL ejecuta una única sentencia
// dentro de una transacción READ ONLY. Para garantía total, usa además un usuario de BD sin permisos de escritura.

const pools = new Map();
const fail = msg => Object.assign(new Error(msg), { retryable: false });
const BASE = () => process.env.ORQ_BASE_DIR || fileURLToPath(new URL('../../..', import.meta.url));

// Limpia escapes innecesarios en SQL: \" → ", \` → `, \' → '
function sanitizeSql(sql) {
  return String(sql || '')
    .replace(/\\"([^"]*)\"/g, '"$1"')  // \"column\" → "column"
    .replace(/\\`([^`]*)`/g, '`$1`')      // \`column` → `column`
    .replace(/\\'/g, "'");                 // \' → '
}

function envConnection(ref) {
  const name = String(ref || '').replace(/^env:/, '');
  if (!name) throw fail('Elige una conexión en el nodo');
  let all;
  try { all = JSON.parse(process.env.DB_CONNECTIONS || '{}'); } catch { throw fail('DB_CONNECTIONS no es un JSON válido'); }
  const c = all[name];
  if (!c) throw fail(`La conexión «${name}» no existe (ni en Conexiones ni en DB_CONNECTIONS)`);
  return { id: `env:${name}`, name, version: 'env', readOnly: !!c.readOnly, ...c };
}

// En solo lectura no se permiten varias sentencias ni control de transacciones
function checkReadOnlySql(sql) {
  const s = String(sql).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim().replace(/;\s*$/, '');
  if (s.includes(';')) throw fail('Conexión de solo lectura: ejecuta una única sentencia');
  if (/^(begin|commit|rollback|end|set|start|savepoint|release|reset|discard|lock)\b/i.test(s)) throw fail('Conexión de solo lectura: sentencia no permitida');
}

async function runPg(c, sql, values, log) {
  const { default: pg } = await import('pg');
  const key = `${c.id}|${c.version}`;
  let pool = pools.get(key);
  if (!pool) {
    const ssl = c.ssl === 'si' ? true : c.ssl === 'sin-verificar' ? { rejectUnauthorized: false } : false;
    pool = new pg.Pool(c.url
      ? { connectionString: c.url, max: c.max || 5 }
      : { host: c.host, port: c.port, database: c.database, user: c.user, password: c.password, ssl, max: 5, connectionTimeoutMillis: 10000 });
    pool.on('error', () => {}); // errores de conexiones ociosas: no tumbar el proceso
    pools.set(key, pool);
  }
  const client = await pool.connect();
  try {
    if (c.readOnly) {
      checkReadOnlySql(sql);
      await client.query('BEGIN READ ONLY');
      try {
        // Con «values» pg usa el protocolo extendido: una sola sentencia
        const r = await client.query({ text: sql, values });
        await client.query('COMMIT');
        log(`${r.rowCount ?? r.rows.length} filas · solo lectura`);
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        if (e.code === '25006') throw fail('Conexión de solo lectura: la consulta intenta modificar datos. Desactiva «Solo lectura» en la conexión si es intencionado.');
        throw e;
      }
    }
    const r = await client.query({ text: sql, values });
    log(`${r.rowCount ?? r.rows.length} filas`);
    return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
  } finally {
    client.release();
  }
}

async function runSqlite(c, sql, values, log) {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.resolve(BASE(), c.file);
  const key = `${c.id}|${c.version}|${c.readOnly ? 'ro' : 'rw'}`;
  let d = pools.get(key);
  if (!d) {
    if (!c.readOnly) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(path.dirname(file), { recursive: true });
    }
    try { d = new DatabaseSync(file, { readOnly: !!c.readOnly }); }
    catch (e) { throw fail(`No se pudo abrir ${file}${c.readOnly ? ' (solo lectura: el fichero debe existir)' : ''}: ${e.message}`); }
    d.stmts = new Map();
    pools.set(key, d);
  }
  let st = d.stmts.get(sql);
  if (!st) {
    try { st = d.prepare(sql); } catch (e) { throw fail(e.message); }
    if (d.stmts.size < 500) d.stmts.set(sql, st);
  }
  try {
    if (st.columns().length) {
      const rows = st.all(...values).map(r => ({ ...r }));
      log(`${rows.length} filas${c.readOnly ? ' · solo lectura' : ''}`);
      return { rows, rowCount: rows.length };
    }
    const r = st.run(...values);
    log(`${r.changes} filas afectadas`);
    return { rows: [], rowCount: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
  } catch (e) {
    if (c.readOnly && /readonly|read-only|read only/i.test(e.message)) throw fail('Conexión de solo lectura: la consulta intenta modificar datos. Desactiva «Solo lectura» en la conexión si es intencionado.');
    throw fail(e.message);
  }
}

export default async function db(p, _input, { log }) {
  const c = p.connection || envConnection(p.conn);
  if (!p.query || !String(p.query).trim()) throw fail('La consulta está vacía');
  const query = sanitizeSql(p.query);
  let values = p.params;
  if (typeof values === 'string') {
    try { values = values.trim() ? JSON.parse(values) : []; } catch { throw fail('«Parámetros» debe ser un array JSON, p. ej. ["a@b.com", 3]'); }
  }
  if (!Array.isArray(values)) values = values == null ? [] : [values];
  if (c.driver === 'pg') return runPg(c, query, values, log);
  if (c.driver === 'sqlite') return runSqlite(c, query, values, log);
  throw fail(`Driver no soportado: ${c.driver} (usa "pg" o "sqlite")`);
}
