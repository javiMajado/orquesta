import { Fragment, useEffect, useRef, useState } from 'react';
import { TYPES, FIELDS, CAPS, tileClass } from './nodeTypes.js';
import { api, pretty } from './api.js';
import { DataPicker, AutoHint } from './DataPicker.jsx';
import Trace from './Trace.jsx';
import { DecisionButtons, approvalText, ReviewParams } from './Approvals.jsx';

export { DecisionButtons, approvalText, ReviewParams };

const CAP_LABEL = { orq: 'orquestador', human: 'humano' };
const SOURCE = { shell: 'heredada del shell', env: '.env de Orquesta', none: 'sin clave' };

// Misma regla que server/src/llm.js: qué proveedor y modelo usará el nodo
export function effectiveLlm(params, llm) {
  const def = llm?.default || {};
  const provider = params.provider || def.provider || 'mock';
  const info = llm?.providers?.find(p => p.id === provider) || null;
  const model = params.model || (provider === def.provider ? def.model : '') || info?.defaultModel || (provider === 'mock' ? 'mock' : '');
  return { provider, model, info, fromDefault: !params.provider };
}

// Texto de «qué clave usa» para mostrar en panel, barra y Workers
export const keyText = info => !info ? 'proveedor no conectado'
  : info.kind === 'mock' ? 'simulado · sin clave ni coste'
  : `${info.keyEnv} · ${SOURCE[info.source] || info.source}${info.fingerprint ? ` · huella ${info.fingerprint}` : ''}`;

export function LlmFields({ node, setParam, workers }) {
  const [llm, setLlm] = useState(null);
  const [models, setModels] = useState({});
  const [err, setErr] = useState('');
  useEffect(() => { api('/llm').then(setLlm).catch(e => setErr(e.message)); }, [workers]);
  const p = node.params;
  const eff = effectiveLlm(p, llm);
  const loadModels = () => {
    if (!eff.info?.enabled || models[eff.provider]) return;
    api(`/llm/models?provider=${encodeURIComponent(eff.provider)}`)
      .then(r => setModels(m => ({ ...m, [eff.provider]: r.models })))
      .catch(e => setErr(`No se pudieron listar los modelos: ${e.message}`));
  };
  const tone = llmTone(eff.info);
  const defLabel = llm?.default?.provider ? `${llm.default.provider}${llm.default.model ? ` · ${llm.default.model}` : ''}` : 'simulado';

  return (
    <>
      <div className="field">
        <label>Proveedor LLM</label>
        <select className="input" value={p.provider || ''} onChange={e => setParam('provider', e.target.value)}>
          <option value="">Por defecto ({defLabel})</option>
          {(llm?.providers || []).map(x => <option key={x.id} value={x.id}>{x.label}{x.enabled ? '' : ' · desactivado'}</option>)}
          {p.provider && llm && !llm.providers.some(x => x.id === p.provider) && <option value={p.provider}>{p.provider} · no conectado</option>}
        </select>
      </div>
      <div className="field">
        <label>Modelo</label>
        <input className="input mono" list={`models-${node.id}`} value={p.model || ''} placeholder={eff.model || 'elige un modelo'} onFocus={loadModels} onChange={e => setParam('model', e.target.value)} />
        <datalist id={`models-${node.id}`}>{(models[eff.provider] || []).map(m => <option key={m} value={m} />)}</datalist>
        <small className="help">Vacío = {eff.model || '—'}. La lista se pide al proveedor al pulsar el campo.</small>
      </div>
      <div className={`llm-box ${tone}`}>
        <i className={`ph ${tone === 'err' ? 'ph-warning-circle' : 'ph-key'}`} />
        <div>
          <b>Esta ejecución usará: {eff.info?.label || eff.provider} · {eff.model || '¿modelo?'}</b>
          <span>{eff.info?.host ? `${eff.info.host} · ` : ''}{keyText(eff.info)}</span>
          {eff.info && !eff.info.enabled && <span>{eff.info.reason}</span>}
        </div>
      </div>
      {err && <small className="help" style={{ color: 'var(--err)' }}>{err}</small>}
      {eff.info?.kind === 'mock' && (
        <div className="field">
          <label>Respuesta simulada</label>
          <textarea className="input mono" rows={4} spellCheck={false} value={p.mockOutput || ''} onChange={e => setParam('mockOutput', e.target.value)} placeholder={'{ "resumen": "…" }  ·  o {{ ({ ...$json }) }}'} />
          <small className="help">Lo que devuelve el proveedor simulado. Admite {'{{ expresiones }}'}. Vacío = eco de la entrada.</small>
        </div>
      )}
      {eff.info?.kind === 'mock' && (
        <div className="field">
          <label>Llamadas simuladas a herramientas</label>
          <textarea className="input mono" rows={3} spellCheck={false} value={p.mockTools || ''} onChange={e => setParam('mockTools', e.target.value)} placeholder={'[{ "name": "listar_ficheros", "input": { "ruta": "C:/repo" } }]'} />
          <small className="help">Opcional. El simulado pide estas herramientas (de verdad) antes de responder: sirve para probar herramientas y aprobaciones sin LLM.</small>
        </div>
      )}
    </>
  );
}

