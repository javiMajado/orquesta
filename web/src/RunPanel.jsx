import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, ago, dur } from './api.js';
import { TRIGGERS } from './nodeTypes.js';
import {
  TYPE_HINT, FIELD_TYPES, TYPE_LABEL, validateInput, caseSummary, diffFromCommon, expectText, coerce, newField,
} from '@orquesta/shared/inputs';

const isEmpty = v => v == null || v === '' || (Array.isArray(v) && !v.length);
const pluralCasos = n => `${n} caso${n === 1 ? '' : 's'}`;

// ── Controles de un campo de entrada ─────────────────────────────────────────
function ListControl({ value, onChange, file }) {
  const [txt, setTxt] = useState('');
  const list = Array.isArray(value) ? value : isEmpty(value) ? [] : [value];
  const add = () => { const t = txt.trim(); if (!t) return; onChange([...list, t]); setTxt(''); };
  return (
    <div className="rp-list">
      {list.map((x, i) => (
        <span key={i} className="tag tag-neutral rp-chip">
          <i className={`ph ${file ? 'ph-file' : 'ph-dot-outline'}`} />{typeof x === 'object' ? JSON.stringify(x) : String(x)}
          <button type="button" onClick={() => onChange(list.filter((_, j) => j !== i))} title="Quitar"><i className="ph ph-x" /></button>
        </span>
      ))}
      <input className="input rp-list-input" value={txt} placeholder={file ? 'nombre-del-fichero.png' : 'Añadir…'} onChange={e => setTxt(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} onBlur={add} />
    </div>
  );
}

function ObjectControl({ value, onChange }) {
  const [txt, setTxt] = useState(() => (value == null ? '' : JSON.stringify(value, null, 2)));
  const [bad, setBad] = useState(false);
  useEffect(() => { setTxt(value == null ? '' : JSON.stringify(value, null, 2)); }, [JSON.stringify(value)]);
  return (
    <>
      <textarea className="input mono" rows={4} spellCheck={false} value={txt} onChange={e => setTxt(e.target.value)}
        onBlur={() => { if (!txt.trim()) { onChange(undefined); setBad(false); return; } try { onChange(JSON.parse(txt)); setBad(false); } catch { setBad(true); } }} />
      {bad && <small className="help" style={{ color: 'var(--err)' }}>JSON no válido</small>}
    </>
  );
}

export function Switch({ on, onClick }) {
  return <button type="button" className={`switch ${on ? 'on' : ''}`} onClick={onClick} aria-pressed={!!on}><span /></button>;
}

function Control({ field: f, value, onChange, error, name }) {
  const set = v => onChange(f.key, v);
  const cls = `input ${error ? 'is-warn' : ''}`;
  switch (f.type) {
    case 'longtext': return <textarea className={cls} rows={4} value={value ?? ''} onChange={e => set(e.target.value)} />;
    case 'option': {
      const opts = f.options || [];
      if (opts.length && opts.length <= 4) return (
        <div className="seg rp-seg">{opts.map(o => <label key={o} className="seg-opt"><input type="radio" name={name} checked={value === o} onChange={() => set(o)} />{o}</label>)}</div>
      );
      return <select className={cls} value={value ?? ''} onChange={e => set(e.target.value)}><option value="">— elegir —</option>{opts.map(o => <option key={o} value={o}>{o}</option>)}</select>;
    }
    case 'list': return <ListControl value={value} onChange={set} />;
    case 'file': return <ListControl value={value} onChange={set} file />;
    case 'object': return <ObjectControl value={value} onChange={set} />;
    case 'number': return <input className={`${cls} mono`} inputMode="decimal" value={value ?? ''} onChange={e => set(coerce(f, e.target.value))} />;
    default: return <input className={cls} type={f.type === 'email' ? 'email' : 'text'} value={value ?? ''} onChange={e => set(e.target.value)} />;
  }
}

function FieldRow({ field: f, value, onChange, error, idp }) {
  if (f.type === 'boolean') return (
    <div className="rp-bool">
      <div><span className="rp-key">{f.key}{f.required && <span className="rp-req">*</span>}</span>{f.help && <small className="help">{f.help}</small>}</div>
      <Switch on={!!value} onClick={() => onChange(f.key, !value)} />
    </div>
  );
  return (
    <div className="field rp-field">
      <label><span className="rp-key">{f.key}</span>{f.required && <span className="rp-req">*</span>}<span className="rp-type mono">{TYPE_HINT[f.type] || f.type}</span></label>
      <Control field={f} value={value} onChange={onChange} error={error} name={`${idp}-${f.key}`} />
      {error ? <small className="help rp-err">{error}</small> : f.help ? <small className="help">{f.help}</small> : null}
    </div>
  );
}

// ── Editor JSON con resaltado (textarea sobre un <pre>) ───────────────────────
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function highlight(src) {
  return esc(src).replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, (m, str, colon, kw) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    return `<span class="j-lit">${m}</span>`;
  });
}
function JsonEditor({ values, onValues, fields }) {
  const [text, setText] = useState(() => JSON.stringify(values, null, 2));
  const [parseErr, setParseErr] = useState('');
  const focused = useRef(false);
  const pre = useRef(null), gut = useRef(null);
  useEffect(() => { if (!focused.current) { setText(JSON.stringify(values, null, 2)); setParseErr(''); } }, [JSON.stringify(values)]);
  const change = t => {
    setText(t);
    try {
      const v = JSON.parse(t);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Debe ser un objeto { … }');
      setParseErr(''); onValues(v);
    } catch (e) { setParseErr(e.message); }
  };
  const errs = parseErr ? [] : validateInput(fields, values);
  const lines = text.split('\n').length;
  return (
    <div className="rp-json">
      <div className="rp-json-status">
        {parseErr ? <><i className="ph-fill ph-x-circle" style={{ color: 'var(--err)' }} /><span>{parseErr}</span></>
          : errs.length ? <><i className="ph-fill ph-warning" style={{ color: 'var(--warn)' }} /><span>{errs.map(e => `${e.key}: ${e.message}`).join(' · ')}</span></>
          : <><i className="ph-fill ph-check-circle" style={{ color: 'var(--ok)' }} /><span>Válido según los campos de entrada</span></>}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost btn-xs-text" disabled={!!parseErr} onClick={() => setText(JSON.stringify(JSON.parse(text), null, 2))}><i className="ph ph-magic-wand" />Formatear</button>
      </div>
      <div className="rp-json-box">
        <div className="rp-json-gutter mono" ref={gut}>{Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}</div>
        <div className="rp-json-area">
          <pre ref={pre} className="mono" aria-hidden="true" dangerouslySetInnerHTML={{ __html: highlight(text) + '\n' }} />
          <textarea className="mono" spellCheck={false} value={text} onChange={e => change(e.target.value)}
            onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; }}
            onScroll={e => { pre.current.scrollTop = e.target.scrollTop; pre.current.scrollLeft = e.target.scrollLeft; gut.current.scrollTop = e.target.scrollTop; }}
            onKeyDown={e => { if (e.key === 'Tab') { e.preventDefault(); const t = e.target, a = t.selectionStart; change(text.slice(0, a) + '  ' + text.slice(t.selectionEnd)); requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2)); } }} />
        </div>
      </div>
      <small className="help">Mismos datos que el formulario: lo que cambies aquí se refleja allí.</small>
    </div>
  );
}

