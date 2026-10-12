import vm from 'node:vm';
import { createRequire } from 'node:module';
import { publicEnv } from '@orquesta/shared/env';

const req = createRequire(import.meta.url);
const fmt = v => (typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })());

// Nodo «Proceso Node.js»: el código es el cuerpo de una función async.
// Disponibles: $json (entrada), fetch, env (variables ORQ_* sin secretos), console, require (si ORQ_ALLOW_REQUIRE=true).
// Importante: node:vm no es un sandbox de seguridad; ejecuta solo código de confianza.
export default async function script(params, input, { log, timeoutMs = 60000, signal }) {
  const code = String(params.code || 'return $json;');
  const env = publicEnv();
  const cons = Object.fromEntries(['log', 'info', 'warn', 'error'].map(k => [k, (...a) => log(a.map(fmt).join(' '))]));
  const ctx = vm.createContext({
    $json: input, json: input, $input: input, env, console: cons,
    fetch, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, Buffer, structuredClone,
    setTimeout, clearTimeout, crypto: globalThis.crypto,
    require: process.env.ORQ_ALLOW_REQUIRE === 'true' ? req : undefined,
  });
  const promise = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'nodo.js' }).runInContext(ctx, { timeout: 2000 });
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout del script')), timeoutMs);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Cancelado')); });
      promise.then(() => clearTimeout(t), () => clearTimeout(t));
    }),
  ]);
}