// Tono del recuadro según qué clave usará el LLM: error, heredada del shell, simulado o .env
const llmTone = info => (!info || !info.enabled ? 'err' : info.source === 'shell' ? 'warn' : info.kind === 'mock' ? 'muted' : 'ok');
const keyLabel = info => (!info ? 'proveedor no conectado' : info.kind === 'mock' ? 'sin clave · sin coste' : `${info.keyEnv} · ${SOURCE[info.source] || info.source}`);

// Propiedades del esquema de respuesta, para mostrarlas («sql, supuestos»); null si no hay o no es válido
const schemaKeys = raw => { try { const k = Object.keys(JSON.parse(raw)?.properties || {}); return k.length ? k.join(', ') : null; } catch { return null; } };

// Ficha de un agente personalizado: identidad, configuración (modelo, clave, salida, herramientas)
// e instrucciones del sistema, cada cosa en su bloque
export function AgentCard({ agent, llm, actions, footer }) {
  const [open, setOpen] = useState(false);
  const c = agent.config || {};
  const eff = effectiveLlm(c, llm);
  const tone = llmTone(eff.info);
  const tools = String(c.tools || '').split(',').map(s => s.trim()).filter(Boolean);
  const prompt = String(c.prompt || '').trim();
  const long = prompt.length > 280 || prompt.split('\n').length > 4;
  return (
    <div className={`agent-card ${tone}`}>
      <div className="agent-card-head">
        <div className="tile sm agent"><i className="ph ph-robot" /></div>
        <div className="agent-card-title">
          <b>{agent.name}</b>
          {agent.description && <span>{agent.description}</span>}
        </div>
        {actions && <div className="agent-card-actions">{actions}</div>}
      </div>
      <dl className="agent-card-rows">
        <dt>Modelo</dt>
        <dd className="mono">{eff.info?.label || eff.provider} · {eff.model || '¿modelo?'}{eff.fromDefault && <small className="muted"> · por defecto</small>}</dd>
        <dt>Clave</dt>
        <dd>
          <span className="key-dot" />
          <span className={eff.info?.kind === 'mock' ? '' : 'mono'}>{keyLabel(eff.info)}</span>
          {eff.info?.fingerprint && <small className="muted mono"> · huella {eff.info.fingerprint}</small>}
          {eff.info && !eff.info.enabled && <small className="agent-card-warn">{eff.info.reason}</small>}
        </dd>
        <dt>Salida</dt>
        <dd>{c.output || 'Texto'}{c.output === 'JSON' && schemaKeys(c.schema) && <small className="muted"> · con esquema: <span className="mono">{schemaKeys(c.schema)}</span></small>}</dd>
        <dt>Herramientas</dt>
        <dd>
          {tools.length ? <span className="tags">{tools.map(t => <span key={t} className="tag tag-neutral mono">{t}</span>)}</span> : <span className="muted">ninguna</span>}
          {tools.includes('ejecutar_comando') && <small className="muted"> · {c.approveTools === 'No' ? 'comandos sin aprobación' : 'cada comando se aprueba'}</small>}
          {tools.length > 0 && <small className="muted"> · hasta {c.maxTurns || 8} turnos</small>}
        </dd>
      </dl>
      <div className="agent-card-prompt">
        <div className="agent-card-prompt-head">
          <span className="eyebrow">Instrucciones del sistema</span>
          {long && <button type="button" className="link-btn" onClick={() => setOpen(o => !o)}>{open ? 'Ver menos' : 'Ver todo'}</button>}
        </div>
        {prompt ? <div className="agent-card-prompt-text"><div className={open ? '' : 'clamp'}>{prompt}</div></div> : <span className="muted">Sin instrucciones.</span>}
      </div>
      {footer && <div className="agent-card-foot">{footer}</div>}
    </div>
  );
}