// ── Resultado esperado de un caso ────────────────────────────────────────────
function Expectations({ kase, graph, onSave }) {
  const [adding, setAdding] = useState(null);
  const nodes = graph.nodes.filter(n => !TRIGGERS.includes(n.type));
  const list = kase.expect || [];
  const save = () => {
    const x = adding;
    if (!x.node) return;
    let value = x.value;
    try { value = JSON.parse(x.value); } catch {}
    onSave({ expect: [...list, x.type === 'visits' ? { type: 'visits', node: x.node } : { type: 'equals', node: x.node, path: x.path.trim(), value }] });
    setAdding(null);
  };
  return (
    <div className="rp-expect">
      <span className="rp-expect-title"><i className="ph ph-target" />Resultado esperado <span className="muted">· opcional</span></span>
      <div className="rp-expect-chips">
        {list.map((x, i) => (
          <span key={i} className="tag tag-accent rp-chip">{expectText(x)}
            <button type="button" onClick={() => onSave({ expect: list.filter((_, j) => j !== i) })} title="Quitar"><i className="ph ph-x" /></button>
          </span>
        ))}
        {!adding && <button type="button" className="btn btn-ghost btn-xs-text" onClick={() => setAdding({ type: 'visits', node: nodes[0]?.name || '', path: '', value: '' })}><i className="ph ph-plus" />Añadir</button>}
      </div>
      {adding && (
        <div className="rp-expect-form">
          <select className="input" value={adding.type} onChange={e => setAdding(a => ({ ...a, type: e.target.value }))}>
            <option value="visits">Pasa por el nodo</option><option value="equals">Un valor de salida es</option>
          </select>
          <select className="input" value={adding.node} onChange={e => setAdding(a => ({ ...a, node: e.target.value }))}>
            {nodes.map(n => <option key={n.id} value={n.name}>{n.name}</option>)}
          </select>
          {adding.type === 'equals' && <>
            <input className="input mono" placeholder="campo (p. ej. prioridad)" value={adding.path} onChange={e => setAdding(a => ({ ...a, path: e.target.value }))} />
            <input className="input mono" placeholder='valor (p. ej. "alta")' value={adding.value} onChange={e => setAdding(a => ({ ...a, value: e.target.value }))} />
          </>}
          <div className="row">
            <button type="button" className="btn btn-ghost btn-xs-text" onClick={() => setAdding(null)}>Cancelar</button>
            <button type="button" className="btn btn-primary btn-xs-text" onClick={save} disabled={!adding.node || (adding.type === 'equals' && !adding.path.trim())}>Añadir</button>
          </div>
        </div>
      )}
      <label className="check rp-must-fail">
        <input type="checkbox" checked={!!kase.expectError} onChange={e => onSave({ expectError: e.target.checked })} />
        <span>Debe fallar</span>
      </label>
    </div>
  );
}

