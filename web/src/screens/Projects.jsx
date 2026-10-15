import { useCallback, useEffect, useState } from 'react';
import { api, ago } from '../api.js';

// Proyectos: el repositorio con el que trabajan los workflows y su memoria (notas). Un workflow elige su
// proyecto en el panel «Workflow» (o el webhook manda body.project): sus agentes reciben la carpeta (mapa
// del repositorio) y las notas aprobadas. Las notas que proponen los agentes esperan aquí a que alguien
// las apruebe; hasta entonces no se usan.

const desktop = typeof window !== 'undefined' ? window.orquestaDesktop : null;
const EMPTY = { name: '', path: '', description: '' };

function ProjectForm({ initial = EMPTY, onSaved, onCancel, submit = 'Crear proyecto' }) {
  const [f, setF] = useState({ ...EMPTY, ...initial });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const set = patch => setF(x => ({ ...x, ...patch }));
  const pick = async () => {
    const r = await desktop.pickFile({ purpose: 'folder', current: f.path }).catch(e => ({ canceled: true, reason: e.message }));
    if (!r.canceled) set({ path: r.path, ...(f.name ? {} : { name: r.path.split(/[\\/]/).filter(Boolean).pop() }) });
  };
  const save = async () => {
    setMsg(''); setBusy(true);
    try { onSaved(await api(initial.id ? `/projects/${initial.id}` : '/projects', { method: initial.id ? 'PUT' : 'POST', body: f })); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="card elev-sm conn-form">
      {!initial.id && <div className="card-title" style={{ fontSize: 15 }}>Nuevo proyecto</div>}
      <div className="field">
        <label>Carpeta del repositorio (ruta absoluta)</label>
        <input className="input mono" value={f.path} onChange={e => set({ path: e.target.value })} placeholder="C:\GITHUB\mi-repo" autoFocus={!initial.id} />
        {desktop && <div className="picker-row"><button type="button" className="btn btn-secondary btn-sm" onClick={pick}><i className="ph ph-folder-open" />Examinar…</button></div>}
        <small className="help">Se concede permiso de lectura en la carpeta: los agentes del proyecto la exploran (nunca .env ni claves).</small>
      </div>
      <div className="field"><label>Nombre</label><input className="input" value={f.name} maxLength={80} onChange={e => set({ name: e.target.value })} placeholder="mi-repo" /></div>
      <div className="field"><label>Descripción <small className="muted">(opcional)</small></label><input className="input" value={f.description} maxLength={500} onChange={e => set({ description: e.target.value })} /></div>
      {msg && <div className="banner-err">{msg}</div>}
      <div className="row" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {onCancel && <button className="btn btn-secondary btn-sm" onClick={onCancel} disabled={busy}>Cancelar</button>}
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy || !f.path.trim()}><i className="ph ph-floppy-disk" />{submit}</button>
      </div>
    </div>
  );
}

const pathsText = list => (list || []).join(', ');

// Una nota: texto, ficheros a los que se refiere, de dónde viene; editable en el sitio
function Note({ n, onChange, onRemove }) {
  const [edit, setEdit] = useState(null);
  const [msg, setMsg] = useState('');
  const pending = n.status === 'propuesta';
  const save = async patch => {
    setMsg('');
    try { await onChange(patch); setEdit(null); } catch (e) { setMsg(e.message); }
  };
  return (
    <div className={`note ${pending ? 'is-pending' : ''}`}>
      {edit ? (
        <>
          <textarea className="input" rows={3} value={edit.text} maxLength={1500} onChange={e => setEdit(x => ({ ...x, text: e.target.value }))} autoFocus />
          <input className="input mono" value={edit.paths} onChange={e => setEdit(x => ({ ...x, paths: e.target.value }))} placeholder="Ficheros a los que se refiere (rutas relativas, separadas por comas)" />
        </>
      ) : (
        <>
          <div className="note-text">{n.text}</div>
          {n.paths.length > 0 && <div className="tags">{n.paths.map(p => <span key={p} className="tag tag-neutral mono">{p}</span>)}</div>}
        </>
      )}
      <div className="note-foot">
        <span className="muted">
          {n.source === 'usuario' ? 'Añadida por ti' : `Propuesta por ${n.source}`} · {ago(n.createdAt)}
          {n.commitRef && <> · commit <span className="mono">{n.commitRef.slice(0, 7)}</span></>}
          {n.runId && <> · <a href={`#/runs/${n.runId}`}>ejecución</a></>}
        </span>
        <div className="note-actions">
          {edit ? (
            <>
              <button className="btn btn-secondary btn-xs-text" onClick={() => setEdit(null)}>Cancelar</button>
              <button className="btn btn-primary btn-xs-text" onClick={() => save({ text: edit.text, paths: edit.paths, ...(pending ? { status: 'aprobada' } : {}) })}><i className="ph ph-check" />{pending ? 'Guardar y aprobar' : 'Guardar'}</button>
            </>
          ) : (
            <>
              {pending && <button className="btn btn-primary btn-xs-text" onClick={() => save({ status: 'aprobada' })}><i className="ph ph-check" />Aprobar</button>}
              <button className="btn btn-secondary btn-xs-text" onClick={() => setEdit({ text: n.text, paths: pathsText(n.paths) })}><i className="ph ph-pencil-simple" />Editar</button>
              <button className="btn btn-secondary btn-xs-text" onClick={onRemove}>{pending ? 'Descartar' : <i className="ph ph-trash" />}</button>
            </>
          )}
        </div>
      </div>
      {msg && <small className="help" style={{ color: 'var(--err)' }}>{msg}</small>}
    </div>
  );
}