// Lo que aporta un agente personalizado (pantalla Agentes); el nodo conserva su entrada
const AGENT_KEYS = ['provider', 'model', 'prompt', 'output', 'schema', 'tools', 'approveTools', 'maxTurns', 'temperature', 'maxTokens', 'mockOutput', 'mockTools'];
// Con agente elegido, estos campos los pone el agente y no se muestran en el nodo
const FROM_AGENT = ['prompt', 'output', 'schema', 'tools', 'approveTools', 'maxTurns', 'temperature', 'maxTokens'];

// «Agente»: personalizado (configurado en el nodo) o uno guardado en la pantalla Agentes
function AgentPicker({ node, onNode, workers, onLeave }) {
  const [list, setList] = useState(null);
  const [llm, setLlm] = useState(null);
  const [msg, setMsg] = useState('');
  // «Guardar como agente»: formulario en el propio panel (window.prompt no existe en Electron)
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { api('/agents').then(setList).catch(e => setMsg(e.message)); }, []);
  useEffect(() => { setDraft(null); }, [node.id]);
  useEffect(() => { api('/llm').then(setLlm).catch(() => {}); }, [workers]);
  const p = node.params;
  const cur = list?.find(a => a.id === p.agentId);
  const set = patch => onNode({ params: { ...p, ...patch } });
  const go = href => (onLeave ? onLeave(href) : (location.hash = href));
  const renameTo = a => (a && (node.name === TYPES.agent.label || node.name === cur?.name) ? { name: a.name } : {});
  const choose = id => onNode({ params: { ...p, agentId: id }, ...renameTo(list?.find(a => a.id === id)) });

  // Desvincular: copia la configuración del agente al nodo para seguir editándola aquí
  const unlink = () => set({ ...cur.config, agentId: '', extraPrompt: '', prompt: [cur.config.prompt, p.extraPrompt].filter(Boolean).join('\n\n') });
  const startSave = () => { setMsg(''); setDraft({ name: node.name === TYPES.agent.label ? '' : node.name, description: '' }); };
  const saveAs = async () => {
    if (!draft.name.trim()) { setMsg('Ponle un nombre al agente.'); return; }
    setSaving(true); setMsg('');
    try {
      const a = await api('/agents', { method: 'POST', body: { name: draft.name, description: draft.description, config: Object.fromEntries(AGENT_KEYS.map(k => [k, p[k] ?? ''])) } });
      setList(l => [...(l || []), a]);
      onNode({ params: { ...p, agentId: a.id }, ...(node.name === TYPES.agent.label ? { name: a.name } : {}) });
      setDraft(null);
      setMsg(`Guardado como «${a.name}»: este nodo ya lo usa. Puedes editarlo en Agentes.`);
    } catch (e) { setMsg(e.message); } finally { setSaving(false); }
  };

  return (
    <>
      <div className="field">
        <label>Agente</label>
        <select className="input" value={p.agentId || ''} onChange={e => { setMsg(''); choose(e.target.value); }}>
          <option value="">Personalizado (se configura en este nodo)</option>
          {(list || []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          {p.agentId && list && !cur && <option value={p.agentId}>{p.agentId} · no existe</option>}
        </select>
        {!p.agentId && <small className="help">O elige uno de <a href="#/agents" onClick={e => { e.preventDefault(); go('#/agents'); }}>Agentes</a> para reutilizar su configuración.</small>}
      </div>
      {cur && (
        <AgentCard agent={cur} llm={llm} actions={<>
          <button type="button" className="btn btn-icon btn-xs" onClick={() => go(`#/agents/${cur.id}`)} title="Editar agente"><i className="ph ph-pencil-simple" /></button>
          <button type="button" className="btn btn-icon btn-xs" onClick={unlink} title="Desvincular: copia la configuración al nodo y deja de usar el agente"><i className="ph ph-link-break" /></button>
        </>} />
      )}
      {p.agentId && list && !cur && <small className="help" style={{ color: 'var(--err)' }}>Este agente se ha eliminado: elige otro o vuelve a «Personalizado».</small>}
      {!p.agentId && !draft && <div className="picker-row"><button type="button" className="btn btn-secondary btn-sm" onClick={startSave} title="Guarda la configuración de este nodo como un agente reutilizable"><i className="ph ph-floppy-disk" />Guardar como agente</button></div>}
      {!p.agentId && draft && (
        <div className="save-agent">
          <span className="eyebrow">Guardar como agente</span>
          <div className="field">
            <label>Nombre</label>
            <input className="input" autoFocus value={draft.name} placeholder="p. ej. Revisor de seguridad" maxLength={80}
              onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') saveAs(); if (e.key === 'Escape') setDraft(null); }} />
          </div>
          <div className="field">
            <label>Descripción <small className="muted">(opcional)</small></label>
            <input className="input" value={draft.description} placeholder="Para qué sirve" onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') saveAs(); if (e.key === 'Escape') setDraft(null); }} />
          </div>
          <small className="help">Se guardan el proveedor, el modelo, las instrucciones, el formato, las herramientas y el resto de ajustes de este nodo. La entrada sigue siendo de cada nodo.</small>
          <div className="row" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDraft(null)} disabled={saving}>Cancelar</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={saveAs} disabled={saving || !draft.name.trim()}><i className="ph ph-floppy-disk" />Guardar</button>
          </div>
        </div>
      )}
      {msg && <small className="help">{msg}</small>}
    </>
  );
}