// ── Selector de conjuntos (popover) ──────────────────────────────────────────
function DatasetPicker({ datasets, active, onPick, onClose, onAction }) {
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [mode, setMode] = useState(null); // 'new' | 'rename' | 'import'
  const [txt, setTxt] = useState('');
  const ref = useRef(null);
  const list = datasets.filter(d => !q || d.name.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    setTimeout(() => document.addEventListener('mousedown', h), 0);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const key = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(list.length - 1, h + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
    if (e.key === 'Enter' && list[hi]) { e.preventDefault(); onPick(list[hi].id); }
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
  };
  const readFile = e => { const f = e.target.files?.[0]; if (f) f.text().then(setTxt); e.target.value = ''; };
  const sub = d => d.kind === 'capture' ? `${pluralCasos(d.cases.length)} · se llena al escuchar el webhook` : `${pluralCasos(d.cases.length)}${d.lastBatch ? ` · ${ago(d.lastBatch.startedAt)}` : ''}`;
  return (
    <div className="rp-pop elev-lg" ref={ref} onKeyDown={key}>
      <div className="rp-pop-search"><i className="ph ph-magnifying-glass" /><input className="input" autoFocus placeholder="Buscar conjunto…" value={q} onChange={e => { setQ(e.target.value); setHi(0); }} /></div>
      <div className="rp-pop-list">
        {list.map((d, i) => {
          const lb = d.lastBatch;
          return (
            <button type="button" key={d.id} className={`rp-pop-row ${d.id === active?.id ? 'on' : ''} ${i === hi ? 'hi' : ''}`} onClick={() => onPick(d.id)} onMouseEnter={() => setHi(i)}>
              {d.id === active?.id ? <i className="ph ph-check" /> : <span className="rp-pop-sp" />}
              <span className="rp-pop-txt"><b>{d.name}{d.kind === 'capture' && <i className="ph ph-webhooks-logo" />}</b><small>{sub(d)}</small></span>
              <span className={`rp-pop-score ${!lb || lb.status === 'running' ? '' : lb.failed ? 'err' : 'ok'}`}>{lb && lb.status !== 'running' ? `${lb.passed}/${lb.total}` : '—'}</span>
            </button>
          );
        })}
        {!list.length && <span className="rp-pop-empty">{datasets.length ? 'Ningún conjunto coincide.' : 'Aún no hay conjuntos.'}</span>}
      </div>
      {mode ? (
        <div className="rp-pop-form">
          {mode === 'import' ? (
            <>
              <textarea className="input mono" rows={6} autoFocus spellCheck={false} value={txt} onChange={e => setTxt(e.target.value)} placeholder={'_name;email;asunto\nTicket urgente;marta@acme.io;No puedo exportar\n\n…o un array JSON [{ … }]'} />
              <small className="help">Una fila = un caso. Columnas especiales: <span className="mono">_name</span> y <span className="mono">_expect_error</span>. Las listas se separan con «|».</small>
              <label className="btn btn-ghost btn-xs-text rp-file"><i className="ph ph-upload-simple" />Elegir fichero…<input type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={readFile} /></label>
            </>
          ) : (
            <input className="input" autoFocus value={txt} placeholder="Nombre del conjunto" onChange={e => setTxt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && txt.trim()) { onAction(mode, txt); setMode(null); } }} />
          )}
          <div className="row">
            <button type="button" className="btn btn-ghost btn-xs-text" onClick={() => setMode(null)}>Cancelar</button>
            <button type="button" className="btn btn-primary btn-xs-text" disabled={!txt.trim()} onClick={() => { onAction(mode, txt); setMode(null); }}>{mode === 'import' ? 'Importar' : mode === 'new' ? 'Crear' : 'Renombrar'}</button>
          </div>
        </div>
      ) : (
        <div className="rp-pop-actions">
          <button type="button" onClick={() => { setTxt(''); setMode('new'); }}><i className="ph ph-plus" />Nuevo conjunto</button>
          {active && <button type="button" onClick={() => onAction('duplicate')}><i className="ph ph-copy" />Duplicar «{active.name}»</button>}
          {active && <button type="button" onClick={() => { setTxt(''); setMode('import'); }}><i className="ph ph-upload-simple" /><span style={{ flex: 1 }}>Importar CSV o JSON…</span><small>una fila = un caso</small></button>}
          {active && <button type="button" onClick={() => { setTxt(active.name); setMode('rename'); }}><i className="ph ph-pencil-simple" />Renombrar</button>}
          {active && <button type="button" className="danger" onClick={() => onAction('delete')}><i className="ph ph-trash" />Eliminar «{active.name}»</button>}
        </div>
      )}
    </div>
  );
}

