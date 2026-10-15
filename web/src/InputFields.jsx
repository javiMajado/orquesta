import { useState } from 'react';
import { FIELD_TYPES, TYPE_LABEL, rootOf, pathFor, newField, inferFields } from '@orquesta/shared/inputs';

// Pestaña «Campos de entrada» del panel de un disparador: qué datos necesita el workflow.
// Generan el formulario del panel de ejecución y la validación de llamadas reales.
export default function InputFields({ node, onNode, analysis, byId }) {
  const fields = node.params.inputFields || [];
  const [open, setOpen] = useState(null);
  const [drag, setDrag] = useState(null);
  const [infer, setInfer] = useState(null); // texto JSON pegado
  const [inferErr, setInferErr] = useState('');
  const setFields = list => onNode({ params: { ...node.params, inputFields: list } });
  const setField = (i, patch) => setFields(fields.map((f, j) => {
    if (j !== i) return f;
    const n = { ...f, ...patch };
    // La ruta sigue a la clave mientras no se haya cambiado a mano
    if (patch.key !== undefined && f.path === pathFor(node, f.key)) n.path = pathFor(node, patch.key);
    return n;
  }));
  const pending = (analysis?.undeclared || []);
  const ignore = paths => onNode({ params: { ...node.params, ignoredInputs: [...new Set([...(node.params.ignoredInputs || []), ...paths])] } });
  const addAll = () => setFields([...fields, ...pending.map(u => newField(node, u.key))]);
  const add = () => {
    let k = 'campo', i = 1;
    while (fields.some(f => f.key === k)) k = `campo${++i}`;
    setFields([...fields, { ...newField(node, k), required: false }]);
    setOpen(fields.length);
  };
  const proposeFromJson = () => {
    try {
      const sample = JSON.parse(infer);
      const found = inferFields(node, sample).filter(f => !fields.some(x => x.key === f.key));
      if (!found.length) { setInferErr('No hay campos nuevos en ese JSON.'); return; }
      setFields([...fields, ...found]);
      setInfer(null); setInferErr('');
    } catch (e) { setInferErr(`JSON no válido: ${e.message}`); }
  };
  const move = (from, to) => {
    if (from === to || from == null) return;
    const l = [...fields];
    const [x] = l.splice(from, 1);
    l.splice(to, 0, x);
    setFields(l);
  };

  return (
    <>
      {pending.length > 0 && (
        <div className="if-suggest">
          <span className="if-suggest-title"><i className="ph ph-magic-wand" />{pending.length} campo{pending.length === 1 ? '' : 's'} detectado{pending.length === 1 ? '' : 's'} en nodos siguientes</span>
          <span className="if-suggest-list mono">
            {pending.map(u => <span key={u.path}>$json.{u.path} <span className="muted">· {u.nodes.map(id => byId[id]?.name).filter(Boolean).join(', ')}</span></span>)}
          </span>
          <div className="row">
            <button type="button" className="btn btn-primary btn-xs-text" onClick={addAll}>Añadir {pending.length === 1 ? 'el campo' : `los ${pending.length}`}</button>
            <button type="button" className="btn btn-ghost btn-xs-text" onClick={() => ignore(pending.map(u => u.path))}>Ignorar</button>
          </div>
        </div>
      )}

      <div className="if-table">
        <div className="if-row if-head"><span /><span>Campo</span><span>Tipo</span><span title="Obligatorio">*</span></div>
        {!fields.length && <div className="if-empty">Sin campos. El formulario de ejecución estará vacío hasta que añadas alguno.</div>}
        {fields.map((f, i) => (
          <div key={i} className={`if-item ${open === i ? 'open' : ''} ${drag === i ? 'dragging' : ''}`}
            onDragOver={e => { if (drag != null) e.preventDefault(); }} onDrop={() => { move(drag, i); setDrag(null); }}>
            <div className="if-row" onClick={() => setOpen(open === i ? null : i)}>
              <i className="ph ph-dots-six-vertical if-grip" draggable onDragStart={e => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDrag(null)} onClick={e => e.stopPropagation()} />
              <span className="mono if-key">{f.key}</span>
              <span className="if-type">{TYPE_LABEL[f.type] || f.type}</span>
              <button type="button" className="if-req" title={f.required ? 'Obligatorio' : 'Opcional'} onClick={e => { e.stopPropagation(); setField(i, { required: !f.required }); }}>
                <i className={f.required ? 'ph-fill ph-check-square' : 'ph ph-square'} />
              </button>
            </div>
            {open === i && (
              <div className="if-detail">
                <div className="field"><label>Clave</label><input className="input mono" value={f.key} onChange={e => setField(i, { key: e.target.value.replace(/\s+/g, '_') })} /></div>
                <div className="field">
                  <label>Tipo</label>
                  <select className="input" value={f.type} onChange={e => setField(i, { type: e.target.value })}>{FIELD_TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select>
                </div>
                <div className="field"><label>Ruta en la entrada</label><input className="input mono" value={f.path} onChange={e => setField(i, { path: e.target.value })} /></div>
                <div className="field"><label>Por defecto</label><input className="input" value={f.default == null ? '' : typeof f.default === 'object' ? JSON.stringify(f.default) : String(f.default)} placeholder="—" onChange={e => setField(i, { default: e.target.value === '' ? undefined : e.target.value })} /></div>
                <div className="field wide"><label>Ayuda</label><input className="input" value={f.help || ''} onChange={e => setField(i, { help: e.target.value })} /></div>
                {f.type === 'option' && (
                  <div className="field wide"><label>Opciones</label><input className="input" value={(f.options || []).join(', ')} placeholder="Web, Email, Chat" onChange={e => setField(i, { options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} /><small className="help">Separadas por comas.</small></div>
                )}
                <div className="wide if-detail-actions">
                  <button type="button" className="btn btn-ghost btn-xs-text" onClick={() => { setFields(fields.filter((_, j) => j !== i)); setOpen(null); }}><i className="ph ph-trash" />Quitar campo</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="if-actions">
        <button type="button" className="btn btn-ghost btn-xs-text" onClick={add}><i className="ph ph-plus" />Añadir campo</button>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost btn-xs-text" onClick={() => { setInfer(infer == null ? '' : null); setInferErr(''); }}><i className="ph ph-brackets-curly" />Inferir de un JSON</button>
      </div>
      {infer != null && (
        <div className="field">
          <textarea className="input mono" rows={6} spellCheck={false} autoFocus value={infer} onChange={e => setInfer(e.target.value)} placeholder={rootOf(node) ? `{ "${rootOf(node)}": { "email": "…" } }  o  { "email": "…" }` : '{ "email": "…" }'} />
          {inferErr && <small className="help" style={{ color: 'var(--err)' }}>{inferErr}</small>}
          <div className="row" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setInfer(null)}>Cancelar</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={proposeFromJson} disabled={!infer.trim()}>Proponer campos</button>
          </div>
        </div>
      )}

      {node.type === 'webhook' && (
        <label className="check">
          <input type="checkbox" checked={!!node.params.validateInput} onChange={e => onNode({ params: { ...node.params, validateInput: e.target.checked } })} />
          <span><b>Validar llamadas reales</b><small className="help">El webhook responde 400 si falta un campo obligatorio o el tipo no coincide.</small></span>
        </label>
      )}
    </>
  );
}