// Campos del nodo Fichero que solo aplican a una de las acciones
const FILE_ONLY = { format: 'Leer', ifMissing: 'Leer', content: 'Escribir', ifExists: 'Escribir' };
const desktop = typeof window !== 'undefined' ? window.orquestaDesktop : null;

// «Examinar…»: diálogo nativo de Windows en la app de escritorio
function FilePicker({ node, setParam }) {
  const [msg, setMsg] = useState('');
  if (!desktop) return <small className="help">En la app de escritorio puedes elegir el fichero con «Examinar…».</small>;
  const pick = async () => {
    setMsg('');
    try {
      const r = await desktop.pickFile({ mode: node.params.action === 'Escribir' ? 'save' : 'open', current: node.params.path || '' });
      if (r.canceled) { if (r.reason) setMsg(r.reason); return; }
      setParam('path', r.path);
      if (r.added) setMsg(`Carpeta permitida: ${r.added}`);
    } catch (e) { setMsg(e.message); }
  };
  return (
    <div className="picker-row">
      <button type="button" className="btn btn-secondary btn-sm" onClick={pick}>
        <i className={`ph ${node.params.action === 'Escribir' ? 'ph-floppy-disk' : 'ph-folder-open'}`} />
        {node.params.action === 'Escribir' ? 'Elegir dónde guardar…' : 'Examinar…'}
      </button>
      {msg && <small className="help">{msg}</small>}
    </div>
  );
}

// Desplegable de conexiones (pantalla Conexiones + DB_CONNECTIONS del .env)
function ConnSelect({ value, onChange }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('/connections').then(setList).catch(e => setErr(e.message)); }, []);
  // Guardado por id; los workflows antiguos pueden tener el nombre
  const cur = list?.find(c => c.id === value || c.name === value || c.id === `env:${value}`);
  return (
    <div className="field">
      <label>Conexión</label>
      <select className="input" value={cur?.id || value || ''} onChange={e => onChange('conn', e.target.value)}>
        <option value="">— elegir conexión —</option>
        {(list || []).map(c => <option key={c.id} value={c.id}>{c.name} · {c.driver === 'pg' ? 'PostgreSQL' : 'SQLite'}{c.readOnly ? ' · solo lectura' : ' · lectura y escritura'}</option>)}
        {value && list && !cur && <option value={value}>{value} · no existe</option>}
      </select>
      {err && <small className="help" style={{ color: 'var(--err)' }}>{err}</small>}
      {list && !list.length && <small className="help">No hay conexiones: créalas en <a href="#/connections">Conexiones</a>.</small>}
      {cur && <small className="help">{cur.readOnly ? 'Solo lectura: las consultas que modifiquen datos fallarán.' : '⚠ Lectura y escritura: esta conexión puede modificar datos.'} <a href="#/connections">Gestionar conexiones</a></small>}
    </div>
  );
}



