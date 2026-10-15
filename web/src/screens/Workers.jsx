import { useEffect, useState } from 'react';
import { api, ago } from '../api.js';
import { keyText } from '../NodePanel.jsx';

const STRATS = [['carga', 'Menor carga'], ['rr', 'Round-robin'], ['afinidad', 'Afinidad']];
const ICON = { llm: 'ph-robot', node: 'ph-file-js', db: 'ph-database' };

export default function Workers({ workers }) {
  const [strategy, setStrategy] = useState('carga');
  const [err, setErr] = useState('');
  const [cache, setCache] = useState({});
  useEffect(() => { api('/settings').then(s => { setStrategy(s.strategy); setCache(s.llmCache || {}); }).catch(e => setErr(e.message)); }, []);
  const pickCache = async (id, mode) => {
    setCache(c => ({ ...c, [id]: mode }));
    await api('/settings', { method: 'PUT', body: { llmCache: { [id]: mode } } }).then(s => setCache(s.llmCache || {})).catch(e => setErr(e.message));
  };

  const pick = async v => { setStrategy(v); await api('/settings', { method: 'PUT', body: { strategy: v } }).catch(e => setErr(e.message)); };
  const toggle = w => api(`/workers/${encodeURIComponent(w.id)}`, { method: 'PATCH', body: { enabled: !w.enabled } }).catch(e => setErr(e.message));
  const busy = workers.reduce((a, w) => a + w.load, 0);
  const [llm, setLlm] = useState(null);
  useEffect(() => { api('/llm').then(setLlm).catch(e => setErr(e.message)); }, [workers]);
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/worker`;

  return (
    <main className="page">
      <div className="page-inner">
        <div className="page-head">
          <div><h3>Agentes y workers</h3><span className="sub">{workers.length} conectados · {busy} tareas en curso</span></div>
        </div>
        {err && <div className="banner-err">{err}</div>}

        <div className="card elev-sm orq-card">
          <div className="orq-icon"><i className="ph ph-graph" /></div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="card-title" style={{ fontSize: 15 }}>Orquestador</div>
            <span className="sub" style={{ fontSize: 12.5 }}>Asigna cada nodo al worker conectado que tenga la capacidad requerida. Si todos están ocupados, la tarea espera en cola. Los nodos de control corren en el propio orquestador.</span>
          </div>
          <div className="seg">
            {STRATS.map(([v, l]) => <label key={v} className="seg-opt"><input type="radio" name="strat" checked={strategy === v} onChange={() => pick(v)} />{l}</label>)}
          </div>
        </div>

        <div>
          <div className="section-rule"><span className="eyebrow">Proveedores LLM</span><span className="rule" /></div>
          <span className="sub" style={{ fontSize: 12.5 }}>
            Por defecto, los agentes usan <b className="mono">{llm?.default?.provider ? `${llm.default.provider} · ${llm.default.model || 'modelo del proveedor'}` : 'el proveedor simulado (sin coste)'}</b>
            {' '}(<span className="mono">ORQ_LLM_DEFAULT</span>). Las claves nunca salen del worker: aquí solo se ve de dónde vienen y su huella. «Caché de prompts» automática: activada, y se desactiva sola si el proveedor la rechaza.
          </span>
        </div>
        <table className="table">
          <thead><tr><th>Proveedor</th><th>Tipo</th><th>Clave</th><th>Estado</th><th title="Reutiliza el principio de la conversación (herramientas, instrucciones, mapa del repositorio) en vez de pagarlo entero en cada turno">Caché de prompts</th><th>Workers</th></tr></thead>
          <tbody>
            {(llm?.providers || []).map(p => {
              const color = !p.enabled ? 'var(--err)' : p.source === 'shell' ? 'var(--warn)' : 'var(--ok)';
              return (
                <tr key={p.id}>
                  <td><div className="cell-2"><span>{p.label}</span><small className="mono">{p.id}{p.host ? ` · ${p.host}` : ''}</small></div></td>
                  <td className="mono">{p.kind}</td>
                  <td className="mono" style={{ color: p.source === 'shell' ? 'var(--warn)' : undefined }}>{keyText(p)}</td>
                  <td><span className="status" style={{ color }}><span className="dot" style={{ background: color }} />{p.enabled ? (p.source === 'shell' ? 'Activo · clave del shell' : 'Activo') : 'Desactivado'}</span>{!p.enabled && <small className="help" style={{ display: 'block' }}>{p.reason}</small>}</td>
                  <td>
                    <select className="input input-sm" value={cache[p.id] || 'auto'} onChange={e => pickCache(p.id, e.target.value)} aria-label={`Caché de prompts de ${p.label}`}>
                      <option value="auto">Automática</option>
                      <option value="on">Siempre</option>
                      <option value="off">Desactivada</option>
                    </select>
                  </td>
                  <td className="mono">{p.workers.join(', ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <table className="table">
          <thead><tr><th>Worker</th><th>Capacidades</th><th>Estado</th><th>Carga</th><th>Tareas</th><th /></tr></thead>
          <tbody>
            {workers.map(w => {
              const color = !w.enabled ? 'var(--color-neutral-500)' : w.load ? 'var(--color-accent)' : 'var(--ok)';
              return (
                <tr key={w.id}>
                  <td><div className="cell-icon"><div className="tile sm"><i className={`ph ${ICON[w.caps[0]] || 'ph-cpu'}`} /></div><div className="cell-2"><span className="mono">{w.id}</span><small>{w.runtime} · desde {ago(w.connectedAt)}</small></div></div></td>
                  <td><div className="tags">{w.caps.map(c => <span key={c} className="tag tag-neutral mono">{c}</span>)}</div></td>
                  <td><span className="status" style={{ color }}><span className={`dot ${w.enabled && w.load ? 'pulse' : ''}`} style={{ background: color }} />{!w.enabled ? 'Desactivado' : w.load ? 'Ocupado' : 'Disponible'}</span></td>
                  <td><div className="load"><div className="bar"><div style={{ width: `${Math.round((w.load / w.max) * 100)}%` }} /></div><span className="mono muted">{w.load}/{w.max}</span></div></td>
                  <td className="mono">{w.tasks}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn btn-secondary btn-sm" onClick={() => toggle(w)}>{w.enabled ? 'Desactivar' : 'Activar'}</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!workers.length && <p className="muted">No hay workers conectados. El servidor arranca uno embebido salvo que EMBEDDED_WORKER=false.</p>}

        <div className="card elev-sm" style={{ padding: 16, gap: 10 }}>
          <div className="card-title" style={{ fontSize: 15 }}>Conectar un worker</div>
          <span className="sub" style={{ fontSize: 12.5 }}>Dentro del repositorio, con el mismo <span className="mono">WORKER_TOKEN</span> que el servidor y los proveedores LLM en el <span className="mono">.env</span> del worker (<span className="mono">ORQ_LLM_PROVIDERS</span>). El servidor solo escucha en este equipo salvo que cambies <span className="mono">HOST</span>.</span>
          <pre className="out">{`ORQ_URL=${wsUrl} \\
WORKER_ID=agente-01 \\
WORKER_CAPS=llm \\
WORKER_TOKEN=... \\
npm run worker`}</pre>
          <span className="sub" style={{ fontSize: 12.5 }}>Capacidades: <span className="mono">llm</span> (agentes IA), <span className="mono">node</span> (scripts, HTTP, email), <span className="mono">db</span> (bases de datos).</span>
        </div>
      </div>
    </main>
  );
}
