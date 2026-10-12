import { createRequire } from 'node:module';
import cron from 'node-cron';
import { Workflows, Runs } from './db.js';
import { describeCron } from '@orquesta/shared/cron';

export { describeCron };

// Workflows programados (nodos Cron de workflows activos): horario en palabras, próxima ejecución
// y última. La expresión se expande con el mismo conversor que usa node-cron para ejecutar (nombres,
// rangos y pasos → números; todos los campos deben cumplirse), así la «próxima» coincide con la real.

const require = createRequire(import.meta.url);
const convert = require('node-cron/src/convert-expression');

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map();
function wallClock(tz) {
  const key = tz || '';
  if (!fmtCache.has(key)) {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    fmtCache.set(key, d => {
      const o = Object.fromEntries(dtf.formatToParts(d).map(p => [p.type, p.value]));
      return { mon: +o.month, dom: +o.day, h: +o.hour, m: +o.minute, dow: WD[o.weekday] };
    });
  }
  return fmtCache.get(key);
}

// Próxima fecha (> from) en que se cumple la expresión, o null si no hay en el próximo año
export function nextRun(expr, tz, from = new Date()) {
  if (!cron.validate(expr)) return null;
  const [S, M, H, D, MO, W] = convert(expr).split(' ').map(f => new Set(f.split(',').map(n => Number(n))));
  if (W.has(7)) W.add(0);
  const at = wallClock(tz);
  const secs = [...S].sort((a, b) => a - b);
  let t = Math.floor(from.getTime() / 60000) * 60000;
  const end = t + 366 * 864e5;
  while (t < end) {
    const p = at(new Date(t));
    if (!(MO.has(p.mon) && D.has(p.dom) && W.has(p.dow))) {
      // Día que no vale: se salta casi hasta el final del día (sin pasarse por los cambios de hora)
      const left = (23 - p.h) * 60 + (60 - p.m);
      t += Math.max(1, left > 120 ? left - 120 : 60 - p.m) * 60000;
    } else if (!H.has(p.h)) {
      t += (60 - p.m) * 60000;
    } else if (!M.has(p.m)) {
      t += 60000;
    } else {
      const s = secs.find(x => t + x * 1000 > from.getTime());
      if (s !== undefined) return new Date(t + s * 1000);
      t += 60000;
    }
  }
  return null;
}

// Un elemento por nodo Cron de cada workflow activo
export function listSchedules(now = new Date()) {
  const last = Runs.lastByWorkflowMode('cron');
  const out = [];
  for (const w of Workflows.list()) {
    if (!w.active) continue;
    for (const n of w.graph?.nodes || []) {
      if (n.type !== 'cron') continue;
      const expr = String(n.params?.expr || '').trim(), tz = n.params?.tz || '';
      const valid = cron.validate(expr);
      out.push({
        workflowId: w.id, workflowName: w.name, collection: w.collection || '', nodeId: n.id, nodeName: n.name, expr, tz, valid,
        descripcion: valid ? describeCron(expr) : null,
        proxima: valid ? nextRun(expr, tz || undefined, now)?.getTime() ?? null : null,
        ultima: last[w.id] || null,
      });
    }
  }
  return out.sort((a, b) => (a.proxima ?? Infinity) - (b.proxima ?? Infinity));
}