// Busca en una salida una lista de objetos (respuesta de una API, filas de BD…) para pintarla como
// tabla: la propia salida o un campo hasta dos niveles de profundidad (body, rows, items…)
const isRows = v => Array.isArray(v) && v.length > 0 && v.every(x => x && typeof x === 'object' && !Array.isArray(x));
const PREFER = ['body', 'rows', 'data', 'items', 'usuarios', 'filas', 'resultados', 'results'];
export function findRows(v, depth = 0, at = '') {
  if (isRows(v)) return { rows: v, at };
  if (!v || typeof v !== 'object' || Array.isArray(v) || depth > 1) return null;
  const keys = [...PREFER.filter(k => k in v), ...Object.keys(v).filter(k => !PREFER.includes(k))];
  for (const k of keys) {
    const r = findRows(v[k], depth + 1, at ? `${at}.${k}` : k);
    if (r) return r;
  }
  return null;
}

const cell = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function DataTable({ value, max = 50 }) {
  const found = findRows(value);
  if (!found) return null;
  const { rows, at } = found;
  const cols = [...new Set(rows.slice(0, 20).flatMap(r => Object.keys(r)))].slice(0, 8);
  return (
    <div className="data-table">
      <span className="help">{rows.length} fila{rows.length === 1 ? '' : 's'}{at ? <> en <span className="mono">{at}</span></> : ''}{rows.length > max ? ` · se muestran ${max}` : ''}</span>
      <div className="data-table-scroll">
        <table>
          <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{rows.slice(0, max).map((r, i) => <tr key={i}>{cols.map(c => <td key={c} title={cell(r[c])}>{cell(r[c]).slice(0, 80)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

export function LlmMeta({ meta }) {
  if (!meta?.llm) return null;
  const { llm, usage } = meta;
  return (
    <>
      <div className="kv"><span>LLM</span><span className="mono">{llm.label} · {llm.model}</span></div>
      <div className="kv"><span>Clave</span><span className="mono">{keyText(llm)}</span></div>
      {usage && <div className="kv"><span>Tokens{usage.estimado ? ' (estimados)' : ''}</span><span className="mono">{usage.input?.toLocaleString('es')} entrada · {usage.output?.toLocaleString('es')} salida</span></div>}
    </>
  );
}

// onFocus: el panel recuerda el último campo de texto usado, para insertar ahí los datos elegidos
export function Field({ f, value, onChange, workflows = [], onFocus }) {
  const [key, label, kind, opts, mono, rows, help] = f;
  const options = opts === 'WF' ? ['', ...workflows.map(w => w.name)] : opts || [];
  const cls = `input ${mono ? 'mono' : ''}`;
  return (
    <div className="field">
      <label>{label}</label>
      {kind === 's' ? (
        <select className={cls} value={value ?? ''} onChange={e => onChange(key, e.target.value)}>
          {options.map(o => <option key={o} value={o}>{o || '— elegir —'}</option>)}
        </select>
      ) : kind === 't' ? (
        <textarea className={cls} rows={rows || 3} spellCheck={false} value={value ?? ''} onChange={e => onChange(key, e.target.value)} onFocus={e => onFocus?.(key, e.target)} />
      ) : (
        <input className={cls} value={value ?? ''} onChange={e => onChange(key, e.target.value)} onFocus={e => onFocus?.(key, e.target)} />
      )}
      {help && <small className="help">{help}</small>}
    </div>
  );
}

// Campos donde se rellena solo con el texto del nodo anterior si se dejan vacíos
const AUTO = { agent: 'input', file: 'content', email: 'body' };

export default function NodePanel({ node, step, workers, workflows, wf, graph, steps = {}, running, onRunUntil, runId, traceRefresh, sideTab = 'wf', onSideTab, onSelectNode, onLeave, onWf, onSettings, onNode, onDelete, onClose, onDecide }) {
  const [tab, setTab] = useState('params');
  const focus = useRef(null); // { nodeId, key, el }: último campo de texto con el cursor
  const [pickMsg, setPickMsg] = useState('');
  useEffect(() => { setPickMsg(''); }, [node?.id]);

  if (!node) {
    return (
      <aside className="side panel">
        <div className="panel-head">
          <div className="tabs">
            <button className={sideTab !== 'traza' ? 'on' : ''} onClick={() => onSideTab?.('wf')}>Workflow</button>
            <button className={sideTab === 'traza' ? 'on' : ''} onClick={() => onSideTab?.('traza')}>Traza{running && <span className="tab-dot" />}</button>
          </div>
        </div>
        {sideTab === 'traza' ? (
          <div className="panel-scroll">
            <Trace runId={runId} refresh={traceRefresh} onSelect={onSelectNode} workflowId={wf.id} />
            {runId && <small className="help">Clic en un paso para seleccionar su nodo. Los sub-workflows se despliegan con los pasos de su ejecución.</small>}
          </div>
        ) : (
        <div className="panel-scroll">
          <span className="eyebrow">Workflow</span>
          <div className="field"><label>Nombre</label><input className="input" value={wf.name} onChange={e => onWf({ name: e.target.value })} /></div>
          <div className="field"><label>Descripción</label><textarea className="input" rows={3} value={wf.description || ''} onChange={e => onWf({ description: e.target.value })} /></div>
          <div className="field">
            <label>Colección</label>
            <input className="input" list="wf-collections" value={wf.collection || ''} placeholder="Sin colección" onChange={e => onWf({ collection: e.target.value })} />
            <datalist id="wf-collections">{[...new Set(workflows.map(w => w.collection).filter(Boolean))].map(c => <option key={c} value={c} />)}</datalist>
            <small className="help">Agrupa los workflows en la lista. Escribe una nueva o elige una existente.</small>
          </div>
          <div className="field">
            <label>Datos de prueba (JSON)</label>
            <textarea className="input mono" rows={9} spellCheck={false} value={graph.settings?.testInput || ''} onChange={e => onSettings({ testInput: e.target.value })} placeholder='{ "body": { … } }' />
            <small className="help">Entrada del disparador al pulsar «Ejecutar». Los webhooks reciben {'{ body, query, headers, method }'}.</small>
          </div>
          <div className="stats"><span><b>{graph.nodes.length}</b> nodos</span><span><b>{graph.edges.length}</b> conexiones</span></div>
          <span className="eyebrow" style={{ marginTop: 8 }}>Atajos</span>
          {[['Mover lienzo', 'arrastrar · rueda'], ['Zoom', 'Ctrl + rueda'], ['Conectar', 'puerto → nodo'], ['Eliminar', 'Supr'], ['Guardar', 'Ctrl + S']].map(([a, b]) => (
            <div key={a} className="shortcut"><span>{a}</span><span className="mono">{b}</span></div>
          ))}
        </div>
        )}
      </aside>
    );
  }

  const t = TYPES[node.type];
  const cap = CAPS[node.type];
  const setParam = (k, v) => onNode({ params: { ...node.params, [k]: v } });
  const setExec = (k, v) => onNode({ exec: { ...node.exec, [k]: v } });
  const pinnable = !['orq', 'human'].includes(cap);
  const hasOut = step && (step.output != null || step.error);
  const hookUrl = node.type === 'webhook' ? `${location.origin}/hooks${'/' + String(node.params.path || '').replace(/^\/+/, '')}` : null;
  const onFocusField = (key, el) => { focus.current = { nodeId: node.id, key, el }; };

  // Inserta un dato (expresión) donde estaba el cursor. En el código de un script y en la condición de un
  // nodo Condición es JavaScript directo: va sin {{ }}
  const pick = expr => {
    const f = focus.current;
    if (f && f.nodeId === node.id && f.el?.isConnected) {
      const code = f.key === 'code';
      const raw = code || (node.type === 'if' && f.key === 'expr');
      if (code && !expr.startsWith('$json')) { setPickMsg('En el código solo está disponible $json (lo que recibe este nodo). Para datos de nodos anteriores, pásalos por el nodo de antes.'); return; }
      const text = raw ? expr : `{{ ${expr} }}`;
      const cur = String(node.params[f.key] ?? '');
      const a = f.el.selectionStart ?? cur.length, b = f.el.selectionEnd ?? cur.length;
      setParam(f.key, cur.slice(0, a) + text + cur.slice(b));
      requestAnimationFrame(() => { if (f.el.isConnected) { f.el.focus(); f.el.setSelectionRange(a + text.length, a + text.length); } });
      setPickMsg(`Insertado ${text}`);
    } else {
      navigator.clipboard?.writeText(`{{ ${expr} }}`);
      setPickMsg(`Copiado {{ ${expr} }}: haz clic en un campo y pégalo (o pon el cursor en un campo antes de elegir el dato).`);
    }
  };

  return (
    <aside className="side panel">
      <div className="panel-head">
        <div className="panel-title">
          <div className={`tile ${tileClass(node.type)}`}><i className={`ph ${t.icon}`} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className="node-kind">{t.kind}</span>
            <input className="title-input" value={node.name} onChange={e => onNode({ name: e.target.value })} />
          </div>
          <button className="btn btn-icon btn-xs" onClick={onDelete} title="Eliminar nodo"><i className="ph ph-trash" /></button>
          <button className="btn btn-icon btn-xs" onClick={onClose} title="Cerrar"><i className="ph ph-x" /></button>
        </div>
        <div className="tabs">
          <button className={tab === 'params' ? 'on' : ''} onClick={() => setTab('params')}>Parámetros</button>
          <button className={tab === 'out' ? 'on' : ''} onClick={() => setTab('out')}>Salida{hasOut && <span className="tab-dot" />}</button>
          {onRunUntil && <button className="run-until" disabled={running} onClick={() => { onRunUntil(node.id); setTab('out'); }}
            title="Ejecuta el flujo con los Datos de prueba solo hasta este nodo (incluido): lo de después no se ejecuta"><i className="ph ph-play" />Ejecutar hasta aquí</button>}
        </div>
      </div>
      <div className="panel-scroll">
        {step?.status === 'waiting' && node.type === 'subflow' && step.childRunId && (
          <div className="approval-card">
            <b>El sub-workflow espera una aprobación</b>
            <span>Decide aquí abajo, en el paso que la espera:</span>
            <Trace runId={step.childRunId} refresh={step.status} workflowId={null} header={false} />
          </div>
        )}
        {step?.status === 'waiting' && node.type !== 'subflow' && (
          <div className="approval-card">
            <b>{approvalText(step.meta, node).title}</b>
            <span>{approvalText(step.meta, node).text}</span>
            <ReviewParams meta={step.meta} />
            <DecisionButtons meta={step.meta} onDecide={onDecide} />
          </div>
        )}
        {tab === 'params' ? (
          <>
            {hookUrl && (
              <div className="field">
                <label>URL del webhook</label>
                <div className="copy-row"><code className="mono">{node.params.method} {hookUrl}</code><button className="btn btn-icon btn-xs" onClick={() => navigator.clipboard?.writeText(hookUrl)} title="Copiar"><i className="ph ph-copy" /></button></div>
                <small className="help">Solo responde si el workflow está activo y guardado.</small>
              </div>
            )}
            {node.type === 'agent' && <AgentPicker node={node} onNode={onNode} workers={workers} onLeave={onLeave} />}
            {node.type === 'agent' && !node.params.agentId && <LlmFields node={node} setParam={setParam} workers={workers} />}
            {node.type === 'agent' && node.params.agentId && (
              <div className="field">
                <label>Instrucciones adicionales</label>
                <textarea className="input" rows={3} spellCheck={false} value={node.params.extraPrompt || ''} onChange={e => setParam('extraPrompt', e.target.value)} onFocus={e => onFocusField('extraPrompt', e.target)} />
                <small className="help">Opcional. Se añaden al final de las instrucciones del agente solo en este nodo.</small>
              </div>
            )}
            {node.type === 'node' && <div className="llm-box warn"><i className="ph ph-warning" /><div><b>Se ejecuta con los permisos de tu usuario</b><span>El código corre en el worker sin aislamiento: solo código de confianza.</span></div></div>}
            {(FIELDS[node.type] || [])
              .filter(f => node.type !== 'file' || !FILE_ONLY[f[0]] || FILE_ONLY[f[0]] === (node.params.action || 'Leer'))
              .filter(f => node.type !== 'agent' || !node.params.agentId || !FROM_AGENT.includes(f[0]))
              .filter(f => node.type !== 'agent' || f[0] !== 'schema' || node.params.output === 'JSON')
              .map(f => (
                <Fragment key={f[0]}>
                  {f[2] === 'CONN'
                    ? <ConnSelect value={node.params[f[0]]} onChange={setParam} />
                    : <Field f={f} value={node.params[f[0]]} onChange={setParam} workflows={workflows} onFocus={onFocusField} />}
                  {node.type === 'file' && f[0] === 'path' && <FilePicker node={node} setParam={setParam} />}
                  {AUTO[node.type] === f[0] && <AutoHint node={node} graph={graph} steps={steps} testInput={graph.settings?.testInput} value={node.params[f[0]]} />}
                </Fragment>
              ))}
            <DataPicker node={node} graph={graph} steps={steps} testInput={graph.settings?.testInput} onPick={pick} onRunUntil={running ? null : onRunUntil} />
            {pickMsg && <small className="help pick-msg">{pickMsg}</small>}
            <div className="section-rule"><span className="eyebrow">Ejecución</span><span className="rule" /></div>
            <div className="kv"><span>Capacidad requerida</span><span className="tag tag-accent mono">{CAP_LABEL[cap] || cap}</span></div>
            {pinnable && (
              <>
                <div className="field">
                  <label>Worker</label>
                  <select className="input" value={node.exec?.worker || 'auto'} onChange={e => setExec('worker', e.target.value)}>
                    <option value="auto">Automático (orquestador)</option>
                    {workers.filter(w => w.caps.includes(cap)).map(w => <option key={w.id} value={w.id}>{w.id}{w.enabled ? '' : ' · desactivado'}</option>)}
                    {node.exec?.worker && node.exec.worker !== 'auto' && !workers.some(w => w.id === node.exec.worker) && <option value={node.exec.worker}>{node.exec.worker} · offline</option>}
                  </select>
                </div>
                <label className="check">
                  <input type="checkbox" checked={!!node.exec?.humanReview} onChange={e => setExec('humanReview', e.target.checked)} />
                  <span><b>Requiere aprobación humana</b><small className="help">Antes de ejecutar, el nodo se para y muestra los parámetros finales. No se ejecuta hasta aprobarlo.</small></span>
                </label>
                <div className="grid2">
                  <div className="field"><label>Reintentos</label><input className="input" value={node.exec?.retries ?? ''} onChange={e => setExec('retries', e.target.value)} /></div>
                  <div className="field"><label>Timeout</label><input className="input" value={node.exec?.timeout ?? ''} onChange={e => setExec('timeout', e.target.value)} /></div>
                </div>
              </>
            )}
          </>
        ) : hasOut ? (
          <>
            {step.worker && <div className="kv"><span>Ejecutado por</span><span className="mono accent">{step.worker}</span></div>}
            {step.childRunId && (
              <div className="sub-trace">
                <span className="eyebrow">Ejecución del sub-workflow</span>
                <Trace runId={step.childRunId} refresh={step.status} workflowId={null} />
              </div>
            )}
            <LlmMeta meta={step.meta} />
            {step.error && <pre className="out err">{step.error}</pre>}
            {step.output != null && <DataTable value={step.output} />}
            {step.output != null && <pre className="out">{pretty(step.output)}</pre>}
          </>
        ) : <p className="muted">Ejecuta el workflow para ver la salida de este nodo.</p>}
      </div>
    </aside>
  );
}
