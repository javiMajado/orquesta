// Distingue las variables heredadas del shell de las que añade el .env de Orquesta.
// Hay que llamar a snapshotShellEnv() ANTES de dotenv.config(): dotenv no sobrescribe
// variables existentes, así que todo lo que ya estaba al arrancar viene del shell.
const SHELL = Symbol.for('orquesta.shellEnv');

export function snapshotShellEnv(env = process.env) {
  globalThis[SHELL] ||= new Set(Object.keys(env));
}

// 'shell' | 'env' (fichero .env de Orquesta) | 'none'. Sin instantánea se asume 'shell' (lo más restrictivo).
export function keySource(name, env = process.env) {
  if (!name || !env[name]) return 'none';
  const shell = globalThis[SHELL];
  return !shell || shell.has(name) ? 'shell' : 'env';
}

export const SOURCE_LABEL = { shell: 'heredada del shell', env: '.env de Orquesta', none: 'sin clave' };

// Nombres que nunca deben llegar a expresiones ni scripts aunque lleven el prefijo ORQ_.
const SECRET = /KEY|TOKEN|SECRET|PASS|CRED/i;
export const isSecretName = k => SECRET.test(k) || k.startsWith('ORQ_LLM_');

// Variables ORQ_* expuestas como $env (expresiones) y env (scripts).
export function publicEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('ORQ_') && k !== 'ORQ_URL' && !isSecretName(k)));
}
