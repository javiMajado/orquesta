import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, dur, STATUS } from './api.js';
import { TYPES, GROUPS, TRIGGERS, NW, NH, outPorts, portY, tileClass, newNode } from './nodeTypes.js';
import NodePanel, { DecisionButtons } from './NodePanel.jsx';
import { decide as decideIn, pendingIn } from './Trace.jsx';
import RunPanel from './RunPanel.jsx';
import { useDatasets, readActive, writeActive } from './runData.js';
import { triggerOf, fieldsOf, analyzeInputs, effectiveValues, buildTriggerInput, validateInput } from '@orquesta/shared/inputs';

const curve = (x1, y1, x2, y2) => {
  const dx = Math.max(50, Math.abs(x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
};
const STATUS_ICON = {
  running: ['ph ph-circle-notch spin', 'var(--color-accent)'],
  waiting: ['ph-fill ph-pause-circle pulse', 'var(--warn)'],
  success: ['ph-fill ph-check-circle', 'var(--ok)'],
  error: ['ph-fill ph-x-circle', 'var(--err)'],
  cancelled: ['ph-fill ph-stop-circle', 'var(--color-neutral-500)'],
};
const LOG_ICON = { info: ['ph ph-arrow-right', 'var(--color-neutral-500)'], ok: ['ph-fill ph-check-circle', 'var(--ok)'], warn: ['ph-fill ph-pause-circle', 'var(--warn)'], err: ['ph-fill ph-x-circle', 'var(--err)'] };

function fromDetail(d) {
  const steps = {};
  for (const s of d.steps) steps[s.nodeId] = { status: s.status, worker: s.worker, output: s.output, error: s.error, meta: s.meta, port: s.port, childRunId: s.childRunId };
  return { id: d.id, status: d.status, run: d, steps, logs: d.logs };
}

export default function Editor({ id, workers, subscribe }) {
  const [wf, setWf] = useState(null);
  const [graph, setGraph] = useState({ nodes: [], edges: [], settings: {} });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(null);
  const [selEdge, setSelEdge] = useState(null);
  const [view, setView] = useState({ x: 40, y: 60, z: 1 });
  const [link, setLink] = useState(null);
  // Panel derecho sin nodo seleccionado: datos del workflow o traza de la ejecución
  const [sideTab, setSideTab] = useState('wf');
  // Aprobaciones pendientes de toda la ejecución, también las de sus sub-workflows (salen de la traza)
  const [treePending, setTreePending] = useState(null);
  const [pendingTick, setPendingTick] = useState(0);
  // Agentes personalizados, para mostrar en el lienzo el nombre del agente de cada nodo
  const [agents, setAgents] = useState({});
  const [q, setQ] = useState('');
  const [logsOpen, setLogsOpen] = useState(true);
  const [palOpen, setPalOpen] = useState(window.innerWidth >= 1200);
  const [run, setRunState] = useState(null);
  const [allWfs, setAllWfs] = useState([]);
  const [, tick] = useState(0);
  // Panel de ejecución: conjunto y caso activos, borrador de valores y aviso previo a ejecutar
  const { data: dsData, reload: reloadDs } = useDatasets(id, subscribe);
  const [activeDsId, setActiveDsIdState] = useState(() => readActive(id));
  const [selCaseId, setSelCaseId] = useState(null);
  const [draft, setDraft] = useState(null); // { caseId, values }
  const [runWarn, setRunWarn] = useState(null);
  const [agentCfg, setAgentCfg] = useState({});
  const setActiveDsId = v => { setActiveDsIdState(v); writeActive(id, v); };

  const cv = useRef(null), drag = useRef(null), viewRef = useRef(view), runRef = useRef(null), logEl = useRef(null), graphRef = useRef(graph);
  viewRef.current = view;
  graphRef.current = graph;
  const setRun = v => { runRef.current = typeof v === 'function' ? v(runRef.current) : v; setRunState(runRef.current); };

  const edit = useCallback(fn => { setGraph(fn); setDirty(true); }, []);

  const toCanvas = e => {
    const r = cv.current.getBoundingClientRect(), v = viewRef.current;
    return { x: (e.clientX - r.left - v.x) / v.z, y: (e.clientY - r.top - v.y) / v.z };
  };

  const fit = useCallback((nodes = graphRef.current.nodes) => {
    const el = cv.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!nodes.length) return setView({ x: 80, y: 80, z: 1 });
    const minX = Math.min(...nodes.map(n => n.x)), minY = Math.min(...nodes.map(n => n.y));
    const bw = Math.max(...nodes.map(n => n.x)) + NW + 40 - minX, bh = Math.max(...nodes.map(n => n.y)) + NH + 30 - minY;
    const z = Math.max(0.2, Math.min(1.1, (r.width - 100) / bw, (r.height - 110) / bh));
    setView({ z, x: (r.width - bw * z) / 2 - minX * z + 10, y: (r.height - bh * z) / 2 - minY * z + 10 });
  }, []);

  const zoomBy = f => {
    const r = cv.current.getBoundingClientRect(), cx = r.width / 2, cy = r.height / 2;
    setView(v => { const z = Math.max(0.2, Math.min(1.8, v.z * f)); return { z, x: cx - (cx - v.x) * z / v.z, y: cy - (cy - v.y) * z / v.z }; });
  };

  // Carga del workflow + última ejecución
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const w = await api(`/workflows/${id}`);
        if (off) return;
        const g = { nodes: [], edges: [], settings: {}, ...w.graph };
        setWf(w); setGraph(g); setDirty(false);
        requestAnimationFrame(() => fit(g.nodes));
        api('/workflows').then(l => !off && setAllWfs(l)).catch(() => {});
        const [last] = await api(`/runs?workflowId=${id}&limit=1`);
        if (last && !off && !runRef.current) { const d = await api(`/runs/${last.id}`); if (!off && !runRef.current) setRun(fromDetail(d)); }
      } catch (e) { setErr(e.message); }
    })();
    return () => { off = true; };
  }, [id, fit]);

  // Eventos en vivo
  useEffect(() => subscribe(m => {
    const r = runRef.current;
    if (m.type === 'run' && m.run.workflowId === id) {
      if (r && r.id === m.run.id) setRun(p => ({ ...p, status: m.run.status, run: m.run }));
      else if (m.run.status === 'running' && (!r || !['running', 'waiting'].includes(r.status))) setRun({ id: m.run.id, status: 'running', run: m.run, steps: {}, logs: [] });
    } else if (m.type === 'step') {
      // Una ejecución hija (sub-workflow) que se para o sigue: recalcular las aprobaciones pendientes
      if (r && m.runId !== r.id && m.status) setPendingTick(t => t + 1);
      setRun(p => (p && p.id === m.runId ? { ...p, steps: { ...p.steps, [m.nodeId]: { ...p.steps[m.nodeId], ...Object.fromEntries(Object.entries(m).filter(([k, v]) => ['status', 'worker', 'output', 'error', 'meta', 'port', 'childRunId'].includes(k) && v !== undefined)) } } } : p));
    } else if (m.type === 'log') {
      setRun(p => (p && p.id === m.runId ? { ...p, logs: [...p.logs, m.log] } : p));
    }
  }), [id, subscribe]);

  const active = run && ['running', 'waiting'].includes(run.status);
  useEffect(() => { if (!active) return; const t = setInterval(() => tick(x => x + 1), 250); return () => clearInterval(t); }, [active]);
  useEffect(() => { if (logEl.current) logEl.current.scrollTop = logEl.current.scrollHeight; }, [run?.logs?.length, logsOpen]);

  // Arrastre: nodos, lienzo y conexiones
  useEffect(() => {
    const move = e => {
      const g = drag.current;
      if (!g) return;
      const v = viewRef.current;
      if (g.t === 'node') {
        const x = Math.round((g.nx + (e.clientX - g.cx) / v.z) / 10) * 10, y = Math.round((g.ny + (e.clientY - g.cy) / v.z) / 10) * 10;
        if (x !== g.lx || y !== g.ly) { g.lx = x; g.ly = y; g.moved = true; setGraph(gr => ({ ...gr, nodes: gr.nodes.map(n => (n.id === g.id ? { ...n, x, y } : n)) })); }
      } else if (g.t === 'pan') {
        setView(v0 => ({ ...v0, x: g.px + e.clientX - g.cx, y: g.py + e.clientY - g.cy }));
      } else if (g.t === 'link' && cv.current) {
        const p = toCanvas(e);
        setLink(l => l && { ...l, ...p });
      }
    };
    const up = () => {
      const g = drag.current;
      if (g?.t === 'node' && g.moved) setDirty(true);
      if (g?.t === 'link') setLink(null);
      drag.current = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  useEffect(() => {
    const el = cv.current;
    if (!el) return;
    const wheel = e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
        setView(v => { const z = Math.max(0.2, Math.min(1.8, v.z * Math.exp(-e.deltaY * 0.01))); return { z, x: mx - (mx - v.x) * z / v.z, y: my - (my - v.y) * z / v.z }; });
      } else setView(v => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [wf]);

  // patch: campos que cambian en este guardado (p. ej. { active } desde el interruptor)
  const save = async (patch = {}) => {
    setSaving(true);
    try {
      const w = await api(`/workflows/${id}`, { method: 'PUT', body: { name: wf.name, description: wf.description, collection: wf.collection || '', active: wf.active, graph: graphRef.current, ...patch } });
      setWf(w); setDirty(false); setErr('');
      return true;
    } catch (e) { setErr(e.message); return false; } finally { setSaving(false); }
  };

  // Activar / desactivar se aplica al momento (cron y webhooks empiezan o dejan de responder). Si hay
  // cambios sin guardar, se guardan a la vez: lo que se programa es lo que se ve en el lienzo.
  const toggleActive = async () => {
    const active = !wf.active;
    if (dirty) return save({ active });
    setSaving(true);
    try { const w = await api(`/workflows/${id}`, { method: 'PUT', body: { active } }); setWf(x => ({ ...x, active: w.active, updatedAt: w.updatedAt })); setErr(''); }
    catch (e) { setErr(e.message); } finally { setSaving(false); }
  };

  const deleteSel = () => {
    if (sel) edit(g => ({ ...g, nodes: g.nodes.filter(n => n.id !== sel), edges: g.edges.filter(e => e.from !== sel && e.to !== sel) }));
    else if (selEdge) edit(g => ({ ...g, edges: g.edges.filter(e => e.id !== selEdge) }));
    setSel(null); setSelEdge(null);
  };

  useEffect(() => {
    const key = e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && runOpen) { e.preventDefault(); if (!active) runNow(); return; }
      if (e.key === 'Escape' && runOpen && !e.defaultPrevented) { setSideTab('wf'); return; }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSel(); }
      if (e.key === 'Escape') { setSel(null); setSelEdge(null); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const addNode = (type, x, y, from) => {
    const n = newNode(type, x, y);
    edit(g => ({
      ...g, nodes: [...g.nodes, n],
      edges: from && !TRIGGERS.includes(type) ? [...g.edges, { id: 'e' + n.id, from: from.id, to: n.id, port: outPorts(from.type)[0].port }] : g.edges,
    }));
    setSel(n.id); setSelEdge(null);
  };
  const paletteClick = type => {
    const from = sel && graph.nodes.find(n => n.id === sel);
    if (from) return addNode(type, from.x + 260, from.y + (graph.edges.some(e => e.from === from.id) ? 110 : 0), from);
    const r = cv.current.getBoundingClientRect();
    addNode(type, (r.width / 2 - view.x) / view.z - NW / 2, (r.height / 2 - view.y) / view.z - NH / 2);
  };
  const connect = to => {
    const l = drag.current;
    if (!l || l.t !== 'link' || l.from === to) return;
    const t = graph.nodes.find(n => n.id === to);
    if (!t || TRIGGERS.includes(t.type) || graph.edges.some(e => e.from === l.from && e.to === to && e.port === l.port)) return;
    edit(g => ({ ...g, edges: [...g.edges, { id: 'e' + Date.now().toString(36), from: l.from, to, port: l.port }] }));
  };

  // ── Datos de prueba: disparador, campos, conjunto/caso activos y valores que se usarán ──
  const trigger = useMemo(() => triggerOf(graph), [graph]);
  const fields = fieldsOf(trigger);
  const datasets = dsData?.datasets || [];
  const activeDs = datasets.find(d => d.id === activeDsId) || datasets[0] || null;
  const selCase = activeDs?.cases.find(c => c.id === selCaseId) || activeDs?.cases[0] || null;
  const savedValues = useMemo(() => (selCase ? effectiveValues(activeDs, selCase)
    : Object.fromEntries(fields.filter(f => f.default !== undefined && f.default !== '').map(f => [f.key, f.default]))), [activeDs, selCase, JSON.stringify(fields)]);
  const draftOn = draft && draft.caseId === (selCase?.id || null);
  const values = draftOn ? draft.values : savedValues;
  const draftDirty = !!draftOn && JSON.stringify(draft.values) !== JSON.stringify(savedValues);
  const setValues = v => { setDraft({ caseId: selCase?.id || null, values: v }); setRunWarn(null); };
  const testInput = useMemo(() => (trigger ? JSON.stringify(buildTriggerInput(trigger, fields, values)) : ''), [trigger, values, JSON.stringify(fields)]);
  useEffect(() => { api('/agents').then(l => setAgentCfg(Object.fromEntries(l.map(a => [a.id, a.config || {}])))).catch(() => {}); }, []);
  const analysis = useMemo(() => analyzeInputs(graph, trigger?.id, { agents: agentCfg }), [graph, trigger?.id, agentCfg]);
  const issuesByNode = useMemo(() => {
    const m = {};
    for (const u of analysis.undeclared) for (const nid of u.nodes) (m[nid] ||= []).push(u);
    return m;
  }, [analysis]);
  const editTrigger = patch => trigger && edit(g => ({ ...g, nodes: g.nodes.map(n => (n.id === trigger.id ? { ...n, params: { ...n.params, ...patch(n.params) } } : n)) }));
  const declareField = f => editTrigger(p => ({ inputFields: [...(p.inputFields || []).filter(x => x.path !== f.path), f] }));
  const ignoreInput = path => editTrigger(p => ({ ignoredInputs: [...new Set([...(p.ignoredInputs || []), path])] }));
  const runOpen = sideTab === 'run' && !sel;
  const openRun = () => { setSel(null); setSelEdge(null); setSideTab('run'); };
  // Una llamada capturada en modo escucha: se selecciona su caso
  useEffect(() => subscribe(m => {
    if (m.type === 'capture' && m.workflowId === id) { setActiveDsId(m.datasetId); setSelCaseId(m.caseId); }
  }), [id, subscribe]);

  // stopAt: id de nodo para «ejecutar hasta aquí» (solo ese nodo y los anteriores).
  // opts.caseId + saved: ejecuta ese caso con sus valores guardados (lista de Casos) · opts.force: sin validar
  const runNow = async (stopAt, opts = {}) => {
    const caseId = opts.caseId || selCase?.id || null;
    const vals = opts.saved ? effectiveValues(activeDs, activeDs?.cases.find(c => c.id === caseId)) : values;
    const errors = opts.force ? [] : validateInput(fields, vals);
    if (errors.length) { setRunWarn({ errors }); openRun(); return; }
    setRunWarn(null);
    if (dirty && !(await save())) return;
    setLogsOpen(true); setErr('');
    try {
      const body = caseId ? { caseId, ...(opts.saved ? {} : { values: vals }) } : { input: trigger ? buildTriggerInput(trigger, fields, vals) : {} };
      const { runId } = await api(`/workflows/${id}/run`, { method: 'POST', body: { ...body, ...(stopAt ? { stopAt } : {}) } });
      if (runRef.current?.id !== runId) setRun({ id: runId, status: 'running', steps: {}, logs: [] });
    } catch (e) { setErr(e.message); }
  };
  const cancel = () => run && api(`/runs/${run.id}/cancel`, { method: 'POST' }).catch(e => setErr(e.message));
  const decide = (nodeId, approved, scope) =>
    api(`/runs/${run.id}/approvals/${nodeId}`, { method: 'POST', body: { approved, scope, by: localStorage.getItem('orq_user') || 'panel' } }).catch(e => setErr(e.message));

  const byId = useMemo(() => Object.fromEntries(graph.nodes.map(n => [n.id, n])), [graph.nodes]);
  // Se vuelve a pedir la lista si aparece un agente que no conocemos (p. ej. «Guardar como agente»)
  const agentIds = graph.nodes.filter(n => n.type === 'agent' && n.params?.agentId).map(n => n.params.agentId);
  const missingAgent = agentIds.some(a => !(a in agents));
  useEffect(() => {
    if (!missingAgent) return;
    api('/agents').then(l => setAgents(a => ({ ...Object.fromEntries(agentIds.map(x => [x, null])), ...a, ...Object.fromEntries(l.map(x => [x.id, x.name])) }))).catch(() => {});
  }, [missingAgent]);
  const steps = run?.steps || {};
  const waitingKey = Object.values(steps).map(s => s.status).join();
  useEffect(() => {
    if (!run?.id || run.status !== 'waiting') { setTreePending(null); return; }
    let off = false;
    api(`/runs/${run.id}/trace`).then(t => { if (!off) setTreePending(pendingIn(t)); }).catch(() => {});
    return () => { off = true; };
  }, [run?.id, run?.status, waitingKey, pendingTick]);
  // Mientras no llega la traza, las propias (sin los nodos Sub-workflow, cuya espera está en el hijo)
  const pending = treePending ?? Object.entries(steps).filter(([nid, s]) => s.status === 'waiting' && byId[nid] && byId[nid].type !== 'subflow')
    .map(([nid]) => ({ runId: run.id, nodeId: nid, nodeName: byId[nid].name, meta: steps[nid].meta, nivel: 0 }));

  const palette = GROUPS.map(g => ({
    g, items: Object.keys(TYPES).filter(k => TYPES[k].group === g && (!q || `${TYPES[k].label} ${TYPES[k].desc}`.toLowerCase().includes(q.toLowerCase()))),
  })).filter(x => x.items.length);

  if (!wf) return <div className="editor"><div className="empty-state">{err || 'Cargando…'}</div></div>;
  const selNode = sel && byId[sel];
  const st = run ? STATUS[run.status] || STATUS.running : null;

  return (
    <div className="editor">
      <header className="topbar">
        <a className="crumb" href="#/workflows">Workflows</a>
        <i className="ph ph-caret-right" style={{ color: 'var(--color-neutral-700)', fontSize: 12 }} />
        <span className="topbar-title">{wf.name}</span>
        <button className="toggle" onClick={toggleActive} disabled={saving} title={wf.active ? 'Desactivar: deja de ejecutarse por horario, webhook o evento' : `Activar: empieza a ejecutarse por horario, webhook o evento${dirty ? ' (se guardan también los cambios)' : ''}`}>
          <span className={`switch ${wf.active ? 'on' : ''}`}><span /></span>{wf.active ? 'Activo' : 'Inactivo'}
        </button>
        <div style={{ flex: 1 }} />
        {err && <span className="topbar-err" title={err}><i className="ph-fill ph-warning-circle" />{err}</span>}
        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{saving ? 'Guardando…' : dirty ? 'Cambios sin guardar' : 'Guardado'}</span>
        <button className="btn btn-secondary btn-sm" onClick={() => save()} disabled={saving || !dirty}><i className="ph ph-floppy-disk" />Guardar</button>
        {active
          ? <button className="btn btn-secondary btn-sm" onClick={cancel}><i className="ph ph-stop" />Detener</button>
          : <button className={`btn btn-primary btn-sm ${runOpen ? 'is-on' : ''}`} onClick={() => (runOpen ? runNow() : openRun())} title={runOpen ? 'Ejecutar (Ctrl + Enter)' : 'Abrir el panel de ejecución'}><i className="ph ph-play" />Ejecutar</button>}
      </header>

      <div className="body">
        <aside className="side palette" style={{ width: palOpen ? 236 : 52 }}>
          <div className="pal-head">
            {palOpen && <span className="eyebrow">Nodos</span>}
            <button className="btn btn-icon btn-xs" onClick={() => { setPalOpen(o => !o); setTimeout(() => fit(), 50); }} title={palOpen ? 'Contraer' : 'Expandir'}>
              <i className={`ph ${palOpen ? 'ph-sidebar-simple' : 'ph-caret-double-right'}`} />
            </button>
          </div>
          {palOpen && (
            <div className="search"><i className="ph ph-magnifying-glass" /><input className="input" placeholder="Buscar nodo…" value={q} onChange={e => setQ(e.target.value)} /></div>
          )}
          <div className="pal-list">
            {palette.map(({ g, items }) => (
              <div key={g} className="pal-group">
                {palOpen && <div className="pal-group-name">{g}</div>}
                {items.map(k => (
                  <div key={k} className="pal-item" draggable title={TYPES[k].label}
                    onDragStart={e => { e.dataTransfer.setData('text/plain', k); e.dataTransfer.effectAllowed = 'copy'; }}
                    onClick={() => paletteClick(k)}>
                    <div className={`tile sm ${tileClass(k)}`}><i className={`ph ${TYPES[k].icon}`} /></div>
                    {palOpen && <div className="pal-txt"><span>{TYPES[k].label}</span><small>{TYPES[k].desc}</small></div>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </aside>

        <div className="center">
          <div ref={cv} className="canvas"
            style={{ backgroundSize: `${20 * view.z}px ${20 * view.z}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
            onMouseDown={e => { if (e.button !== 0) return; drag.current = { t: 'pan', cx: e.clientX, cy: e.clientY, px: view.x, py: view.y }; setSel(null); setSelEdge(null); }}
            onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
            onDrop={e => { e.preventDefault(); const k = e.dataTransfer.getData('text/plain'); if (!TYPES[k]) return; const p = toCanvas(e); addNode(k, p.x - NW / 2, p.y - NH / 2); }}>
            <div className="layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
              <svg className="edges">
                {graph.edges.map(e => {
                  const a = byId[e.from], b = byId[e.to];
                  if (!a || !b) return null;
                  const x1 = a.x + NW, y1 = a.y + portY(a.type, e.port), x2 = b.x - 4, y2 = b.y + NH / 2;
                  const sa = steps[e.from]?.status, sb = steps[e.to]?.status;
                  const cls = sa === 'success' && (sb === 'running' || sb === 'waiting') ? 'active' : sa === 'success' && sb ? 'done' : selEdge === e.id ? 'sel' : '';
                  const d = curve(x1, y1, x2, y2);
                  return (
                    <g key={e.id}>
                      <path d={d} className="edge-hit" onMouseDown={ev => { ev.stopPropagation(); setSelEdge(e.id); setSel(null); }} />
                      <path d={d} className={`edge ${cls}`} />
                      <circle cx={x2} cy={y2} r="3" className={`edge-end ${cls}`} />
                    </g>
                  );
                })}
                {link && byId[link.from] && <path className="edge link" d={curve(byId[link.from].x + NW, byId[link.from].y + portY(byId[link.from].type, link.port), link.x, link.y)} />}
              </svg>
              {selEdge && (() => {
                const e = graph.edges.find(x => x.id === selEdge), a = e && byId[e.from], b = e && byId[e.to];
                if (!a || !b) return null;
                return <button className="edge-del" style={{ left: (a.x + NW + b.x) / 2, top: (a.y + portY(a.type, e.port) + b.y + NH / 2) / 2 }} onMouseDown={ev => { ev.stopPropagation(); deleteSel(); }} title="Eliminar conexión"><i className="ph ph-trash" /></button>;
              })()}
              {graph.nodes.map(n => {
                const t = TYPES[n.type] || TYPES.node, s = steps[n.id], icon = s && STATUS_ICON[s.status];
                const iss = issuesByNode[n.id];
                const hi = sel === n.id || (runOpen && n.id === trigger?.id);
                return (
                  <div key={n.id} className={`node st-${s?.status || 'idle'} ${hi ? 'is-sel' : ''} ${iss ? 'warn-input' : ''}`} style={{ left: n.x, top: n.y }}
                    onMouseDown={e => { if (e.button !== 0) return; e.stopPropagation(); drag.current = { t: 'node', id: n.id, cx: e.clientX, cy: e.clientY, nx: n.x, ny: n.y }; setSel(n.id); setSelEdge(null); }}
                    onMouseUp={() => connect(n.id)}>
                    <div className={`tile ${tileClass(n.type)}`}><i className={`ph ${t.icon}`} /></div>
                    <div className="node-txt">
                      <span className="node-kind">{t.kind}{n.type === 'agent' && n.params?.agentId && (
                        <span className={agents[n.params.agentId] ? 'node-agent' : 'node-agent missing'}> · {agents[n.params.agentId] || (n.params.agentId in agents ? 'agente no encontrado' : '…')}</span>
                      )}</span>
                      <span className="node-name">{n.name}</span>
                    </div>
                    {icon && <i className={icon[0]} style={{ color: icon[1], fontSize: 17 }} />}
                    {iss && !icon && <i className="ph-fill ph-warning node-warn" />}
                    {iss && (
                      <div className="inp-pop elev-md" onMouseDown={e => e.stopPropagation()} onMouseUp={e => e.stopPropagation()}>
                        <b><i className="ph-fill ph-warning" />Campo{iss.length > 1 ? 's' : ''} no declarado{iss.length > 1 ? 's' : ''}</b>
                        <span>{TYPES[n.type]?.kind === 'Base de datos' ? 'La consulta usa' : 'Usa'} {iss.map((u, i) => <Fragment key={u.path}>{i ? ', ' : ''}<span className="mono">{u.path}</span></Fragment>)}, que no está{iss.length > 1 ? 'n' : ''} en la entrada de «{trigger?.name}».</span>
                        <div className="row">
                          <button className="btn btn-primary btn-xs-text" onClick={() => iss.forEach(u => declareField({ key: u.key, path: u.path, type: /email/i.test(u.key) ? 'email' : 'text', required: true, help: '' }))}>Añadir a la entrada</button>
                          <button className="btn btn-ghost btn-xs-text" onClick={() => iss.forEach(u => ignoreInput(u.path))}>Ignorar</button>
                        </div>
                      </div>
                    )}
                    {!TRIGGERS.includes(n.type) && <div className={`port in ${link ? 'hot' : ''}`} />}
                    {outPorts(n.type).map(p => (
                      <Fragment key={p.port}>
                        <div className="port out" style={{ top: p.top }} title="Arrastra para conectar"
                          onMouseDown={e => { e.stopPropagation(); drag.current = { t: 'link', from: n.id, port: p.port }; setLink({ from: n.id, port: p.port, ...toCanvas(e) }); }} />
                        {p.label && <span className="port-label" style={{ top: p.top - 4 }}>{p.label}</span>}
                      </Fragment>
                    ))}
                    {s?.worker && <div className="node-worker"><i className="ph ph-cpu" />{s.worker}</div>}
                  </div>
                );
              })}
            </div>
            {!graph.nodes.length && <div className="canvas-empty"><i className="ph ph-plus-circle" />Arrastra un disparador desde la paleta para empezar</div>}
            <a className="orq-badge" href="#/workers" onMouseDown={e => e.stopPropagation()}>
              <span className={`dot ${active ? 'pulse' : ''}`} style={{ background: workers.length ? (active ? 'var(--color-accent)' : 'var(--ok)') : 'var(--err)' }} />
              {workers.length ? `${workers.filter(w => w.enabled).length} workers · ${[...new Set(workers.flatMap(w => w.caps))].join(', ')}` : 'Sin workers conectados'}
            </a>
            <div className="zoom" onMouseDown={e => e.stopPropagation()}>
              <button className="btn btn-icon btn-xs" onClick={() => zoomBy(1 / 1.2)}><i className="ph ph-minus" /></button>
              <span className="mono">{Math.round(view.z * 100)}%</span>
              <button className="btn btn-icon btn-xs" onClick={() => zoomBy(1.2)}><i className="ph ph-plus" /></button>
              <button className="btn btn-icon btn-xs" onClick={() => fit()} title="Ajustar a la vista"><i className="ph ph-corners-out" /></button>
            </div>
          </div>

          <section className="logs">
            <div className="logs-head">
              <i className="ph ph-terminal-window" />
              <span className="logs-title">Ejecución</span>
              {run ? (
                <>
                  <a className="mono muted" href={`#/runs/${run.id}`}>{run.id}</a>
                  <span className="status" style={{ color: st.color }}><span className={`dot ${st.pulse ? 'pulse' : ''}`} style={{ background: st.color }} />{st.label}</span>
                  <span className="mono muted">{dur(run.run?.startedAt, run.run?.finishedAt)}</span>
                </>
              ) : <span className="muted">Sin ejecuciones</span>}
              <div style={{ flex: 1, minWidth: 8 }} />
              {pending.map(p => (
                <span key={`${p.runId}:${p.nodeId}`} className="pending" title={p.nivel ? `En el sub-workflow «${p.workflowName}» (${p.runId})` : undefined}>
                  <i className="ph-fill ph-pause-circle" style={{ color: 'var(--warn)' }} /><span className="pending-name">{p.nivel ? `${p.workflowName} › ` : ''}{p.nodeName}</span>
                  <DecisionButtons meta={p.meta} size="xs-text" onDecide={(ok, scope) => decideIn(p.runId, p.nodeId, ok, scope).then(() => setPendingTick(t => t + 1), e => setErr(e.message))} />
                </span>
              ))}
              {run && <button className="btn btn-secondary btn-xs-text" onClick={() => { setSel(null); setSelEdge(null); setSideTab('traza'); }} title="Ver la traza (árbol de pasos, con los sub-workflows) en el panel derecho"><i className="ph ph-tree-view" />Traza</button>}
              <button className="btn btn-icon btn-xs" onClick={() => setLogsOpen(o => !o)}><i className={`ph ${logsOpen ? 'ph-caret-down' : 'ph-caret-up'}`} /></button>
            </div>
            {logsOpen && (
              <div className="logs-body mono" ref={logEl}>
                {!run?.logs?.length && <div className="logs-empty">Pulsa «Ejecutar» para lanzar el workflow con los datos de prueba, o dispáralo por webhook/cron: las ejecuciones aparecen aquí en vivo.</div>}
                {run?.logs?.map(l => (
                  <div key={l.id} className="log-row">
                    <span className="log-t">+{((l.ts - (run.run?.startedAt || run.logs[0].ts)) / 1000).toFixed(2)}s</span>
                    <i className={LOG_ICON[l.level]?.[0]} style={{ color: LOG_ICON[l.level]?.[1] }} />
                    <span className="log-node">{l.node || '—'}</span>
                    <span className="log-worker">{l.worker || ''}</span>
                    <span className="log-msg" title={l.msg}>{l.msg}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {runOpen ? (
          <RunPanel
            wf={wf} graph={graph} trigger={trigger} fields={fields} analysis={analysis} data={dsData} reload={reloadDs}
            activeDs={activeDs} selCase={selCase} values={values} setValues={setValues} dirty={draftDirty}
            setActiveDsId={v => { setActiveDsId(v); setDraft(null); }} setSelCaseId={v => { setSelCaseId(v); setDraft(null); setRunWarn(null); }}
            running={!!active} runWarn={runWarn} onRun={opts => runNow(undefined, opts)} onClose={() => setSideTab('wf')}
            onDeclare={declareField} onSelectNode={nid => { setSel(nid); setSelEdge(null); }} subscribe={subscribe} onError={setErr}
          />
        ) : (selNode || window.innerWidth >= 1200) && (
          <NodePanel
            node={selNode} step={selNode && steps[selNode.id]} workers={workers} workflows={allWfs.filter(w => w.id !== id)}
            wf={wf} graph={graph} steps={steps} running={!!active} onRunUntil={nid => runNow(nid)}
            testInput={testInput} testLabel={selCase ? `según el caso «${selCase.name}»` : 'según los campos de entrada'}
            analysis={analysis} inputIssues={selNode ? issuesByNode[selNode.id] : null} onDeclare={declareField} onIgnore={ignoreInput} onOpenRun={openRun}
            triggerName={trigger?.name}
            runId={run?.id} traceRefresh={`${run?.status}|${Object.values(steps).map(s => s.status).join()}`}
            sideTab={sideTab} onSideTab={setSideTab} onSelectNode={nid => { setSel(nid); setSelEdge(null); }}
            onLeave={async href => { if (dirty && !(await save())) return; location.hash = href; }}
            onWf={patch => { setWf(w => ({ ...w, ...patch })); setDirty(true); }}
            onSettings={patch => edit(g => ({ ...g, settings: { ...g.settings, ...patch } }))}
            onNode={patch => edit(g => ({ ...g, nodes: g.nodes.map(n => (n.id === sel ? { ...n, ...patch } : n)) }))}
            onDelete={deleteSel} onClose={() => setSel(null)}
            onDecide={(approved, scope) => decide(selNode.id, approved, scope)}
          />
        )}
      </div>
    </div>
  );
}
