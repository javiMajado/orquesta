import { useEffect, useState } from 'react';
import { api, ago, dur, STATUS } from '../api.js';

const FILTERS = [['', 'Todas'], ['success', 'Éxito'], ['error', 'Error'], ['running', 'En curso'], ['waiting', 'En pausa']];

export default function Runs({ subscribe }) {
  const [runs, setRuns] = useState([]);
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState('');
  const load = () => api(`/runs?limit=200${filter ? `&status=${filter}` : ''}`).then(setRuns).catch(e => setErr(e.message));

  useEffect(() => { load(); }, [filter]);
  useEffect(() => subscribe(m => { if (m.type === 'run') load(); }), [subscribe, filter]);

  return (
    <main className="page">
      <div className="page-inner">
        <div className="page-head">
          <div><h3>Ejecuciones</h3><span className="sub">Historial de ejecuciones y workers que participaron.</span></div>
          <div className="seg">
            {FILTERS.map(([v, l]) => (
              <label key={v} className="seg-opt"><input type="radio" name="runf" checked={filter === v} onChange={() => setFilter(v)} />{l}</label>
            ))}
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
        {!runs.length && <p className="muted">No hay ejecuciones{filter ? ' con ese estado' : ''}.</p>}
      </div>
    </main>
  );
}
