import { Fragment, useEffect, useRef, useState } from 'react';
import { api, ago, dur, pretty, STATUS } from '../api.js';
import { ReviewParams, LlmMeta, DecisionButtons, approvalText, DataTable, findRows } from '../NodePanel.jsx';
import Trace from '../Trace.jsx';

export default function RunDetail({ id, subscribe }) {
  const [run, setRun] = useState(null);
  const [open, setOpen] = useState(null);
  const [err, setErr] = useState('');
  const [saveCase, setSaveCase] = useState(null); // { datasets, datasetId, name }
  const [saved, setSaved] = useState('');
  const t = useRef(null);
  const load = () => api(`/runs/${id}`).then(setRun).catch(e => setErr(e.message));

  useEffect(() => { load(); }, [id]);
  useEffect(() => subscribe(m => {
    if ((m.type === 'run' && m.run.id === id) || (m.runId === id)) {
      clearTimeout(t.current);
      t.current = setTimeout(load, 150);
    }
  }), [id, subscribe]);

  if (!run) return <main className="page"><div className="page-inner">{err || 'Cargando…'}</div></main>;
  const s = STATUS[run.status] || STATUS.running;
  const activeRun = ['running', 'waiting'].includes(run.status);
  const decide = (nodeId, approved, scope) => api(`/runs/${id}/approvals/${nodeId}`, { method: 'POST', body: { approved, scope, by: localStorage.getItem('orq_user') || 'panel' } }).catch(e => setErr(e.message));
  const startSave = () => api(`/workflows/${run.workflowId}/datasets`).then(d => {
    const ds = d.datasets.filter(x => x.kind !== 'capture');
    setSaved(''); setSaveCase({ datasets: ds, datasetId: ds[0]?.id || '', name: `Desde ${run.id}` });
  }, e => setErr(e.message));
  const doSave = () => api(`/runs/${id}/save-as-case`, { method: 'POST', body: { datasetId: saveCase.datasetId || undefined, name: saveCase.name } })
    .then(c => { setSaveCase(null); setSaved(`Guardado como caso «${c.name}». Lo tienes en el panel Ejecutar del editor.`); }, e => setErr(e.message));

  return (
    <main className="page">
      <div className="page-inner">
        <a className="crumb" href="#/runs"><i className="ph ph-arrow-left" /> Ejecuciones</a>
        <div className="page-head">
          <div>
            <h3 className="mono" style={{ fontSize: 22 }}>{run.id}</h3>
            <span className="sub"><a href={`#/editor/${run.workflowId}`}>{run.workflowName}</a> · {run.mode} · {ago(run.startedAt)} · {dur(run.startedAt, run.finishedAt)}</span>
          </div>
          <span className="status big" style={{ color: s.color }}><span className={`dot ${s.pulse ? 'pulse' : ''}`} style={{ background: s.color }} />{s.label}</span>
          {activeRun && <button className="btn btn-secondary" onClick={() => api(`/runs/${id}/cancel`, { method: 'POST' }).catch(e => setErr(e.message))}><i className="ph ph-stop" />Detener</button>}
          {!run.parentRunId && !saveCase && <button className="btn btn-secondary" onClick={startSave} title="Guarda la entrada de esta ejecución como caso de prueba"><i className="ph ph-flask" />Guardar como caso</button>}
        </div>
        {saveCase && (
          <div className="card elev-sm save-case">
            <span className="eyebrow">Guardar como caso de prueba</span>
            <div className="grid2">
              <div className="field"><label>Conjunto</label>
                <select className="input" value={saveCase.datasetId} onChange={e => setSaveCase(s => ({ ...s, datasetId: e.target.value }))}>
                  {!saveCase.datasets.length && <option value="">Por defecto (se crea)</option>}
                  {saveCase.datasets.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div className="field"><label>Nombre del caso</label><input className="input" value={saveCase.name} onChange={e => setSaveCase(s => ({ ...s, name: e.target.value }))} /></div>
            </div>
            <div className="row" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setSaveCase(null)}>Cancelar</button>
              <button className="btn btn-primary btn-sm" disabled={!saveCase.name.trim()} onClick={doSave}><i className="ph ph-floppy-disk" />Guardar</button>
            </div>
          </div>
        )}
        {saved && <div className="banner-ok">{saved}</div>}
        {err && <div className="banner-err">{err}</div>}
        {run.error && <div className="banner-err">{run.error}</div>}
        {run.pending?.map(nid => {
          const st = run.steps.filter(x => x.nodeId === nid).pop();
          return (
            <div key={nid} className="approval-card">
              <b>{st?.nodeName || nid} · {approvalText(st?.meta).title}</b>
              {st?.meta?.permiso && <span>{approvalText(st.meta).text}</span>}
              <ReviewParams meta={st?.meta} />
              <DecisionButtons meta={st?.meta} onDecide={(ok, scope) => decide(nid, ok, scope)} />
            </div>
          );
        })}

        {run.parentRunId && <div className="muted" style={{ fontSize: 12.5 }}><i className="ph ph-arrow-bend-left-up" /> Lanzada como sub-workflow por <a href={`#/runs/${run.parentRunId}`} className="mono">{run.parentRunId}</a></div>}
        <div>
          <span className="eyebrow">Traza</span>
          <Trace runId={id} refresh={`${run.status}|${run.steps.length}`} header={false} />
        </div>

        <table className="table">
          <thead><tr><th>Paso</th><th>Estado</th><th>Worker</th><th>Duración</th><th /></tr></thead>
          <tbody>
            {run.steps.map(st => {
              const ss = STATUS[st.status] || STATUS.running;
              return (
                <Fragment key={st.id}>
                  <tr className="clickable" onClick={() => setOpen(open === st.id ? null : st.id)}>
                    <td><b>{st.nodeName}</b> <small className="muted">{st.nodeType}{st.attempt > 1 ? ` · intento ${st.attempt}` : ''}</small></td>
                    <td><span className="status" style={{ color: ss.color }}><span className="dot" style={{ background: ss.color }} />{ss.label}</span></td>
                    <td className="mono accent">{st.worker || '—'}</td>
                    <td className="mono">{dur(st.startedAt, st.finishedAt)}</td>
                    <td><i className={`ph ${open === st.id ? 'ph-caret-up' : 'ph-caret-down'} muted`} /></td>
                  </tr>
                  {open === st.id && (
                    <tr><td colSpan={5}>
                      {st.meta?.llm && <div className="meta-rows"><LlmMeta meta={st.meta} /></div>}
                      {!st.error && <DataTable value={st.output} />}
                      <div className="io">
                        <div><span className="eyebrow">Entrada</span><pre className="out">{pretty(st.input)}</pre></div>
                        <div><span className="eyebrow">{st.error ? 'Error' : 'Salida'}</span><pre className={`out ${st.error ? 'err' : ''}`}>{st.error || pretty(st.output)}</pre></div>
                      </div>
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>

        {run.output != null && findRows(run.output) && <div><span className="eyebrow">Salida final</span><DataTable value={run.output} /></div>}
        <div className="io">
          <div><span className="eyebrow">Entrada del disparador</span><pre className="out">{pretty(run.input)}</pre></div>
          <div><span className="eyebrow">Salida final</span><pre className="out">{run.output != null ? pretty(run.output) : '—'}</pre></div>
        </div>

        <div>
          <span className="eyebrow">Logs</span>
          <div className="logs-body mono standalone">
            {run.logs.map(l => (
              <div key={l.id} className="log-row">
                <span className="log-t">{new Date(l.ts).toLocaleTimeString('es')}</span>
                <span className={`lvl lvl-${l.level}`}>{l.level}</span>
                <span className="log-node">{l.node || '—'}</span>
                <span className="log-worker">{l.worker || ''}</span>
                <span className="log-msg wrap">{l.msg}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
