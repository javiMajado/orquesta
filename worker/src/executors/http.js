const parseMaybe = v => {
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

export default async function http(p, _input, { signal, log }) {
  if (!p.url) throw new Error('La URL está vacía');
  const method = (p.method || 'GET').toUpperCase();
  const headers = { ...(parseMaybe(p.headers) || {}) };
  let body = parseMaybe(p.body);
  if (body !== undefined && typeof body === 'object') {
    body = JSON.stringify(body);
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  }
  const r = await fetch(p.url, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body, signal });
  const text = await r.text();
  let data = text;
  if ((r.headers.get('content-type') || '').includes('json')) { try { data = JSON.parse(text); } catch {} }
  log(`${method} ${p.url} → ${r.status}`);
  if (!r.ok && p.failOnError !== 'No') {
    throw Object.assign(new Error(`HTTP ${r.status}: ${(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 300)}`),
      { retryable: r.status === 408 || r.status === 429 || r.status >= 500 });
  }
  return { status: r.status, headers: Object.fromEntries(r.headers), body: data };
}
