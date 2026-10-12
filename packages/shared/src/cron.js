// Horario de un nodo Cron en palabras (lo usan el servidor y la UI). Solo los casos habituales.

const DAYS = { '*': '', '1-5': 'de lunes a viernes', '0,6': 'sábados y domingos', '6,0': 'sábados y domingos', '0': 'los domingos', '1': 'los lunes', '2': 'los martes', '3': 'los miércoles', '4': 'los jueves', '5': 'los viernes', '6': 'los sábados', '7': 'los domingos' };
const two = n => String(n).padStart(2, '0');
// null si no hay una forma sencilla de decirlo: se muestra la expresión tal cual
export function describeCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length === 6) {
    const [s, ...rest] = f;
    if (rest.every(x => x === '*')) return s === '*' ? 'cada segundo' : /^\*\/\d+$/.test(s) ? `cada ${s.slice(2)} segundos` : null;
    if (s !== '0') return null;
    return describeCron(rest.join(' '));
  }
  if (f.length !== 5) return null;
  const [m, h, dom, mon, dow] = f;
  const days = DAYS[dow];
  if (mon !== '*' || days === undefined) return null;
  if (dom !== '*') {
    if (!/^\d+$/.test(dom) || dow !== '*' || !/^\d+$/.test(m) || !/^\d+$/.test(h)) return null;
    return `el día ${dom} de cada mes a las ${two(h)}:${two(m)}`;
  }
  const when = days ? `${days} ` : '';
  if (h === '*') {
    if (m === '*') return days ? `cada minuto, ${days}` : 'cada minuto';
    if (/^\*\/\d+$/.test(m)) return `cada ${m.slice(2)} minutos${days ? `, ${days}` : ''}`;
    if (/^\d+$/.test(m)) return `cada hora ${m === '0' ? 'en punto' : `en el minuto ${m}`}${days ? `, ${days}` : ''}`;
    return null;
  }
  if (/^\*\/\d+$/.test(h) && /^\d+$/.test(m)) return `cada ${h.slice(2)} horas, en el minuto ${m}${days ? `, ${days}` : ''}`;
  if (/^\d+$/.test(m) && /^[\d,]+$/.test(h)) {
    const hours = h.split(',').map(x => `${two(x)}:${two(m)}`);
    return `${when || 'todos los días '}a las ${hours.length > 1 ? `${hours.slice(0, -1).join(', ')} y ${hours.at(-1)}` : hours[0]}`;
  }
  return null;
}
