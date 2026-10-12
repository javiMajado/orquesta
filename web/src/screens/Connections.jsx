import { useEffect, useState } from 'react';
import { api, ago } from '../api.js';

const DRIVER = { pg: 'PostgreSQL', sqlite: 'SQLite' };
const SSL = [['no', 'No'], ['si', 'Sí'], ['sin-verificar', 'Sí, sin verificar certificado']];
const EMPTY = { name: '', driver: 'pg', readOnly: true, config: { host: 'localhost', port: 5432, database: '', user: '', ssl: 'no' }, password: '' };
const desktop = typeof window !== 'undefined' ? window.orquestaDesktop : null;

const target = c => (c.driver === 'sqlite' ? c.config.file
  : c.config.url || `${c.config.user ? `${c.config.user}@` : ''}${c.config.host}:${c.config.port}/${c.config.database}`);

function Form({ initial, onSaved, onCancel }) {
  const editing = !!initial.id;
  const [f, setF] = useState(() => ({ ...EMPTY, ...initial, config: { ...EMPTY.config, ...(initial.config || {}) }, password: undefined }));
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = patch => setF(x => ({ ...x, ...patch }));
  const setC = patch => setF(x => ({ ...x, config: { ...x.config, ...patch } }));
  // Solo se envía la contraseña si se ha escrito algo (vacío al editar = sin cambios)
  const body = () => ({ ...f, password: f.password === undefined || (editing && f.password === '') ? undefined : f.password });

  const test = async () => {
    setBusy(true); setMsg(null);
    try { const r = await api('/connections/test', { method: 'POST', body: body() }); setMsg({ ok: true, text: `Conexión correcta (${r.ms} ms)` }); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await api(editing ? `/connections/${f.id}` : '/connections', { method: editing ? 'PUT' : 'POST', body: body() });
      onSaved();
    } catch (e) { setMsg({ ok: false, text: e.message }); setBusy(false); }
  };
  const pickFile = async () => {
    const r = await desktop.pickFile({ mode: 'open', current: f.config.file || '', purpose: 'db' }).catch(e => ({ canceled: true, reason: e.message }));
    if (!r.canceled) setC({ file: r.path });
  };

  return (
    <div className="card elev-sm conn-form">
      <div className="card-title" style={{ fontSize: 15 }}>{editing ? `Editar «${initial.name}»` : 'Nueva conexión'}</div>
      <div className="grid2">
        <div className="field"><label>Nombre</label><input className="input" value={f.name} onChange={e => set({ name: e.target.value })} placeholder="p. ej. CRM producción" /></div>
        <div className="field"><label>Tipo</label>
          <select className="input" value={f.driver} onChange={e => set({ driver: e.target.value })}>
            <option value="pg">PostgreSQL</option><option value="sqlite">SQLite</option>
          </select>
        </div>
      </div>
      {f.driver === 'pg' ? (
        <>
          <div className="grid2">
            <div className="field"><label>Servidor</label><input className="input mono" value={f.config.host} onChange={e => setC({ host: e.target.value })} /></div>
            <div className="field"><label>Puerto</label><input className="input mono" value={f.config.port} onChange={e => setC({ port: e.target.value })} /></div>
          </div>
          <div className="grid2">
            <div className="field"><label>Base de datos</label><input className="input mono" value={f.config.database} onChange={e => setC({ database: e.target.value })} /></div>
            <div className="field"><label>Usuario</label><input className="input mono" value={f.config.user} onChange={e => setC({ user: e.target.value })} autoComplete="off" /></div>
          </div>
          <div className="grid2">
            <div className="field">
              <label>Contraseña</label>
              <input className="input mono" type="password" autoComplete="new-password" value={f.password ?? ''} placeholder={editing && initial.hasPassword ? '•••••••• (sin cambios)' : ''} onChange={e => set({ password: e.target.value })} />
              <small className="help">Se guarda cifrada y no se vuelve a mostrar.</small>
            </div>
            <div className="field"><label>SSL</label>
              <select className="input" value={f.config.ssl} onChange={e => setC({ ssl: e.target.value })}>{SSL.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </div>
          </div>
        </>
      ) : (
        <div className="field">
          <label>Fichero SQLite (ruta absoluta)</label>
          <input className="input mono" value={f.config.file || ''} onChange={e => setC({ file: e.target.value })} placeholder="C:\datos\mi-base.db" />
          {desktop && <div className="picker-row"><button type="button" className="btn btn-secondary btn-sm" onClick={pickFile}><i className="ph ph-folder-open" />Examinar…</button></div>}
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={f.readOnly} onChange={e => set({ readOnly: e.target.checked })} />
        <span><b>Solo lectura</b><small className="help">Recomendado. Los nodos solo podrán consultar (SELECT); cualquier intento de modificar datos falla. Para garantía total, usa además un usuario de BD sin permisos de escritura.</small></span>
      </label>
      {msg && <div className={msg.ok ? 'banner-ok' : 'banner-err'}>{msg.text}</div>}
      <div className="row" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-secondary btn-sm" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button className="btn btn-secondary btn-sm" onClick={test} disabled={busy}><i className="ph ph-plugs-connected" />Probar conexión</button>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}><i className="ph ph-floppy-disk" />Guardar</button>
      </div>
    </div>
  );
}

export default function Connections() {
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(null);
  const [tests, setTests] = useState({});
  const load = () => api('/connections').then(setList).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  const test = async c => {
    setTests(t => ({ ...t, [c.id]: { busy: true } }));
    try { const r = await api('/connections/test', { method: 'POST', body: { id: c.id } }); setTests(t => ({ ...t, [c.id]: { ok: true, text: `OK · ${r.ms} ms` } })); }
    catch (e) { setTests(t => ({ ...t, [c.id]: { ok: false, text: e.message } })); }
  };
  const remove = async c => {
    if (!confirm(`¿Eliminar la conexión «${c.name}»? Los nodos que la usen dejarán de funcionar.`)) return;
    await api(`/connections/${c.id}`, { method: 'DELETE' }).catch(e => setErr(e.message));
    load();
  };

  return (
    <main className="page">
      <div className="page-inner">
        <div className="page-head">
          <div><h3>Conexiones</h3><span className="sub">Bases de datos que pueden usar los nodos «Base de datos».</span></div>
          {!form && <button className="btn btn-primary" onClick={() => setForm(EMPTY)}><i className="ph ph-plus" />Nueva conexión</button>}
        </div>
        {err && <div className="banner-err">{err}</div>}
        {form && <Form key={form.id || 'nueva'} initial={form} onCancel={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />}

        <table className="table">
          <thead><tr><th>Nombre</th><th>Tipo</th><th>Destino</th><th>Acceso</th><th /></tr></thead>
          <tbody>
            {(list || []).map(c => (
              <tr key={c.id}>
                <td><div className="cell-2"><span>{c.name}</span><small>{c.source === 'env' ? 'desde .env (DB_CONNECTIONS)' : `modificada ${ago(c.updatedAt)}`}</small></div></td>
                <td>{DRIVER[c.driver] || c.driver}</td>
                <td className="mono" style={{ maxWidth: 360, overflowWrap: 'anywhere' }}>{target(c)}</td>
                <td>{c.readOnly ? <span className="tag tag-neutral">Solo lectura</span> : <span className="tag" style={{ color: 'var(--warn)' }}>Lectura y escritura</span>}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {tests[c.id] && !tests[c.id].busy && <small style={{ color: tests[c.id].ok ? 'var(--ok)' : 'var(--err)', marginRight: 8, display: 'inline-block', maxWidth: 260, whiteSpace: 'normal', verticalAlign: 'middle' }}>{tests[c.id].text}</small>}
                  <button className="btn btn-secondary btn-sm" onClick={() => test(c)} disabled={tests[c.id]?.busy}>{tests[c.id]?.busy ? 'Probando…' : 'Probar'}</button>{' '}
                  {c.source === 'ui' && <>
                    <button className="btn btn-icon btn-xs" title="Editar" onClick={() => setForm(c)}><i className="ph ph-pencil-simple" /></button>
                    <button className="btn btn-icon btn-xs" title="Eliminar" onClick={() => remove(c)}><i className="ph ph-trash" /></button>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list && !list.length && !form && <p className="muted">Aún no hay conexiones. Pulsa «Nueva conexión» para dar de alta la primera.</p>}
      </div>
    </main>
  );
}
