import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, ago, STATUS } from '../api.js';
import { TYPES, TRIGGERS } from '../nodeTypes.js';
import { describeCron } from '@orquesta/shared/cron';

const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const isScheduled = w => w.active && (w.graph?.nodes || []).some(n => n.type === 'cron');

// «hoy 22:41 · en 3 min», «mañana 08:00 · en 9 h», «lun 12 oct 08:00 · en 5 días»
function when(ts, now) {
  const d = new Date(ts), today = new Date(now);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - today.setHours(0, 0, 0, 0)) / 864e5);
  const hm = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', ...(d.getSeconds() ? { second: '2-digit' } : {}) });
  const day = days === 0 ? 'hoy' : days === 1 ? 'mañana' : d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
  const s = Math.max(0, Math.round((ts - now) / 1000));
  const rel = s < 60 ? `en ${s} s` : s < 3600 ? `en ${Math.round(s / 60)} min` : s < 86400 ? `en ${Math.round(s / 3600)} h` : `en ${Math.round(s / 86400)} días`;
  return `${day} ${hm} · ${rel}`;
}

// Disparadores de un workflow para la columna «Disparador» (todos, no solo el primero)
const triggerText = n => (n.type === 'webhook' ? `${n.params?.method && n.params.method !== 'POST' ? `${n.params.method} ` : ''}${n.params?.path || ''}`
  : n.type === 'cron' ? describeCron(n.params?.expr) || n.params?.expr
  : n.type === 'event' ? n.params?.topic : '');

// Panel «Programados»: cada nodo Cron de los workflows activos
function Scheduled({ items, now, onPause }) {
  if (!items.length) return null;
  const bad = items.filter(s => !s.valid).length;
  return (
    <div className="sched card elev-sm">
      <div className="sched-head"><i className="ph ph-clock-countdown" /><b>Programados</b><small className="muted">{bad ? `${items.length - bad} en marcha · ${bad} con expresión no válida` : `${items.length} en marcha`} · se ejecutan mientras Orquesta esté abierto</small></div>
      {items.map(s => {
        const st = s.ultima && (STATUS[s.ultima.status] || STATUS.running);
        return (
          <div key={`${s.workflowId}:${s.nodeId}`} className={`sched-row ${s.valid ? '' : 'bad'}`}>
            <a className="sched-name" href={`#/editor/${s.workflowId}`}><b>{s.workflowName}</b>{s.collection && <small className="muted">{s.collection}</small>}</a>
            <div className="sched-when">
              {s.valid ? <><span>{s.descripcion || <span className="mono">{s.expr}</span>}</span><small className="muted mono">{s.expr}{s.tz ? ` · ${s.tz}` : ''}</small></>
                : <><span className="sched-err"><i className="ph-fill ph-warning-circle" />Expresión no válida: no se ejecutará</span><small className="mono">{s.expr || '(vacía)'}</small></>}
            </div>
            <div className="sched-next"><small className="muted">Próxima</small><span>{s.proxima ? when(s.proxima, now) : '—'}</span></div>
            <div className="sched-last"><small className="muted">Última</small>
              {s.ultima ? <a href={`#/runs/${s.ultima.runId}`}><span className="dot" style={{ background: st.color }} />{ago(s.ultima.startedAt)}</a> : <span className="muted">aún ninguna</span>}
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => onPause(s)} title="Desactiva el workflow: deja de ejecutarse por horario, webhook y eventos"><i className="ph ph-pause" />Pausar</button>
          </div>
        );
      })}
    </div>
  );
}