// ── Resultado de un lote ─────────────────────────────────────────────────────
function BatchView({ batch, ds, onBack, onRunAgain, onRetryFailed, onOpenCase }) {
  const [open, setOpen] = useState(null);
  const r = batch.results;
  const passed = r.filter(x => x.pass === true).length, failed = r.filter(x => x.pass === false).length;
  const runningNow = batch.status === 'running';
  return (
    <>
      <div className="rp-batch-head">
        <div className="row"><span className="rp-batch-name">{ds?.name || 'Conjunto'}</span><span className="mono muted">{dur(batch.startedAt, batch.finishedAt)}</span></div>
        <div className="rp-bar">{r.map((x, i) => <span key={i} className={x.pass === true ? 'ok' : x.pass === false ? 'err' : ''} />)}</div>
        <span className="rp-batch-sum">{runningNow ? `${passed + failed} de ${r.length} terminados` : `${passed} correcto${passed === 1 ? '' : 's'}${failed ? ` · ${failed} distinto${failed === 1 ? '' : 's'} de lo esperado` : ''}`}</span>
      </div>
      <div className="panel-scroll rp-scroll">
        <button type="button" className="link-btn rp-back" onClick={onBack}><i className="ph ph-arrow-left" /> Volver a los casos</button>
        {r.map((x, i) => {
          const bad = x.pass === false;
          return (
            <div key={x.caseId} className={`rp-res ${bad ? 'bad' : ''}`}>
              <div className="rp-res-row" onClick={() => bad && setOpen(open === i ? null : i)}>
                {x.pass === true ? <i className="ph-fill ph-check-circle" style={{ color: 'var(--ok)' }} />
                  : bad ? <i className="ph-fill ph-x-circle" style={{ color: 'var(--err)' }} />
                  : x.status === 'running' ? <i className="ph ph-circle-notch spin" style={{ color: 'var(--color-accent)' }} />
                  : <i className="ph ph-circle" style={{ color: 'var(--color-neutral-600)' }} />}
                <span className="rp-res-name">{x.name}</span>
                {x.runId && <a className="mono muted" href={`#/runs/${x.runId}`} onClick={e => e.stopPropagation()}>{x.runId}</a>}
              </div>
              {bad && (open === i || r.filter(y => y.pass === false).length === 1) && (
                <>
                  <div className="rp-diff">
                    {x.diffs.map((d, k) => <Fragment key={k}><span>esperado</span><span className="mono">{d.expected}</span><span>obtenido</span><span className="mono rp-got">{d.got}</span></Fragment>)}
                  </div>
                  <div className="row rp-res-actions">
                    {x.runId && <a className="btn btn-ghost btn-xs-text" href={`#/runs/${x.runId}`}>Ver ejecución</a>}
                    <button type="button" className="btn btn-ghost btn-xs-text" onClick={() => onOpenCase(x.caseId)}>Abrir caso</button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="rp-foot">
        <button type="button" className="btn btn-ghost btn-sm" disabled={runningNow || !failed} onClick={onRetryFailed}><i className="ph ph-arrow-counter-clockwise" />Repetir fallidos</button>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-primary btn-sm" disabled={runningNow} onClick={onRunAgain}><i className="ph ph-stack" />Ejecutar de nuevo</button>
      </div>
    </>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────
export default function RunPanel(p) {
  const { wf, graph, trigger, fields, analysis, data, reload, activeDs, selCase, values, setValues, dirty, running, runWarn, onRun, onClose, onDeclare, onSelectNode, setActiveDsId, setSelCaseId, subscribe, onError } = p;
  const [tab, setTab] = useState('form');
  const [picker, setPicker] = useState(false);
  const [batch, setBatch] = useState(null);
  const [newCase, setNewCase] = useState(null); // nombre del caso nuevo
  const [busy, setBusy] = useState('');
  const [fillKey, setFillKey] = useState(null); // valor por defecto para un campo que falta
  const [commonOpen, setCommonOpen] = useState(true);
  const [now, setNow] = useState(Date.now());
  const datasets = data?.datasets || [];
  const listening = data?.listening;
  const byId = useMemo(() => Object.fromEntries(graph.nodes.map(n => [n.id, n])), [graph.nodes]);
  const fieldErrs = Object.fromEntries((runWarn?.errors || []).map(e => [e.key, e.message]));
  const call = async (label, fn) => { setBusy(label); try { return await fn(); } catch (e) { onError(e.message); } finally { setBusy(''); } };

  useEffect(() => subscribe(m => {
    if (m.type === 'batch' && m.workflowId === wf.id) setBatch(b => (b && b.id === m.batch.id ? m.batch : b));
    if (m.type === 'capture' && m.workflowId === wf.id) setTab('form');
  }), [wf.id, subscribe]);
  useEffect(() => { if (!listening) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [listening]);
  useEffect(() => {
    const key = e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setTab('cases'); setPicker(true); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const setVal = (k, v) => setValues({ ...values, [k]: v });
  const ensureDataset = async () => activeDs || (await api(`/workflows/${wf.id}/datasets`, { method: 'POST', body: { name: 'Por defecto' } }));
  const saveCase = () => call('save', async () => {
    const { values: vals, removed } = diffFromCommon(activeDs.common, values);
    await api(`/cases/${selCase.id}`, { method: 'PUT', body: { values: vals, removed } });
    await reload();
  });
  const createCase = name => call('save', async () => {
    const ds = await ensureDataset();
    const { values: vals, removed } = diffFromCommon(ds.common, values);
    const c = await api(`/datasets/${ds.id}/cases`, { method: 'POST', body: { name, values: vals, removed } });
    setActiveDsId(ds.id); setSelCaseId(c.id); setNewCase(null);
    await reload();
  });
  const patchCase = (id, body) => call('case', async () => { await api(`/cases/${id}`, { method: 'PUT', body }); await reload(); });
  const removeCase = id => call('case', async () => { await api(`/cases/${id}`, { method: 'DELETE' }); if (selCase?.id === id) setSelCaseId(null); await reload(); });
  const commonTimer = useRef(null);
  const [commonDraft, setCommonDraft] = useState(null);
  useEffect(() => { setCommonDraft(null); }, [activeDs?.id]);
  const common = commonDraft ?? activeDs?.common ?? {};
  const setCommon = (k, v) => {
    const next = { ...common, [k]: v };
    if (isEmpty(v)) delete next[k];
    setCommonDraft(next);
    clearTimeout(commonTimer.current);
    commonTimer.current = setTimeout(() => api(`/datasets/${activeDs.id}`, { method: 'PUT', body: { common: next } }).then(reload, e => onError(e.message)), 500);
  };
  const runBatch = caseIds => call('batch', async () => {
    const b = await api(`/datasets/${activeDs.id}/run`, { method: 'POST', body: caseIds ? { caseIds } : {} });
    setBatch(b);
  });
  const generate = mode => call(`ia-${mode}`, async () => { await api(`/datasets/${activeDs.id}/generate`, { method: 'POST', body: { mode, count: 3 } }); await reload(); });
  const listen = () => call('listen', () => api(`/workflows/${wf.id}/listen`, { method: listening ? 'DELETE' : 'POST' }).then(reload));
  const dsAction = (what, txt) => call('ds', async () => {
    if (what === 'new') { const d = await api(`/workflows/${wf.id}/datasets`, { method: 'POST', body: { name: txt } }); setActiveDsId(d.id); setSelCaseId(null); }
    if (what === 'duplicate') { const d = await api(`/datasets/${activeDs.id}/duplicate`, { method: 'POST' }); setActiveDsId(d.id); setSelCaseId(null); }
    if (what === 'rename') await api(`/datasets/${activeDs.id}`, { method: 'PUT', body: { name: txt } });
    if (what === 'import') await api(`/datasets/${activeDs.id}/import`, { method: 'POST', body: { text: txt } });
    if (what === 'delete') { if (window.confirm && !window.confirm(`¿Eliminar el conjunto «${activeDs.name}» y sus ${pluralCasos(activeDs.cases.length)}?`)) return; await api(`/datasets/${activeDs.id}`, { method: 'DELETE' }); setActiveDsId(null); setSelCaseId(null); }
    setPicker(false);
    await reload();
  });

  const cases = activeDs?.cases || [];
  const incomplete = cases.filter(c => c.missing?.length);
  const missingKeys = [...new Set(incomplete.flatMap(c => c.missing))];
  const pending = analysis?.undeclared || [];
  const usedBy = u => (u.nodes.length === 1 ? `lo usa «${byId[u.nodes[0]]?.name}»` : `lo usan ${u.nodes.length} nodos`);
  const dynamic = (analysis?.dynamic || []).filter(d => byId[d.nodeId]);
  const subtitle = activeDs && selCase ? `${activeDs.name} · ${selCase.name}`
    : trigger ? `Entrada de «${trigger.name}»${trigger.type === 'webhook' ? ` · ${trigger.params?.method || 'POST'} ${trigger.params?.path || ''}` : ''}` : 'Sin disparador';
  const left = listening ? Math.max(0, Math.round((listening.until - now) / 1000)) : 0;
  const hookUrl = trigger?.type === 'webhook' ? `${location.origin}/hooks/${String(trigger.params?.path || '').replace(/^\/+/, '')}` : '';
  const sampleBody = JSON.stringify(Object.fromEntries(fields.slice(0, 3).map(f => [f.key, '…'])));

  const RunButton = (
    <button type="button" className={`btn btn-primary btn-sm rp-run ${runWarn ? 'dim' : ''}`} disabled={running || !trigger} onClick={() => onRun()} title="Ctrl + Enter"><i className="ph ph-play" />Ejecutar</button>
  );
  const ListenButton = trigger?.type === 'webhook' && (
    <button type="button" className="btn btn-ghost btn-sm" onClick={listen} disabled={busy === 'listen'}><i className="ph ph-broadcast" />{listening ? 'Dejar de escuchar' : 'Escuchar webhook'}</button>
  );

  return (
    <aside className="side panel run-panel">
      <div className="panel-head">
        <div className="panel-title">
          <div className="rp-icon"><i className="ph ph-play" /></div>
          <div className="rp-title"><b>Ejecutar workflow</b><span>{subtitle}</span></div>
          <button className="btn btn-icon btn-xs" onClick={onClose} title="Cerrar (Esc)"><i className="ph ph-x" /></button>
        </div>
        <div className="tabs">
          <button className={tab === 'form' ? 'on' : ''} onClick={() => setTab('form')}><i className="ph ph-list-bullets" />Formulario</button>
          <button className={tab === 'json' ? 'on' : ''} onClick={() => setTab('json')}><i className="ph ph-brackets-curly" />JSON</button>
          <button className={tab === 'cases' ? 'on' : ''} onClick={() => setTab('cases')}><i className="ph ph-flask" />Casos
            {incomplete.length ? <span className="rp-dot-warn" /> : <span className="rp-count">{cases.length}</span>}
          </button>
        </div>
      </div>

      {listening && tab !== 'cases' && (
        <div className="rp-listen">
          <span className="rp-listen-title"><span className="rp-listen-dot" />Escuchando {trigger?.params?.method || 'POST'} {trigger?.params?.path}…</span>
          <span>La próxima llamada real lanzará el workflow y se guardará como caso. Caduca en {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.</span>
          <code className="mono">curl -X {trigger?.params?.method || 'POST'} {hookUrl} -H 'content-type: application/json' -d '{sampleBody}'</code>
        </div>
      )}

      {tab === 'cases' && batch ? (
        <BatchView batch={batch} ds={datasets.find(d => d.id === batch.datasetId)} onBack={() => setBatch(null)}
          onRunAgain={() => runBatch(batch.results.map(r => r.caseId))}
          onRetryFailed={() => runBatch(batch.results.filter(r => r.pass === false).map(r => r.caseId))}
          onOpenCase={id => { setActiveDsId(batch.datasetId); setSelCaseId(id); setBatch(null); setTab('form'); }} />
      ) : (
        <>
          <div className="panel-scroll rp-scroll">
            {!trigger && <div className="llm-box warn"><i className="ph ph-warning" /><div><b>El workflow no tiene disparador</b><span>Añade un Webhook, Cron o Evento para poder ejecutarlo.</span></div></div>}

            {tab === 'form' && trigger && (
              <>
                <div className="rp-case-row">
                  <select className="input" value={newCase != null ? '__new' : selCase?.id || ''} onChange={e => {
                    if (e.target.value === '__new') { setNewCase(''); return; }
                    setNewCase(null); setSelCaseId(e.target.value || null);
                  }}>
                    {!cases.length && <option value="">Sin casos guardados</option>}
                    {cases.map(c => <option key={c.id} value={c.id}>{c.name}{c.missing?.length ? ' · incompleto' : ''}</option>)}
                    <option value="__new">＋ Guardar como caso nuevo…</option>
                  </select>
                  {selCase?.missing?.length > 0 && <span className="rp-incomplete">incompleto</span>}
                  <button type="button" className="btn btn-icon rp-save" disabled={!selCase || !dirty || busy === 'save'} onClick={saveCase} title={dirty ? 'Guardar cambios en el caso' : 'Sin cambios'}><i className="ph ph-floppy-disk" /></button>
                </div>
                {newCase != null && (
                  <div className="rp-new-case">
                    <input className="input" autoFocus placeholder="Nombre del caso" value={newCase} onChange={e => setNewCase(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newCase.trim()) createCase(newCase.trim()); if (e.key === 'Escape') setNewCase(null); }} />
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setNewCase(null)}>Cancelar</button>
                    <button type="button" className="btn btn-primary btn-sm" disabled={!newCase.trim()} onClick={() => createCase(newCase.trim())}>Guardar</button>
                  </div>
                )}
                {activeDs && <small className="help rp-ds-hint">Conjunto «{activeDs.name}». Cámbialo en Casos (Ctrl + K).{selCase?.lastRunId && <> Última ejecución {ago(selCase.updatedAt)} · <a href={`#/runs/${selCase.lastRunId}`}>{selCase.lastRunId}</a></>}</small>}

                {pending.map(u => <NewFieldBlock key={u.path} u={u} usedBy={usedBy(u)} value={values[u.key]} onValue={v => setVal(u.key, v)} onDeclare={f => onDeclare(f)} trigger={trigger} />)}

                {!fields.length && !pending.length && (
                  <div className="llm-box"><i className="ph ph-info" /><div><b>Sin campos de entrada</b><span>Decláralos en el disparador («{trigger.name}» → Campos de entrada) para tener un formulario. Mientras, usa la pestaña JSON.</span></div></div>
                )}
                {fields.map(f => <FieldRow key={f.key} field={f} value={values[f.key]} onChange={setVal} error={fieldErrs[f.key]} idp={wf.id} />)}

                {dynamic.map(d => (
                  <div key={d.nodeId} className="rp-dynamic"><i className="ph ph-eye-slash" /><span>«{byId[d.nodeId].name}» lee la entrada sin campo concreto</span><button type="button" className="link-btn" onClick={() => onSelectNode(d.nodeId)}>Ver nodo</button></div>
                ))}

                {selCase && <Expectations kase={selCase} graph={graph} onSave={b => patchCase(selCase.id, b)} />}
              </>
            )}

            {tab === 'json' && trigger && <JsonEditor values={values} onValues={setValues} fields={fields} />}

            {tab === 'cases' && trigger && (
              <>
                <div className="rp-ds-wrap">
                  <button type="button" className={`rp-ds ${picker ? 'open' : ''}`} onClick={() => setPicker(o => !o)} title="Ctrl + K">
                    <i className="ph ph-stack" />
                    <span className="rp-ds-txt"><small>Conjunto</small><b>{activeDs?.name || 'Ninguno'}</b></span>
                    <span className="rp-ds-n">{pluralCasos(cases.length)}</span>
                    <i className={`ph ${picker ? 'ph-caret-up' : 'ph-caret-up-down'}`} />
                  </button>
                  {picker && <DatasetPicker datasets={datasets} active={activeDs} onClose={() => setPicker(false)} onAction={dsAction}
                    onPick={id => { setActiveDsId(id); setSelCaseId(null); setPicker(false); }} />}
                </div>

                {!activeDs && <p className="muted">Crea un conjunto para guardar casos de prueba.</p>}

                {activeDs && fields.length > 0 && (
                  <div className="rp-common">
                    <button type="button" className="rp-common-head" onClick={() => setCommonOpen(o => !o)}>
                      <i className={`ph ${commonOpen ? 'ph-caret-down' : 'ph-caret-right'}`} /><b>Valores comunes</b><span>heredan los {pluralCasos(cases.length)}</span>
                    </button>
                    {commonOpen && (
                      <div className="rp-common-body">
                        {fields.map(f => (
                          <Fragment key={f.key}>
                            <span className="mono">{f.key}</span>
                            {f.type === 'boolean'
                              ? <div className="rp-common-bool"><Switch on={!!common[f.key]} onClick={() => setCommon(f.key, !common[f.key])} /><span>{common[f.key] === undefined ? '—' : common[f.key] ? 'Sí' : 'No'}</span></div>
                              : <Control field={f} value={common[f.key]} onChange={setCommon} name={`common-${activeDs.id}-${f.key}`} />}
                          </Fragment>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeDs && incomplete.length > 0 && (
                  <div className="rp-banner warn">
                    <b>A {incomplete.length} de {pluralCasos(cases.length)} les falta {missingKeys.map((k, i) => <Fragment key={k}>{i ? ', ' : ''}<span className="mono">{k}</span></Fragment>)}</b>
                    {fillKey ? (
                      <div className="rp-fill">
                        <span className="mono">{fillKey.key}</span>
                        <input className="input" autoFocus value={fillKey.value} onChange={e => setFillKey(f => ({ ...f, value: e.target.value }))} placeholder="Valor por defecto" />
                        <button type="button" className="btn btn-ghost btn-xs-text" onClick={() => setFillKey(null)}>Cancelar</button>
                        <button type="button" className="btn btn-primary btn-xs-text" disabled={!fillKey.value.trim()} onClick={() => { setCommon(fillKey.key, coerce(fields.find(f => f.key === fillKey.key), fillKey.value)); setFillKey(null); }}>Guardar</button>
                      </div>
                    ) : (
                      <div className="row">
                        <button type="button" className="btn btn-secondary btn-xs-text" disabled={!data?.llmReady || busy === 'ia-fill'} title={data?.llmReady ? '' : 'Necesita un worker con capacidad llm'} onClick={() => generate('fill')}><i className="ph ph-sparkle" />{busy === 'ia-fill' ? 'Completando…' : 'Completar con IA'}</button>
                        <button type="button" className="btn btn-ghost btn-xs-text" onClick={() => setFillKey({ key: missingKeys[0], value: '' })}>Usar un valor por defecto…</button>
                      </div>
                    )}
                  </div>
                )}

                {activeDs && (
                  <div className="rp-cases">
                    {cases.map(c => {
                      const on = c.id === selCase?.id;
                      const state = c.lastPass === true ? 'ok' : c.lastPass === false ? 'err' : c.lastStatus ? (c.lastStatus === 'success' ? 'ok' : 'err') : 'none';
                      return (
                        <div key={c.id} className={`rp-case ${on ? 'on' : ''}`} onClick={() => { setSelCaseId(c.id); setTab('form'); }}>
                          <span className={`rp-case-dot ${state}`} />
                          <span className="rp-case-txt"><b>{c.name}</b>
                            <small className={c.missing?.length ? 'warn' : ''}>{c.missing?.length ? `Falta ${c.missing.join(', ')}` : c.expectError && !Object.keys(c.values).length && !c.removed.length ? 'Debe fallar en validación · no afecta' : caseSummary(fields, activeDs, c)}</small>
                          </span>
                          {c.missing?.length
                            ? <button type="button" className="btn btn-ghost btn-xs-text" onClick={e => { e.stopPropagation(); setSelCaseId(c.id); setTab('form'); }}>Rellenar</button>
                            : <button type="button" className="btn btn-icon btn-xs" title="Ejecutar este caso" disabled={running} onClick={e => { e.stopPropagation(); setSelCaseId(c.id); onRun({ caseId: c.id, saved: true }); }}><i className="ph ph-play" /></button>}
                          <button type="button" className="btn btn-icon btn-xs rp-case-del" title="Eliminar caso" onClick={e => { e.stopPropagation(); removeCase(c.id); }}><i className="ph ph-trash" /></button>
                        </div>
                      );
                    })}
                    <div className="rp-case-actions">
                      <button type="button" className="btn btn-ghost btn-xs-text" onClick={() => call('case', async () => { const c = await api(`/datasets/${activeDs.id}/cases`, { method: 'POST', body: {} }); setSelCaseId(c.id); await reload(); setTab('form'); })}><i className="ph ph-plus" />Añadir caso a este conjunto</button>
                      <button type="button" className="btn btn-ghost btn-xs-text" disabled={!data?.llmReady || !fields.length || busy === 'ia-new'} title={!data?.llmReady ? 'Necesita un worker con capacidad llm' : !fields.length ? 'Declara antes los campos de entrada' : ''} onClick={() => generate('new')}><i className="ph ph-sparkle" />{busy === 'ia-new' ? 'Generando…' : 'Generar casos con IA'}</button>
                    </div>
                  </div>
                )}
              </>
            )}

            {runWarn && tab !== 'cases' && (
              <div className="rp-banner warn">
                <span className="rp-warn-txt"><i className="ph-fill ph-warning" /><span>{runWarn.errors.slice(0, 3).map((e, i) => {
                  const users = (analysis?.used || []).find(u => u.key === e.key)?.nodes.map(id => byId[id]?.name).filter(Boolean) || [];
                  return <Fragment key={e.key}>{i ? ' ' : ''}<b>{e.key}</b> {e.message === 'Obligatorio' ? 'está vacío.' : `: ${e.message}.`}{users[0] && e.message === 'Obligatorio' ? <> «{users[0]}» recibirá <span className="mono">null</span> y probablemente falle.</> : null}</Fragment>;
                })}</span></span>
                <div className="row end">
                  <button type="button" className="btn btn-ghost btn-xs-text" onClick={() => onRun({ force: true })}>Ejecutar igualmente</button>
                  <button type="button" className="btn btn-primary btn-xs-text" onClick={() => { setTab('form'); requestAnimationFrame(() => document.querySelector('.run-panel .is-warn')?.focus()); }}>Rellenar campo</button>
                </div>
              </div>
            )}
          </div>

          <div className="rp-foot">
            {tab === 'cases' ? (
              <>
                <button type="button" className="btn btn-ghost btn-sm" disabled={!selCase || running} onClick={() => onRun({ caseId: selCase.id, saved: true })}><i className="ph ph-play" />Solo este caso</button>
                <div style={{ flex: 1 }} />
                <button type="button" className="btn btn-primary btn-sm" disabled={!cases.length || busy === 'batch'} onClick={() => runBatch()}><i className="ph ph-stack" />Ejecutar conjunto ({cases.length})</button>
              </>
            ) : (
              <>
                {ListenButton}
                <div style={{ flex: 1 }} />
                {RunButton}
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

// Bloque «campo nuevo» (2a): una ruta que usa algún nodo y no está declarada
function NewFieldBlock({ u, usedBy, value, onValue, onDeclare, trigger }) {
  const [type, setType] = useState(/email/i.test(u.key) ? 'email' : 'text');
  const [req, setReq] = useState(true);
  const f = { ...newField(trigger, u.key, type), path: u.path, required: req };
  return (
    <div className="rp-newfield">
      <div className="rp-newfield-head"><span className="mono">{u.key}</span><span className="rp-new-tag">nuevo</span><span className="rp-newfield-by">{usedBy}</span></div>
      <Control field={f} value={value} onChange={(_, v) => onValue(v)} name={`new-${u.key}`} />
      <div className="rp-newfield-row">
        <span>Se tratará como</span>
        <select className="input" value={type} onChange={e => setType(e.target.value)}>{FIELD_TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select>
        <label><input type="checkbox" checked={req} onChange={e => setReq(e.target.checked)} />obligatorio</label>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-primary btn-xs-text" onClick={() => onDeclare(f)}>Declarar campo</button>
      </div>
    </div>
  );
}