function AddNote({ projectId, onAdded }) {
  const [text, setText] = useState('');
  const [paths, setPaths] = useState('');
  const [msg, setMsg] = useState('');
  const add = async () => {
    setMsg('');
    try { await api(`/projects/${projectId}/notes`, { method: 'POST', body: { text, paths } }); setText(''); setPaths(''); onAdded(); }
    catch (e) { setMsg(e.message); }
  };
  return (
    <div className="note add">
      <textarea className="input" rows={2} value={text} maxLength={1500} onChange={e => setText(e.target.value)} placeholder="Algo que los agentes deberían saber: una convención, dónde está un módulo clave, qué evitar…" />
      <div className="note-foot">
        <input className="input mono" value={paths} onChange={e => setPaths(e.target.value)} placeholder="Ficheros (opcional): server/src/engine.js, …" />
        <button className="btn btn-primary btn-xs-text" onClick={add} disabled={!text.trim()}><i className="ph ph-plus" />Añadir nota</button>
      </div>
      {msg && <small className="help" style={{ color: 'var(--err)' }}>{msg}</small>}
    </div>
  );
}

function ProjectDetail({ id, subscribe }) {
  const [project, setProject] = useState(null);
  const [notes, setNotes] = useState(null);
  const [usedBy, setUsedBy] = useState([]);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => {
    api(`/projects/${id}`).then(setProject).catch(e => setErr(e.message));
    api(`/projects/${id}/notes`).then(setNotes).catch(e => setErr(e.message));
    api('/projects').then(l => setUsedBy(l.find(p => p.id === id)?.workflows || [])).catch(() => {});
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribe?.(m => { if (m.type === 'notes' && (!m.projectId || m.projectId === id)) load(); }), [subscribe, id, load]);

  const change = (n, patch) => api(`/notes/${n.id}`, { method: 'PUT', body: patch }).then(load);
  const remove = n => {
    if (n.status === 'aprobada' && !confirm('¿Borrar esta nota? Los agentes dejarán de recibirla.')) return;
    api(`/notes/${n.id}`, { method: 'DELETE' }).then(load).catch(e => setErr(e.message));
  };
  const del = () => {
    if (!confirm(`¿Borrar el proyecto «${project.name}» y sus notas? Los workflows que lo usan seguirán funcionando sin proyecto. La carpeta no se toca.`)) return;
    api(`/projects/${id}`, { method: 'DELETE' }).then(() => { location.hash = '#/projects'; }).catch(e => setErr(e.message));
  };
  if (err && !project) return <main className="page"><div className="page-inner"><div className="banner-err">{err}</div><a href="#/projects">Volver a Proyectos</a></div></main>;
  if (!project) return <main className="page"><div className="page-inner"><p className="muted">Cargando…</p></div></main>;
  const pending = (notes || []).filter(n => n.status === 'propuesta');
  const approved = (notes || []).filter(n => n.status === 'aprobada');

  return (
    <main className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="proj-head">
            <a className="crumb" href="#/projects">Proyectos</a>
            <h3>{project.name}</h3>
            <span className="sub mono">{project.path}</span>
            {project.description && <span className="sub">{project.description}</span>}
          </div>
          {!editing && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" onClick={() => setEditing(true)}><i className="ph ph-pencil-simple" />Editar</button>
              <button className="btn btn-secondary" onClick={del}><i className="ph ph-trash" />Borrar</button>
            </div>
          )}
        </div>
        {err && <div className="banner-err">{err}</div>}
        {editing && <ProjectForm initial={project} submit="Guardar" onCancel={() => setEditing(false)} onSaved={p => { setProject(p); setEditing(false); }} />}

        <div className="proj-uses">
          <i className="ph ph-tree-structure" />
          {usedBy.length
            ? <span>Lo usan: {usedBy.map((w, i) => <span key={w.id}>{i > 0 && ', '}<a href={`#/editor/${w.id}`}>{w.name}</a></span>)}</span>
            : <span className="muted">Ningún workflow lo usa todavía: elígelo en el panel «Workflow» del editor (o manda <span className="mono">body.project</span> al webhook).</span>}
        </div>

        <div className="section-rule"><span className="eyebrow">Pendientes de revisar · {pending.length}</span><span className="rule" /></div>
        {pending.length
          ? <div className="notes">{pending.map(n => <Note key={n.id} n={n} onChange={patch => change(n, patch)} onRemove={() => remove(n)} />)}</div>
          : <p className="muted" style={{ fontSize: 13 }}>Nada pendiente. Los agentes con la herramienta <span className="mono">proponer_nota</span> pueden proponer notas mientras trabajan; no se usan hasta que las apruebes aquí.</p>}

        <div className="section-rule"><span className="eyebrow">Notas del proyecto · {approved.length}</span><span className="rule" /></div>
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Los agentes las reciben junto al mapa del repositorio, como datos (no como instrucciones). Si una cita ficheros que han cambiado desde que se escribió, se les avisa de que puede estar desactualizada.</p>
        <div className="notes">
          {approved.map(n => <Note key={n.id} n={n} onChange={patch => change(n, patch)} onRemove={() => remove(n)} />)}
          <AddNote projectId={id} onAdded={load} />
        </div>
      </div>
    </main>
  );
}

