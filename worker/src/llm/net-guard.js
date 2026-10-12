import dns from 'node:dns/promises';
import net from 'node:net';

// Protección de la herramienta http_request de los agentes. Un agente puede recibir texto
// manipulado (prompt injection) y pedir URLs internas: p.ej. http://localhost:3000/api para
// crear un nodo script y ejecutar código en el PC. Por eso solo se permiten dominios de una
// lista explícita (ORQ_AGENT_HTTP_ALLOW) y nunca IPs de loopback, privadas o link-local.

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v4num = ip => ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const n = v4num(ip);
    return BLOCKED_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4num(base) / 2 ** (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
  }
  return true; // lo que no se reconoce, se bloquea
}

export const allowList = (env = process.env) =>
  String(env.ORQ_AGENT_HTTP_ALLOW || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// «api.github.com» exacto · «*.atlassian.net» cualquier subdominio
export const hostAllowed = (host, list) =>
  list.some(d => (d.startsWith('*.') ? host === d.slice(2) || host.endsWith(d.slice(1)) : host === d));

export async function checkUrl(raw, { env = process.env, lookup = dns.lookup } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`URL no válida: ${raw}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`Protocolo no permitido: ${u.protocol}`);
  const list = allowList(env);
  if (!list.length) throw new Error('http_request está desactivada: define ORQ_AGENT_HTTP_ALLOW con los dominios permitidos');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) throw new Error('No se permiten IPs directas; usa un dominio de la lista permitida');
  if (!hostAllowed(host, list)) throw new Error(`Dominio no permitido: ${host}. Permitidos: ${list.join(', ')}`);
  const addrs = await lookup(host, { all: true });
  const bad = addrs.find(a => isPrivateIp(a.address));
  if (bad) throw new Error(`${host} resuelve a una dirección interna (${bad.address}); bloqueado`);
  return u;
}

// fetch con las comprobaciones anteriores también en cada redirección (máx. 3).
export async function guardedFetch(url, opts = {}, { env, lookup } = {}) {
  let current = url;
  for (let hop = 0; hop <= 3; hop++) {
    await checkUrl(current, { env, lookup });
    const r = await fetch(current, { ...opts, redirect: 'manual' });
    const loc = r.status >= 300 && r.status < 400 && r.headers.get('location');
    if (!loc) return r;
    current = new URL(loc, current).href;
  }
  throw new Error('Demasiadas redirecciones');
}
