const token = () => localStorage.getItem('orq_token') || '';

export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token() ? { authorization: `Bearer ${token()}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    const t = window.prompt('Esta instancia requiere un token de API');
    if (t) { localStorage.setItem('orq_token', t); return api(path, { method, body }); }
  }
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

// Descarga un fichero (p. ej. CSV). Va con fetch + Blob: un <a href> directo no enviaría el Bearer token.
// Devuelve { truncated } si el servidor cortó la exportación por su límite de filas.
export async function downloadFile(path, filename) {
  const r = await fetch('/api' + path, { headers: token() ? { authorization: `Bearer ${token()}` } : {} });
  if (r.status === 401) {
    const t = window.prompt('Esta instancia requiere un token de API');
    if (t) { localStorage.setItem('orq_token', t); return downloadFile(path, filename); }
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || r.statusText);
  }
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { truncated: r.headers.get('X-Export-Truncated') === '1' };
}

// Canal de eventos en vivo (ejecuciones, pasos, logs, workers) con reconexión.
export function connectLive(onMsg) {
  let ws, closed = false, retry = 0;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = token() ? `?token=${encodeURIComponent(token())}` : '';
    ws = new WebSocket(`${proto}://${location.host}/ws/ui${q}`);
    ws.onopen = () => { retry = 0; onMsg({ type: 'connected' }); };
    ws.onmessage = e => { try { onMsg(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => {
      onMsg({ type: 'disconnected' });
      if (!closed) setTimeout(open, Math.min(10000, 500 * 2 ** retry++));
    };
  };
  open();
  return () => { closed = true; ws?.close(); };
}

export const ago = ts => {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(ts).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
export const dur = (a, b) => {
  if (!a) return '—';
  const ms = (b || Date.now()) - a;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
};
export const pretty = v => (v === undefined ? '' : JSON.stringify(v, null, 2));

export const STATUS = {
  running: { label: 'En curso', color: 'var(--color-accent)', pulse: true },
  waiting: { label: 'Esperando aprobación', color: 'var(--warn)', pulse: true },
  success: { label: 'Éxito', color: 'var(--ok)' },
  error: { label: 'Error', color: 'var(--err)' },
  cancelled: { label: 'Cancelado', color: 'var(--color-neutral-400)' },
  interrupted: { label: 'Interrumpido', color: 'var(--color-neutral-400)' },
};
