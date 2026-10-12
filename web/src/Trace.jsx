import { useEffect, useState } from 'react';
import { api, dur, STATUS } from './api.js';
import { TYPES } from './nodeTypes.js';
import { DecisionButtons, approvalText, ReviewParams } from './Approvals.jsx';

// Traza de una ejecución: los pasos en orden, en vertical, con su estado, duración y la salida que
// tomaron (sí/no, fin…). Los sub-workflows se despliegan dentro de su paso con los pasos de su
// ejecución hija. Las aprobaciones pendientes, de cualquier nivel, se deciden aquí mismo. Mientras algo
// sigue en marcha, se refresca sola.

const PORT = { true: 'sí', false: 'no', done: 'fin', item: 'cada' };
const busy = s => ['running', 'waiting'].includes(s);
const live = t => !!t && (busy(t.status) || t.steps.some(s => busy(s.status) || live(s.child)));

// Aprobar / rechazar un paso de cualquier ejecución del árbol (la del padre o la de un hijo)
export const decide = (runId, nodeId, approved, scope) =>
  api(`/runs/${runId}/approvals/${nodeId}`, { method: 'POST', body: { approved, scope, by: localStorage.getItem('orq_user') || 'panel' } });

// Aprobaciones pendientes de todo el árbol: [{ runId, nodeId, nodeName, workflowName, meta, nivel }]
export function pendingIn(t, nivel = 0, out = []) {
  if (!t) return out;
  for (const s of t.steps) {
    if (s.status === 'waiting' && (t.pending || []).includes(s.nodeId)) out.push({ runId: t.id, nodeId: s.nodeId, nodeName: s.nodeName, workflowName: t.workflowName, meta: s.meta, nivel });
    if (s.child) pendingIn(s.child, nivel + 1, out);
  }
  return out;
}

function Steps({ trace, depth, onSelect, workflowId, onDecided }) {
  if (!trace.steps.length) return <p className="muted trace-empty">Sin pasos todavía.</p>;
  const own = trace.workflowId === workflowId;
  return (
    <ol className="trace-list">
      {trace.steps.map(s => {
        const st = STATUS[s.status] || STATUS.running;
        const t = TYPES[s.nodeType];
        return (
          <li key={s.id} className={`trace-step st-${s.status}`}>
            <span className={`trace-dot ${st.pulse ? 'pulse' : ''}`} style={{ background: st.color }} title={st.label} />
            <div className="trace-body">
              <div className="trace-line">
                {own && onSelect
                  ? <button type="button" className="trace-name" onClick={() => onSelect(s.nodeId)} title="Seleccionar en el lienzo"><i className={`ph ${t?.icon || 'ph-circle'}`} />{s.nodeName}</button>
                  : <span className="trace-name"><i className={`ph ${t?.icon || 'ph-circle'}`} />{s.nodeName}</span>}
                {s.port && <span className="trace-port" title="Salida por la que continuó">→ {PORT[s.port] || s.port}</span>}
                {s.status === 'waiting' && <span className="trace-port warn">esperando aprobación</span>}
                <span className="trace-time mono">{dur(s.startedAt, s.finishedAt)}</span>
              </div>
              {s.error && <div className="trace-err">{s.error}</div>}
              {s.status === 'waiting' && (trace.pending || []).includes(s.nodeId) && (
                <div className="approval-card trace-approval">
                  <b>{approvalText(s.meta).title}</b>
                  {depth > 0 && <span>En el sub-workflow «{trace.workflowName}».</span>}
                  <ReviewParams meta={s.meta} />
                  <DecisionButtons meta={s.meta} size="sm" onDecide={(ok, scope) => decide(trace.id, s.nodeId, ok, scope).then(onDecided, e => alert(e.message))} />
                </div>
              )}
              {s.child && (
                <div className="trace-child">
                  <div className="trace-child-head">
                    <i className="ph ph-flow-arrow" />
                    <a href={`#/editor/${s.child.workflowId}`} title="Abrir el workflow">{s.child.workflowName}</a>
                    <a className="mono muted" href={`#/runs/${s.child.id}`} title="Ver la ejecución hija">{s.child.id}</a>
                  </div>
                  <Steps trace={s.child} depth={depth + 1} workflowId={workflowId} onDecided={onDecided} />
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// refresh: cualquier valor que cambie cuando la ejecución avanza (p. ej. su estado y nº de pasos)
export default function Trace({ runId, refresh, onSelect, workflowId, header = true }) {
  const [trace, setTrace] = useState(null);
  const [err, setErr] = useState('');
  const [bump, setBump] = useState(0); // recargar tras decidir una aprobación
  useEffect(() => {
    if (!runId) return;
    let off = false, timer = null;
    const load = () => api(`/runs/${runId}/trace`)
      .then(t => { if (off) return; setTrace(t); setErr(''); if (live(t)) timer = setTimeout(load, 1000); })
      .catch(e => { if (!off) setErr(e.message); });
    load();
    return () => { off = true; clearTimeout(timer); };
  }, [runId, refresh, bump]);

  if (!runId) return <p className="muted">Ejecuta el workflow para ver su traza.</p>;
  if (err) return <small className="help" style={{ color: 'var(--err)' }}>{err}</small>;
  if (!trace) return <p className="muted">Cargando…</p>;
  const st = STATUS[trace.status] || STATUS.running;
  return (
    <div className="trace">
      {header && (
        <div className="trace-head">
          <a className="mono" href={`#/runs/${trace.id}`}>{trace.id}</a>
          <span className="status" style={{ color: st.color }}><span className={`dot ${st.pulse ? 'pulse' : ''}`} style={{ background: st.color }} />{st.label}</span>
          <span className="mono muted">{dur(trace.startedAt, trace.finishedAt)}</span>
          {trace.mode !== 'manual' && <span className="tag tag-neutral">{trace.mode}</span>}
        </div>
      )}
      {trace.error && <div className="trace-err">{trace.error}</div>}
      <Steps trace={trace} depth={0} onSelect={onSelect} workflowId={workflowId ?? trace.workflowId} onDecided={() => setBump(b => b + 1)} />
    </div>
  );
}
