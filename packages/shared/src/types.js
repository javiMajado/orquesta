// Capacidad que un worker debe declarar para ejecutar cada tipo de nodo.
// "orq" = lo ejecuta el propio orquestador · "human" = cola de aprobación.
export const CAPS = {
  webhook: 'orq', cron: 'orq', event: 'orq',
  agent: 'llm',
  node: 'node', http: 'node', email: 'node', file: 'node', command: 'node', format: 'node',
  db: 'db',
  if: 'orq', loop: 'orq', parallel: 'orq', wait: 'orq', subflow: 'orq',
  approval: 'human',
};
export const TRIGGERS = ['webhook', 'cron', 'event'];
export const ACTION_TYPES = ['agent', 'node', 'http', 'db', 'email', 'file', 'command', 'format'];

// "60 s", "5 minutos", "4 h", 1500 → milisegundos
export function parseDuration(v, def = 60000) {
  if (v == null || v === '') return def;
  if (typeof v === 'number') return v;
  const m = String(v).trim().match(/^(\d+(?:[.,]\d+)?)\s*([a-zá]+)?$/i);
  if (!m) return def;
  const n = parseFloat(m[1].replace(',', '.'));
  const u = (m[2] || 's').toLowerCase();
  if (u === 'ms') return n;
  if (u.startsWith('s')) return n * 1000;
  if (u === 'm' || u.startsWith('min')) return n * 60000;
  if (u.startsWith('h')) return n * 3600000;
  if (u.startsWith('d')) return n * 86400000;
  return def;
}