function ProjectList({ subscribe }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api('/projects').then(setList).catch(e => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribe?.(m => { if (m.type === 'notes') load(); }), [subscribe, load]);
  return (
    <main className="page">
      <div className="page-inner">
        <div className="page-head">
          <div><h3>Proyectos</h3><span className="sub">El repositorio con el que trabajan tus workflows y lo que los agentes deben saber de él. Sus agentes reciben el mapa del repositorio y las notas aprobadas.</span></div>
          {!adding && <button className="btn btn-primary" onClick={() => setAdding(true)}><i className="ph ph-plus" />Nuevo proyecto</button>}
        </div>
        {err && <div className="banner-err">{err}</div>}
        {adding && <ProjectForm onCancel={() => setAdding(false)} onSaved={p => { setAdding(false); location.hash = `#/projects/${p.id}`; }} />}
        <div className="proj-grid">
          {(list || []).map(p => (
            <a key={p.id} className="proj-card" href={`#/projects/${p.id}`}>
              <div className="proj-card-head">
                <div className="tile sm"><i className="ph ph-folder-simple" /></div>
                <b>{p.name}</b>
                {p.notes.propuestas > 0 && <span className="tag tag-warn" title="Notas propuestas por agentes pendientes de revisar">{p.notes.propuestas} por revisar</span>}
              </div>
              <span className="mono proj-path">{p.path}</span>
              {p.description && <span className="muted">{p.description}</span>}
              <span className="muted proj-meta">{p.notes.aprobadas} nota{p.notes.aprobadas === 1 ? '' : 's'} · {p.workflows.length} workflow{p.workflows.length === 1 ? '' : 's'}</span>
            </a>
          ))}
        </div>
        {list && !list.length && !adding && <p className="muted">Aún no hay proyectos. Crea uno con la carpeta de tu repositorio y elígelo en tus workflows de Coding.</p>}
      </div>
    </main>
  );
}

export default function Projects({ id, subscribe }) {
  return id ? <ProjectDetail id={id} subscribe={subscribe} /> : <ProjectList subscribe={subscribe} />;
}
