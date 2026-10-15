import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// Carpeta de caché del worker para cada repositorio (mapa del repo; más adelante, su índice).
// ORQ_WORKER_CACHE_DIR manda; si no, junto a los datos de Orquesta (ORQ_BASE_DIR/data, que git ignora,
// o %APPDATA%\Orquesta\data en la app de escritorio); un worker suelto usa ~/.orquesta.
export function cacheRoot(env = process.env) {
  if (env.ORQ_WORKER_CACHE_DIR) return path.resolve(env.ORQ_WORKER_CACHE_DIR);
  if (env.ORQ_BASE_DIR) return path.join(env.ORQ_BASE_DIR, 'data', 'cache', 'repos');
  return path.join(os.homedir(), '.orquesta', 'cache', 'repos');
}

// Una subcarpeta por repo: hash de su ruta real (en Windows sin distinguir mayúsculas)
export function repoCacheDir(root, env = process.env) {
  const key = crypto.createHash('sha1').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 16);
  return path.join(cacheRoot(env), key);
}
