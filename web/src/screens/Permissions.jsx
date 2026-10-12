import { useEffect, useState } from 'react';
import { api, ago } from '../api.js';

const desktop = typeof window !== 'undefined' ? window.orquestaDesktop : null;
const EMPTY = { path: '', read: true, write: false, commands: '' };
const cmdText = list => (list || []).join('; ');

function AddForm({ onSaved, onCancel }) {
  const [f, setF] = useState(EMPTY);
  const [msg, setMsg] = useState('');
  const set = patch => setF(x => ({ ...x, ...patch }));
  const pick = async () => {
    const r = await desktop.pickFile({ purpose: 'folder', current: f.path }).catch(e => ({ canceled: true, reason: e.message }));
    if (!r.canceled) set({ path: r.path });
  };
  const save = async () => {
    setMsg('');
    try { await api('/permissions', { method: 'POST', body: f }); onSaved(); } catch (e) { setMsg(e.message); }
  };
  return (
    <div className="card elev-sm conn-form">
      <div className="card-title" style={{ fontSize: 15 }}>Dar permiso a una carpeta</div>
      <div className="field">
        <label>Carpeta (ruta absoluta)</label>
        <input className="input mono" value={f.path} onChange={e => set({ path: e.target.value })} placeholder="C:\GITHUB\mi-repo" autoFocus />
        {desktop && <div className="picker-row"><button type="button" className="btn btn-secondary btn-sm" onClick={pick}><i className="ph ph-folder-open" />Examinar…</button></div>}
      </div>
      <label className="check">
        <input type="checkbox" checked={f.read} onChange={e => set({ read: e.target.checked })} />
        <span><b>Lectura</b><small className="help">Nodos Fichero (leer) y herramientas listar_ficheros / leer_fichero. Nunca se leen .env ni claves.</small></span>
      </label>
      <label className="check">
        <input type="checkbox" checked={f.write} onChange={e => set({ write: e.target.checked, read: e.target.checked || f.read })} />
        <span><b>Escritura</b><small className="help">Nodos Fichero (escribir). Incluye lectura.</small></span>
      </label>
      <div className="field">
        <label>Comandos permitidos en esta carpeta</label>
        <input className="input mono" value={f.commands} onChange={e => set({ commands: e.target.value })} placeholder="npm test; npm run lint" />
        <small className="help">Exactamente como se ejecutarán, separados por «;». Valen en la carpeta y sus subcarpetas.</small>
      </div>
      {msg && <div className="banner-err">{msg}</div>}
      <div className="row" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-secondary btn-sm" onClick={onCancel}>Cancelar</button>
        <button className="btn btn-primary btn-sm" onClick={save}><i className="ph ph-shield-check" />Conceder</button>
      </div>
    </div>
  );
}

// Fila editable: los cambios se guardan al momento (casillas) o al salir del campo (comandos)
function Row({ g, onChange, onRemove }) {
  const [cmds, setCmds] = useState(cmdText(g.commands));
  useEffect(() => setCmds(cmdText(g.commands)), [g.commands]);
  return (
    <tr>
      <td className="mono" style={{ overflowWrap: 'anywhere' }}>{g.path}</td>
      <td><input type="checkbox" checked={g.read} disabled={g.write} onChange={e => onChange({ read: e.target.checked })} /></td>
      <td><input type="checkbox" checked={g.write} onChange={e => onChange({ write: e.target.checked })} /></td>
      <td><input className="input mono" value={cmds} placeholder="ninguno" onChange={e => setCmds(e.target.value)} onBlur={() => cmds !== cmdText(g.commands) && onChange({ commands: cmds })} /></td>
      <td><div className="cell-2"><span>{g.by}</span><small>{ago(g.updatedAt || g.createdAt)}</small></div></td>
      <td style={{ textAlign: 'right' }}><button className="btn btn-icon btn-xs" title="Revocar" onClick={onRemove}><i className="ph ph-trash" /></button></td>
    </tr>
  );
}

export default function Permissions() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const load = () => api('/permissions').then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  const change = (g, patch) => api(`/permissions/${g.id}`, { method: 'PUT', body: patch }).then(load).catch(e => setErr(e.message));
  const remove = g => {
    if (!confirm(`¿Revocar los permisos de ${g.path}?`)) return;
    api(`/permissions/${g.id}`, { method: 'DELETE' }).then(load).catch(e => setErr(e.message));
  };
  const env = data?.env || { folders: [], commands: [] };

  return (
    <main className="page">
      <div className="page-inner">
        <div className="page-head">
          <div><h3>Permisos</h3><span className="sub">Carpetas y comandos a los que pueden acceder los nodos y los agentes. Si un nodo necesita uno que no está aquí, te lo pedirá al ejecutarse.</span></div>
          {!adding && <button className="btn btn-primary" onClick={() => setAdding(true)}><i className="ph ph-plus" />Dar permiso</button>}
        </div>
        {err && <div className="banner-err">{err}</div>}
        {adding && <AddForm onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}

        <table className="table">
          <thead><tr><th>Carpeta</th><th>Lectura</th><th>Escritura</th><th>Comandos</th><th>Concedido por</th><th /></tr></thead>
          <tbody>
            {(data?.grants || []).map(g => <Row key={g.id} g={g} onChange={patch => change(g, patch)} onRemove={() => remove(g)} />)}
          </tbody>
        </table>
        {data && !data.grants.length && !adding && <p className="muted">Aún no has concedido ningún permiso. Pulsa «Dar permiso» o ejecuta un workflow: cuando un nodo lo necesite, te lo pedirá.</p>}

        {(env.folders.length > 0 || env.commands.length > 0) && (
          <>
            <div className="section-rule"><span className="eyebrow">Fijos del .env</span><span className="rule" /></div>
            <p className="muted" style={{ fontSize: 12 }}>Definidos por el administrador en ORQ_FILES_ALLOW (lectura y escritura) y ORQ_COMMANDS_ALLOW (en cualquier carpeta permitida). Solo se cambian editando el .env.</p>
            <table className="table">
              <tbody>
                {env.folders.map(f => <tr key={f}><td className="mono">{f}</td><td>lectura y escritura</td></tr>)}
                {env.commands.map(c => <tr key={c}><td className="mono">{c}</td><td>comando</td></tr>)}
              </tbody>
            </table>
          </>
        )}
      </div>
    </main>
  );
}