export default function Workflows({ subscribe }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const fileRef = useRef(null);
  const [sched, setSched] = useState([]);
  const [now, setNow] = useState(Date.now());
  const load = () => {
    api('/workflows').then(setList).catch(e => setErr(e.message));
    api('/schedules').then(setSched).catch(() => {});
  };

  useEffect(() => { load(); }, []);
  useEffect(() => subscribe(m => { if (m.type === 'run' || m.type === 'workflow') load(); }), [subscribe]);
  // La cuenta atrás se refresca sola; la próxima ejecución se recalcula al pasar la anterior
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, []);
  useEffect(() => { if (sched.some(s => s.proxima && s.proxima <= now)) api('/schedules').then(setSched).catch(() => {}); }, [now]);

  const create = async (body = { name: 'Nuevo workflow', graph: { nodes: [{ id: 'n1', type: 'webhook', name: 'Webhook', x: 60, y: 200, params: { method: 'POST', path: '/nuevo', auth: 'Ninguna', respond: 'Inmediato' }, exec: {} }], edges: [], settings: {} } }) => {
    try { const w = await api('/workflows', { method: 'POST', body }); location.hash = `#/editor/${w.id}`; } catch (e) { setErr(e.message); }
  };
  const importFile = async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { const j = JSON.parse(await f.text()); await create({ name: j.name || f.name.replace(/\.json$/, ''), description: j.description || '', collection: j.collection || '', graph: j.graph || j }); }
    catch (x) { setErr(`No se pudo importar: ${x.message}`); }
    e.target.value = '';
  };
  const exportWf = w => {
    const blob = new Blob([JSON.stringify({ name: w.name, description: w.description, collection: w.collection, graph: w.graph }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${w.name.replace(/[^\w-]+/g, '_')}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const toggle = async w => { await api(`/workflows/${w.id}`, { method: 'PUT', body: { active: !w.active } }).catch(e => setErr(e.message)); load(); };
  // Búsqueda: todas las palabras deben aparecer (sin distinguir tildes ni mayúsculas) en el nombre,
  // la descripción, la colección, los nombres de nodo o la ruta/horario de los disparadores
  const [q, setQ] = useState('');
  const [onlySched, setOnlySched] = useState(false);
  const terms = fold(q).split(/\s+/).filter(Boolean);
  const nSched = (list || []).filter(isScheduled).length;
  const shown = useMemo(() => (list || []).filter(w => {
    if (onlySched && !isScheduled(w)) return false;
    if (!terms.length) return true;
    const text = fold([w.name, w.description, w.collection, ...(w.graph?.nodes || []).flatMap(n => [n.name, n.params?.path, n.params?.expr, n.params?.topic])].filter(Boolean).join(' '));
    return terms.every(t => text.includes(t));
  }), [list, q, onlySched]);

  // Agrupados por colección (las con nombre primero, por orden alfabético; al final, sin colección)
  const groups = useMemo(() => {
    const m = new Map();
    for (const w of shown) m.set(w.collection || '', [...(m.get(w.collection || '') || []), w]);
    // Dentro de una colección, por nombre; sin colección, los recientes primero (como antes)
    for (const [k, v] of m) if (k) v.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    return [...m.entries()].sort(([a], [b]) => (!a) - (!b) || a.localeCompare(b, 'es'));
  }, [shown]);
  const [closed, setClosed] = useState(() => { try { return JSON.parse(localStorage.getItem('orq_closed_collections') || '[]'); } catch { return []; } });
  const flip = c => setClosed(x => {
    const next = x.includes(c) ? x.filter(y => y !== c) : [...x, c];
    try { localStorage.setItem('orq_closed_collections', JSON.stringify(next)); } catch {}
    return next;
  });
  const remove = async w => { if (!confirm(`¿Eliminar «${w.name}»?`)) return; await api(`/workflows/${w.id}`, { method: 'DELETE' }).catch(e => setErr(e.message)); load(); };

  return (
    <main className="page">
      <div className="page-inner">
        <div className="page-head">
          <div><h3>Workflows</h3><span className="sub">Flujos que el orquestador reparte entre agentes y workers.</span></div>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={importFile} />
          <button className="btn btn-secondary" onClick={() => fileRef.current.click()}><i className="ph ph-upload-simple" />Importar</button>
          <button className="btn btn-primary" onClick={() => create()}><i className="ph ph-plus" />Nuevo workflow</button>
        </div>
        {err && <div className="banner-err">{err}</div>}
        <Scheduled items={sched} now={now} onPause={s => toggle({ id: s.workflowId, active: true })} />
        <div className="wf-search">
          <i className="ph ph-magnifying-glass" />
          <input className="input" type="search" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Escape' && setQ('')}
            placeholder="Buscar por nombre, descripción, colección, nodo o ruta…" aria-label="Buscar workflows" />
          {nSched > 0 && (
            <button className={`btn btn-sm ${onlySched ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setOnlySched(x => !x)} title="Ver solo los workflows activos con algún Cron">
              <i className="ph ph-clock" />Programados ({nSched})
            </button>
          )}
          {(terms.length > 0 || onlySched) && <span className="muted">{shown.length} de {list?.length || 0}</span>}
        </div>
        <table className="table">
          <thead><tr><th>Nombre</th><th>Disparador</th><th>Nodos</th><th>Última ejecución</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {groups.map(([col, items]) => (
              <Fragment key={col || '-'}>
                {(groups.length > 1 || col) && (
                  <tr className="group-row clickable" onClick={() => flip(col)}>
                    <td colSpan={6}><i className={`ph ${closed.includes(col) && !terms.length ? 'ph-caret-right' : 'ph-caret-down'}`} /><i className="ph ph-folder-simple" />{col || 'Sin colección'}<small className="muted">{items.length}</small></td>
                  </tr>
                )}
                {(terms.length > 0 || onlySched || !closed.includes(col)) && items.map(w => {
                  const trigs = (w.graph?.nodes || []).filter(n => TRIGGERS.includes(n.type));
                  return (
                    <tr key={w.id} className="clickable" onClick={() => { location.hash = `#/editor/${w.id}`; }}>
                      <td><div className="cell-2"><b>{w.name}</b><small>{w.description}</small></div></td>
                      <td>{trigs.length ? <div className="trigs">{trigs.map(n => (
                        <span key={n.id} className="cell-icon" title={n.type === 'cron' ? `${n.params?.expr} · ${n.params?.tz || 'hora local'}` : undefined}>
                          <i className={`ph ${TYPES[n.type].icon}`} style={n.type === 'cron' && w.active ? { color: 'var(--ok)' } : undefined} />
                          {TYPES[n.type].label}{triggerText(n) ? ` · ${triggerText(n)}` : ''}
                        </span>
                      ))}</div> : <span className="muted">—</span>}</td>
                      <td className="mono">{w.graph?.nodes?.length || 0}</td>
                      <td className="muted">{w.lastRun ? `${ago(w.lastRun.startedAt)} · ${w.lastRun.status}` : '—'}</td>
                      <td><button className="toggle" onClick={e => { e.stopPropagation(); toggle(w); }}><span className={`switch ${w.active ? 'on' : ''}`}><span /></span>{w.active ? 'Activo' : 'Inactivo'}</button></td>
                      <td className="row-actions" onClick={e => e.stopPropagation()}>
                        <button className="btn btn-icon btn-xs" title="Exportar JSON" onClick={() => exportWf(w)}><i className="ph ph-download-simple" /></button>
                        <button className="btn btn-icon btn-xs" title="Eliminar" onClick={() => remove(w)}><i className="ph ph-trash" /></button>
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
        {list && !list.length && <p className="muted">Aún no hay workflows.</p>}
        {list?.length > 0 && !shown.length && <p className="muted">Ningún workflow coincide con «{q}». <button className="link-btn" onClick={() => setQ('')}>Borrar búsqueda</button></p>}
      </div>
    </main>
  );
}
