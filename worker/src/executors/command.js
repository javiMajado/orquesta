import { runCommand } from '../workspace.js';

// Nodo «Comando»: ejecuta un comando permitido en su carpeta (pantalla Permisos u ORQ_COMMANDS_ALLOW).
// Si aún no tiene permiso, se pide al usuario al ejecutar.
// Salida: { comando, carpeta, codigo, ok, salida, duracionMs }. Que el comando falle (código ≠ 0)
// no hace fallar el nodo salvo con «Fallar si el código no es 0» = Sí.
export default async function command(params, _input, { signal, log, timeoutMs, access }) {
  const r = await runCommand({ comando: params.comando, carpeta: params.carpeta }, { access, signal, log, timeoutMs: Math.max(1000, (timeoutMs || 600000) - 2000) });
  if (r.error) throw Object.assign(new Error(`${r.error}: ${r.comando}`), { retryable: false });
  if (!r.ok && params.failOnError === 'Sí') throw Object.assign(new Error(`«${r.comando}» terminó con código ${r.codigo}\n${r.salida.slice(-2000)}`), { retryable: false });
  return r;
}
