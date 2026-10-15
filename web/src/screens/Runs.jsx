import { useEffect, useState } from 'react';
import { api, downloadFile, ago, dur, STATUS } from '../api.js';

const FILTERS = [['', 'Todas'], ['success', 'Éxito'], ['error', 'Error'], ['running', 'En curso'], ['waiting', 'En pausa']];

export default function Runs({ subscribe }) {
  const [runs, setRuns] = useState([]);
  const [filter, setFilter] = useState('');
  const [wf, setWf] = useState('');
  const [workflows, setWorkflows] = useState([]);
  const [exporting, setExporting] = useState(false);
  const [err, setErr] = useState('');
  const load = () => api(`/runs?limit=200${filter ? `&status=${filter}` : ''}${wf ? `&workflowId=${encodeURIComponent(wf)}` : ''}`).then(setRuns).catch(e => setErr(e.message));

  useEffect(() => { load(); }, [filter, wf]);
  useEffect(() => subscribe(m => { if (m.type === 'run') load(); }), [subscribe, filter, wf]);
  useEffect(() => { api('/workflows').then(setWorkflows).catch(() => {}); }, []);

  // Exporta con los mismos filtros del listado, sin su límite de 200 filas
  const exportCsv = async () => {
    setExporting(true); setErr('');
    try {
      const qs = new URLSearchParams();
      if (filter) qs.set('status', filter);
      if (wf) qs.set('workflowId', wf);
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const { truncated } = await downloadFile(`/runs/export.csv${qs.toString() ? `?${qs}` : ''}`, `ejecuciones-${day}.csv`);
      if (truncated) setErr('La exportación se ha limitado a 10 000 ejecuciones (el máximo). Usa filtros para acotarla.');
    } catch (e) { setErr(e.message); }
    finally { setExporting(false); }
  };

  return (
    <main className="page">
      <div className="page-inner">
        <div className="page-head">
          <div><h3>Ejecuciones</h3><span className="sub">Historial de ejecuciones y workers que participaron.</span></div>
          <div className="runs-tools" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="input" value={wf} onChange={e => setWf(e.target.value)} aria-label="Filtrar por workflow">
              <option value="">Todos los workflows</option>
              {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <div className="seg">
              {FILTERS.map(([v, l]) => (
                <label key={v} className="seg-opt"><input type="radio" name="runf" checked={filter === v} onChange={() => setFilter(v)} />{l}</label>
              ))}
            </div>
            <button className="btn btn-ghost" onClick={exportCsv} disabled={!runs.length || exporting} title="Descarga en CSV las ejecuciones con estos filtros">
              {exporting ? 'Exportando…' : 'Exportar CSV'}
            </button>
          </div>
        </div>
        {err && <div className="banner-err">{err}</div>}
        <table className="table">
          <thead><tr><th>ID</th><th>Workflow</th><th>Estado</th><th>Inicio</th><th>Duración</th><th>Modo</th></tr></thead>
          <tbody>
            {runs.map(r => {
              const s = STATUS[r.status] || STATUS.running;
              return (
                <tr key={r.id} className="clickable" onClick={() => { location.hash = `#/runs/${r.id}`; }}>
                  <td className="mono muted">{r.id}</td>
                  <td><b>{r.workflowName}</b>{r.parentRunId && <small className="muted"> · desde {r.parentRunId}</small>}</td>
                  <td><span className="status" style={{ color: s.color }}><span className={`dot ${s.pulse ? 'pulse' : ''}`} style={{ background: s.color }} />{s.label}</span></td>
                  <td className="muted">{ago(r.startedAt)}</td>
                  <td className="mono">{dur(r.startedAt, r.finishedAt)}</td>
                  <td className="muted">{r.mode}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!runs.length && <p className="muted">No hay ejecuciones{filter ? ' con ese estado' : ''}{wf ? ' de ese workflow' : ''}.</p>}
      </div>
    </main>
  );
}
