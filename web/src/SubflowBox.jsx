import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TYPES, FIELDS, TRIGGERS, NW, NH, portY, tileClass } from './nodeTypes.js';
import { mergeParams, pruneOverrides } from '@orquesta/shared/overrides';
import { api } from './api.js';
import { Field, ConnSelect, LlmFields, AgentCard, AgentModelOverride, FROM_AGENT, FILE_ONLY } from './NodePanel.jsx';

// Ajustes de un nodo Sub-workflow (params.overrides): cambian parámetros de los nodos del workflow
// invocado solo cuando lo lanza este nodo. El motor los aplica en Engine.start (shared/overrides.js).

const curve = (x1, y1, x2, y2) => {
  const dx = Math.max(50, Math.abs(x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
};
const findWf = (workflows, ref) => workflows.find(w => w.id === ref) || workflows.find(w => w.name === ref) || null;
const same = (a, b) => (a ?? '') === (b ?? '');
// Parámetros cambiados en un nodo (los de sus propios hijos cuentan aparte)
const changedKeys = ov => Object.keys(ov || {}).filter(k => k !== 'overrides');
// Nodos con algún ajuste, contando los de sub-workflows anidados
export const countOverrides = ov => Object.values(ov || {}).reduce((s, o) => s + (changedKeys(o).length ? 1 : 0) + countOverrides(o?.overrides), 0);
const setAtPath = (ov, path, fn) => {
  if (!path.length) return fn(ov || {});
  const [h, ...rest] = path, cur = ov?.[h] || {};
  return { ...ov, [h]: { ...cur, overrides: setAtPath(cur.overrides, rest, fn) } };
};
const bbox = nodes => {
  if (!nodes.length) return { x: 0, y: 0, w: NW, h: NH };
  const x = Math.min(...nodes.map(n => n.x)) - 30, y = Math.min(...nodes.map(n => n.y)) - 30;
  return { x, y, w: Math.max(...nodes.map(n => n.x)) + NW + 60 - x, h: Math.max(...nodes.map(n => n.y)) + NH + 50 - y };
};

// Workflow invocado, pedido de nuevo al servidor para ver su última versión guardada
function useWorkflow(ref, workflows) {
  const [st, setSt] = useState({ ref: null, wf: null, err: '' });
  const known = findWf(workflows, ref);
  useEffect(() => {
    if (!known) { setSt({ ref, wf: null, err: '' }); return; }
    let off = false;
    api(`/workflows/${known.id}`).then(wf => !off && setSt({ ref, wf, err: '' }), e => !off && setSt({ ref, wf: known, err: e.message }));
    return () => { off = true; };
  }, [known?.id, ref]);
  return { wf: st.ref === ref ? st.wf : known, missing: !known, err: st.err };
}

// Minimapa (sin textos) para el panel lateral
function MiniMap({ graph, ours, onSelect }) {
  const b = bbox(graph.nodes), byId = Object.fromEntries(graph.nodes.map(n => [n.id, n]));
  return (
    <svg className="sf-minimap" viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`} preserveAspectRatio="xMidYMid meet">
      {graph.edges.map(e => {
        const a = byId[e.from], c = byId[e.to];
        return a && c ? <path key={e.id} d={curve(a.x + NW, a.y + portY(a.type, e.port), c.x, c.y + NH / 2)} className="sf-mini-edge" /> : null;
      })}
      {graph.nodes.map(n => (
        <rect key={n.id} x={n.x} y={n.y} width={NW} height={NH} rx="10" onClick={() => onSelect(n.id)}
          className={`sf-mini-node ${tileClass(n.type)} ${changedKeys(ours[n.id]).length || ours[n.id]?.overrides ? 'changed' : ''}`}>
          <title>{n.name}</title>
        </rect>
      ))}
    </svg>
  );
}

// Resumen en el panel del nodo Sub-workflow
export function SubflowSummary({ node, onNode, workflows, onLeave }) {
  const [open, setOpen] = useState(null); // id del nodo a abrir en el diálogo ('' = ninguno)
  const ref = node.params.workflow;
  const { wf, missing } = useWorkflow(ref, workflows);
  const ours = node.params.overrides || {};
  if (!ref) return null;
  if (missing) return <small className="help" style={{ color: 'var(--err)' }}>No existe ningún workflow «{ref}».</small>;
  if (!wf) return null;
  const g = { nodes: [], edges: [], ...(wf.graph || {}) };
  const ids = new Set(g.nodes.map(n => n.id));
  const changed = g.nodes.filter(n => changedKeys(ours[n.id]).length || ours[n.id]?.overrides);
  const orphans = Object.keys(ours).filter(id => !ids.has(id));
  const set = ov => onNode({ params: { ...node.params, overrides: pruneOverrides(ov) } });
  const nAgents = g.nodes.filter(n => n.type === 'agent').length;
  return (
    <div className="sf-box">
      <div className="sf-box-head">
        <span className="eyebrow">Contenido del sub-workflow</span>
        <button type="button" className="link-btn" onClick={() => onLeave(`#/editor/${wf.id}`)} title="Abrir el workflow hijo en el editor (los cambios allí afectan a todos los que lo usan)">Abrir <i className="ph ph-arrow-square-out" /></button>
      </div>
      <MiniMap graph={g} ours={ours} onSelect={id => setOpen(id)} />
      <span className="help">{g.nodes.length} nodos{nAgents ? ` · ${nAgents} agente${nAgents === 1 ? '' : 's'}` : ''} · {changed.length ? `${countOverrides(ours)} con ajustes` : 'sin ajustes'}</span>
      {changed.length > 0 && (
        <ul className="sf-changed">
          {changed.map(n => (
            <li key={n.id}><button type="button" className="link-btn" onClick={() => setOpen(n.id)}><i className={`ph ${TYPES[n.type]?.icon}`} />{n.name}</button>
              <span className="muted mono">{[...changedKeys(ours[n.id]), ...(ours[n.id]?.overrides ? [`${countOverrides(ours[n.id].overrides)} dentro`] : [])].join(', ')}</span></li>
          ))}
        </ul>
      )}
      {orphans.length > 0 && (
        <small className="help" style={{ color: 'var(--warn)' }}>
          {orphans.length} ajuste{orphans.length === 1 ? '' : 's'} de nodos que ya no existen en «{wf.name}».{' '}
          <button type="button" className="link-btn" onClick={() => set(Object.fromEntries(Object.entries(ours).filter(([id]) => ids.has(id))))}>Quitar</button>
        </small>
      )}
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen('')}><i className="ph ph-sliders-horizontal" />Ver y ajustar nodos…</button>
      <small className="help">Los ajustes solo valen cuando lo invoca este nodo: «{wf.name}» no se modifica.</small>
      {open !== null && <SubflowDialog root={wf} overrides={ours} onChange={set} workflows={workflows} initialSel={open} onClose={() => setOpen(null)} onLeave={onLeave} />}
    </div>
  );
}

// Grafo del workflow hijo, solo lectura, escalado para caber en su caja
function GraphView({ graph, ours, sel, onSelect, agents }) {
  const box = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const b = bbox(graph.nodes), byId = Object.fromEntries(graph.nodes.map(n => [n.id, n]));
  const z = size.w ? Math.min(1, size.w / b.w, size.h / b.h) : 0;
  const ox = (size.w - b.w * z) / 2 - b.x * z, oy = (size.h - b.h * z) / 2 - b.y * z;
  return (
    <div className="sf-graph" ref={box} onMouseDown={() => onSelect(null)}>
      {z > 0 && (
        <div className="layer" style={{ transform: `translate(${ox}px, ${oy}px) scale(${z})` }}>
          <svg className="edges">
            {graph.edges.map(e => {
              const a = byId[e.from], c = byId[e.to];
              return a && c ? <path key={e.id} d={curve(a.x + NW, a.y + portY(a.type, e.port), c.x - 4, c.y + NH / 2)} className={`edge ${sel === e.from || sel === e.to ? 'sel' : ''}`} /> : null;
            })}
          </svg>
          {graph.nodes.map(n => {
            const t = TYPES[n.type] || TYPES.node, ov = ours[n.id], k = changedKeys(ov).length + (ov?.overrides ? 1 : 0);
            return (
              <div key={n.id} className={`node sf-node ${sel === n.id ? 'is-sel' : ''} ${k ? 'changed' : ''}`} style={{ left: n.x, top: n.y }}
                onMouseDown={e => { e.stopPropagation(); onSelect(n.id); }}>
                <div className={`tile ${tileClass(n.type)}`}><i className={`ph ${t.icon}`} /></div>
                <div className="node-txt">
                  <span className="node-kind">{t.kind}{n.type === 'agent' && n.params?.agentId && <span className="node-agent"> · {agents?.find(a => a.id === n.params.agentId)?.name || '…'}</span>}</span>
                  <span className="node-name">{n.name}</span>
                </div>
                {k > 0 && <span className="sf-badge" title="Tiene ajustes en este nodo Sub-workflow"><i className="ph-fill ph-sliders-horizontal" /></span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Formulario de un nodo del hijo: muestra lo efectivo y guarda solo lo que difiere del workflow hijo
function NodeForm({ node, base, ov, onSet, onReset, onDrill, agents, llm, workflows }) {
  const p = mergeParams(base, ov || {});
  const shown = { ...node, params: p };
  const changed = new Set(changedKeys(ov));
  const setParam = (k, v) => onSet({ [k]: v });
  const cur = p.agentId ? agents?.find(a => a.id === p.agentId) : null;
  const fields = (FIELDS[node.type] || [])
    .filter(f => node.type !== 'file' || !FILE_ONLY[f[0]] || FILE_ONLY[f[0]] === (p.action || 'Leer'))
    .filter(f => node.type !== 'agent' || !p.agentId || !FROM_AGENT.includes(f[0]))
    .filter(f => node.type !== 'agent' || f[0] !== 'schema' || p.output === 'JSON');
  const mark = (key, el) => (
    <div className={`sf-field ${changed.has(key) ? 'changed' : ''}`} key={key}>
      {el}
      {changed.has(key) && <button type="button" className="link-btn sf-reset" onClick={() => onSet({ [key]: base[key] ?? '' })}><i className="ph ph-arrow-counter-clockwise" />Restablecer (en el hijo: {String(base[key] ?? '') === '' ? 'vacío' : <span className="mono">{String(base[key]).slice(0, 40)}</span>})</button>}
    </div>
  );
  const t = TYPES[node.type] || TYPES.node;
  return (
    <>
      <div className="panel-title">
        <div className={`tile ${tileClass(node.type)}`}><i className={`ph ${t.icon}`} /></div>
        <div style={{ flex: 1, minWidth: 0 }}><span className="node-kind">{t.kind}</span><b className="sf-node-name">{node.name}</b></div>
        {(changed.size > 0 || ov?.overrides) && <button type="button" className="btn btn-secondary btn-xs-text" onClick={onReset} title="Quitar todos los ajustes de este nodo"><i className="ph ph-arrow-counter-clockwise" />Restablecer</button>}
      </div>
      {TRIGGERS.includes(node.type) ? (
        <p className="muted sf-note">Disparador: al invocarse como sub-workflow recibe directamente la entrada del nodo Sub-workflow.</p>
      ) : (
        <>
          {node.type === 'agent' && mark('agentId', (
            <div className="field">
              <label>Agente</label>
              <select className="input" value={p.agentId || ''} onChange={e => onSet({ agentId: e.target.value, overrideProvider: '', overrideModel: '' })}>
                <option value="">Personalizado (se configura en el nodo)</option>
                {(agents || []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          ))}
          {node.type === 'agent' && cur && <AgentCard agent={cur} llm={llm} />}
          {node.type === 'agent' && cur && (
            <div className={`sf-field ${changed.has('overrideProvider') || changed.has('overrideModel') ? 'changed' : ''}`}>
              <AgentModelOverride node={shown} agent={cur} llm={llm} set={onSet} />
            </div>
          )}
          {node.type === 'agent' && !p.agentId && (
            <div className={`sf-field ${changed.has('provider') || changed.has('model') ? 'changed' : ''}`}>
              <LlmFields node={shown} setParam={setParam} />
            </div>
          )}
          {node.type === 'agent' && p.agentId && mark('extraPrompt', (
            <div className="field">
              <label>Instrucciones adicionales</label>
              <textarea className="input" rows={3} spellCheck={false} value={p.extraPrompt || ''} onChange={e => setParam('extraPrompt', e.target.value)} />
            </div>
          ))}
          {fields.map(f => mark(f[0], f[2] === 'CONN'
            ? <ConnSelect value={p[f[0]]} onChange={setParam} />
            : <Field f={f} value={p[f[0]]} onChange={setParam} workflows={workflows} />))}
          {node.type === 'subflow' && p.workflow && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onDrill}><i className="ph ph-flow-arrow" />Ajustar los nodos de «{p.workflow}»<i className="ph ph-caret-right" /></button>
          )}
          <small className="help">Admite {'{{ expresiones }}'}: se evalúan dentro del sub-workflow ($json es lo que recibe este nodo). Worker, reintentos y timeout se cambian en el propio workflow hijo.</small>
        </>
      )}
    </>
  );
}

// Diálogo: grafo del hijo + formulario del nodo elegido. Se puede bajar a sub-workflows anidados.
function SubflowDialog({ root, overrides, onChange, workflows, initialSel, onClose, onLeave }) {
  const [stack, setStack] = useState([{ ref: root.id, via: null, name: root.name }]);
  const [sel, setSel] = useState(initialSel || null);
  const [cache, setCache] = useState({ [root.id]: root });
  const [agents, setAgents] = useState(null);
  const [llm, setLlm] = useState(null);
  useEffect(() => { api('/agents').then(setAgents).catch(() => setAgents([])); api('/llm').then(setLlm).catch(() => {}); }, []);
  useEffect(() => { api(`/workflows/${root.id}`).then(w => setCache(c => ({ ...c, [root.id]: w }))).catch(() => {}); }, [root.id]);
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  // Por nivel: grafo, ajustes que ya trae de su propio invocador (baseOv) y los de este nodo (ours)
  const levels = [];
  for (let i = 0, baseOv = {}, ours = overrides || {}; i < stack.length; i++) {
    const wf = cache[stack[i].ref];
    levels.push({ wf, baseOv, ours });
    const via = stack[i + 1]?.via;
    if (via) {
      const n = wf?.graph?.nodes?.find(x => x.id === via);
      baseOv = mergeParams(n?.params || {}, baseOv[via] || {}).overrides || {};
      ours = ours[via]?.overrides || {};
    }
  }
  const lv = levels[levels.length - 1];
  const g = { nodes: [], edges: [], ...(lv.wf?.graph || {}) };
  const node = g.nodes.find(n => n.id === sel);
  const base = node ? mergeParams(node.params || {}, lv.baseOv[node.id] || {}) : null;
  const path = stack.slice(1).map(s => s.via);
  const update = fn => onChange(setAtPath(overrides, path, fn));

  const onSet = patch => update(l => {
    const cur = { ...(l[node.id] || {}) };
    for (const [k, v] of Object.entries(patch)) { if (same(v, base[k])) delete cur[k]; else cur[k] = v; }
    return { ...l, [node.id]: cur };
  });
  const onReset = () => update(l => { const { [node.id]: _, ...rest } = l; return rest; });
  const drill = () => {
    const ref = mergeParams(base, lv.ours[node.id] || {}).workflow;
    const w = findWf(workflows, ref);
    if (!w) return;
    setStack(s => [...s, { ref: w.id, via: node.id, name: w.name }]);
    setSel(null);
    if (!cache[w.id]) api(`/workflows/${w.id}`).then(x => setCache(c => ({ ...c, [w.id]: x }))).catch(() => setCache(c => ({ ...c, [w.id]: w })));
  };
  const total = countOverrides(lv.ours);

  return createPortal(
    <div className="dialog-backdrop sf-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog sf-dialog" role="dialog" aria-label={`Sub-workflow ${root.name}`}>
        <div className="sf-dialog-head">
          <i className="ph ph-flow-arrow" />
          <nav className="sf-crumbs">
            {stack.map((s, i) => (
              <Fragment key={i}>
                {i > 0 && <i className="ph ph-caret-right muted" />}
                {i < stack.length - 1
                  ? <button type="button" className="link-btn" onClick={() => { setStack(st => st.slice(0, i + 1)); setSel(stack[i + 1].via); }}>{s.name}</button>
                  : <b>{s.name}</b>}
              </Fragment>
            ))}
          </nav>
          <span className="muted sf-count">{total ? `${total} nodo${total === 1 ? '' : 's'} con ajustes` : 'Sin ajustes'}</span>
          {total > 0 && <button type="button" className="btn btn-secondary btn-xs-text" onClick={() => update(() => ({}))}>Quitar todos</button>}
          <button type="button" className="btn btn-secondary btn-xs-text" onClick={() => { onClose(); onLeave(`#/editor/${stack[stack.length - 1].ref}`); }} title="Editar el workflow hijo (afecta a todos los que lo usan)"><i className="ph ph-arrow-square-out" />Abrir en el editor</button>
          <button type="button" className="btn btn-icon btn-xs" onClick={onClose} title="Cerrar (Esc)"><i className="ph ph-x" /></button>
        </div>
        <div className="sf-dialog-body">
          {lv.wf ? <GraphView graph={g} ours={lv.ours} sel={sel} onSelect={setSel} agents={agents} /> : <div className="sf-graph"><p className="muted sf-note">Cargando…</p></div>}
          <div className="sf-form panel-scroll">
            {node ? (
              <NodeForm key={`${path.join('/')}|${node.id}`} node={node} base={base} ov={lv.ours[node.id]} onSet={onSet} onReset={onReset} onDrill={drill} agents={agents} llm={llm} workflows={workflows} />
            ) : (
              <div className="sf-empty">
                <i className="ph ph-cursor-click" />
                <b>Elige un nodo del sub-workflow</b>
                <span>Lo que cambies aquí solo se aplica cuando este nodo Sub-workflow lo invoca: el workflow «{lv.wf?.name || stack[stack.length - 1].name}» queda como está. Los nodos con ajustes llevan <i className="ph-fill ph-sliders-horizontal" />.</span>
                <span>Se guarda con el workflow actual (Ctrl + S).</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
