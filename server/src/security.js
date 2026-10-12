// Protección de la instancia local frente a otras webs abiertas en el navegador y a la red.
//  · Host: solo localhost / 127.0.0.1 (+ ALLOWED_HOSTS). Evita DNS rebinding: una web maliciosa
//    no puede apuntar su dominio a 127.0.0.1 y hablar con la API como si fuera del mismo origen.
//  · Origin: si la petición viene de un navegador, debe ser la propia UI (+ ALLOWED_ORIGINS).
//    Evita que una web cualquiera dispare webhooks, cree workflows o lea eventos en vivo.
//  · Sec-Fetch-Site: cross-site se rechaza (cubre GET sin Origin, p.ej. <img src=".../hooks/x">).
// Los clientes que no son navegadores (curl, workers) no envían Origin y pasan si el Host es válido.

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

export function makePolicy({ port, allowedHosts = [], allowedOrigins = [] }) {
  const hosts = new Set([...LOCAL_HOSTS, ...allowedHosts.map(h => h.toLowerCase())]);
  const origins = new Set([
    ...[port, 5173].flatMap(p => [`http://localhost:${p}`, `http://127.0.0.1:${p}`, `http://[::1]:${p}`]),
    ...allowedOrigins.map(o => o.replace(/\/+$/, '').toLowerCase()),
  ]);

  const hostOk = host => {
    if (!host) return false;
    const name = String(host).toLowerCase().replace(/:\d+$/, '');
    return hosts.has(name);
  };
  const originOk = origin => !origin || origins.has(String(origin).toLowerCase());

  // Devuelve null si se permite o el motivo del rechazo
  function check(headers) {
    if (!hostOk(headers.host)) return `Host no permitido: ${headers.host || '(vacío)'}`;
    if (!originOk(headers.origin)) return `Origen no permitido: ${headers.origin}`;
    if (headers['sec-fetch-site'] === 'cross-site' && !headers.origin) return 'Petición cross-site no permitida';
    return null;
  }

  const middleware = (req, res, next) => {
    const why = check(req.headers);
    if (!why) return next();
    res.status(403).json({ error: why });
  };

  return { hostOk, originOk, check, middleware };
}
