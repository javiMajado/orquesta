import fs from 'node:fs/promises';
import path from 'node:path';

// Permisos de una tarea: a qué carpetas puede acceder (lectura / escritura) y qué comandos puede
// ejecutar en ellas. Fuentes:
//  · fijos del worker: ORQ_FILES_ALLOW (lectura y escritura) y ORQ_COMMANDS_ALLOW (en esas carpetas
//    o en cualquier carpeta concedida);
//  · los que el usuario ha concedido en el orquestador (pantalla Permisos), que llegan con la tarea;
//  · los concedidos «solo esta vez» durante la propia tarea.
// Si falta un permiso y la tarea puede preguntar, se pide al usuario (requestApproval) en vez de fallar.
// Se comparan rutas reales (realpath): ni «..» ni enlaces simbólicos sacan de una carpeta.

const fail = msg => Object.assign(new Error(msg), { retryable: false });
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const norm = s => String(s || '').trim().replace(/\s+/g, ' ');
const split = v => String(v || '').split(';').map(norm).filter(Boolean);

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && (process.platform !== 'win32' || same(path.parse(root).root, path.parse(target).root));
}

export const envFolders = (env = process.env) => split(env.ORQ_FILES_ALLOW);
export const envCommands = (env = process.env) => split(env.ORQ_COMMANDS_ALLOW);

// grants = null: el worker no acepta permisos del orquestador (solo los de su .env) y no pregunta
export function makeAccess({ env = process.env, grants = null, requestApproval = null } = {}) {
  const canAsk = Array.isArray(grants) && typeof requestApproval === 'function';
  const session = [];

  async function folders() {
    const list = [...envFolders(env).map(p => ({ path: p, read: true, write: true, commands: [] })), ...(grants || []), ...session];
    const out = [];
    for (const g of list) {
      const real = await fs.realpath(path.resolve(g.path)).catch(() => null);
      if (real) out.push({ ...g, real });
    }
    return out;
  }
  const names = list => (list.length ? list.map(g => g.path).join('; ') : 'ninguna');

  async function ask(request, denied) {
    const d = await requestApproval({ kind: 'permiso', ...request });
    if (!d?.approved) throw fail(`${denied}${d?.comment ? ` (${d.comment})` : ''}`);
  }

  // Una carpeta cubre su contenido; para listar o trabajar en ella, también a sí misma
  async function check(target, { write = false, dir = false, shown }) {
    const list = await folders();
    const covers = g => (dir ? same(g.real, target) || inside(g.real, target) : inside(g.real, target));
    if (list.some(g => covers(g) && (write ? g.write : g.read || g.write))) return;
    const acceso = write ? 'escritura' : 'lectura';
    if (!canAsk) {
      if (!list.some(g => g.read || g.write)) throw fail('Acceso a ficheros desactivado: no hay ninguna carpeta permitida. Da permiso en la pantalla «Permisos» (o con ORQ_FILES_ALLOW)');
      throw fail(`${dir ? 'Carpeta fuera de las permitidas' : 'Ruta fuera de las carpetas permitidas'}: ${shown}. Permitidas (${acceso}): ${names(list.filter(g => (write ? g.write : g.read || g.write)))}`);
    }
    const carpeta = dir ? target : path.dirname(target);
    await ask({ tipo: 'carpeta', carpeta, acceso, ruta: shown }, `Permiso de ${acceso} denegado para ${carpeta}`);
    session.push({ path: carpeta, read: true, write, commands: [] });
  }

  return {
    canAsk,

    // Fichero (existente, o nuevo si write: su carpeta debe existir)
    async file(p, { write = false } = {}) {
      if (!p || typeof p !== 'string') throw fail('Falta la ruta del fichero');
      if (!path.isAbsolute(p)) throw fail(`Usa una ruta absoluta: ${p}`);
      const abs = path.resolve(p);
      let real;
      try {
        real = await fs.realpath(abs);
      } catch (e) {
        if (e.code !== 'ENOENT') throw fail(`No se puede acceder a ${abs}: ${e.message}`);
        if (!write) throw fail(`No existe el fichero ${abs}`);
        try { real = path.join(await fs.realpath(path.dirname(abs)), path.basename(abs)); }
        catch { throw fail(`No existe la carpeta ${path.dirname(abs)}`); }
      }
      await check(real, { write, shown: abs });
      return real;
    },

    async dir(p) {
      if (!p || typeof p !== 'string') throw fail('Falta la carpeta');
      if (!path.isAbsolute(p)) throw fail(`Usa una ruta absoluta: ${p}`);
      let real;
      try { real = await fs.realpath(path.resolve(p)); } catch { throw fail(`No existe la carpeta ${p}`); }
      if (!(await fs.stat(real)).isDirectory()) throw fail(`No es una carpeta: ${p}`);
      await check(real, { dir: true, shown: p });
      return real;
    },

    // Ruta real de la carpeta si ya se puede leer, o null. Nunca pide permiso (lo usa el mapa del repo)
    async readable(p) {
      if (!p || typeof p !== 'string' || !path.isAbsolute(p)) return null;
      const real = await fs.realpath(path.resolve(p)).catch(() => null);
      if (!real || !(await fs.stat(real).catch(() => null))?.isDirectory()) return null;
      const list = await folders();
      return list.some(g => (same(g.real, real) || inside(g.real, real)) && (g.read || g.write)) ? real : null;
    },

    // Comando exacto en una carpeta. asked = se ha pedido (y concedido) permiso en esta llamada
    async command(cmd, carpeta) {
      const comando = norm(cmd);
      if (!comando) throw fail('Falta el comando');
      if (!carpeta || typeof carpeta !== 'string' || !path.isAbsolute(carpeta)) throw fail(`Indica la carpeta de trabajo con una ruta absoluta: ${carpeta || '(vacía)'}`);
      let cwd;
      try { cwd = await fs.realpath(path.resolve(carpeta)); } catch { throw fail(`No existe la carpeta ${carpeta}`); }
      if (!(await fs.stat(cwd)).isDirectory()) throw fail(`No es una carpeta: ${carpeta}`);

      const list = await folders();
      const under = g => same(g.real, cwd) || inside(g.real, cwd);
      const global = envCommands(env);
      if ((global.includes(comando) && list.some(under)) || list.some(g => g.commands?.includes(comando) && under(g))) return { comando, carpeta: cwd, asked: false };

      if (!canAsk) {
        const known = [...global, ...list.flatMap(g => g.commands || [])];
        if (!known.length) throw fail('Ejecución de comandos desactivada: no hay ningún comando permitido. Concédelo en la pantalla «Permisos» (o con ORQ_COMMANDS_ALLOW)');
        if (!known.includes(comando)) throw fail(`Comando no permitido: «${comando}». Permitidos: ${[...new Set(known)].join(' · ')}`);
        throw fail(`Carpeta fuera de las permitidas para «${comando}»: ${carpeta}`);
      }
      await ask({ tipo: 'comando', comando, carpeta: cwd }, `Permiso denegado para ejecutar «${comando}» en ${cwd}`);
      session.push({ path: cwd, read: false, write: false, commands: [comando] });
      return { comando, carpeta: cwd, asked: true };
    },

    // Comandos ya permitidos (para que el agente sepa cuáles puede pedir sin preguntar)
    commandList: () => [...new Set([...envCommands(env), ...(grants || []).flatMap(g => g.commands || []), ...session.flatMap(g => g.commands)])],
  };
}
