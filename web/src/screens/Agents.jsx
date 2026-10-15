import { useEffect, useState } from 'react';
import { api, ago } from '../api.js';
import { DEF, FIELDS } from '../nodeTypes.js';
import { LlmFields, Field, AgentCard } from '../NodePanel.jsx';

// Configuración que guarda un agente (la entrada la pone cada nodo)
const { input, repo, agentId, extraPrompt, overrideProvider, overrideModel, ...AGENT_DEF } = DEF.agent;
export const EMPTY_AGENT = { name: '', description: '', config: AGENT_DEF };
const AGENT_FIELDS = FIELDS.agent.filter(f => f[0] !== 'input');

function Form({ initial, workers, onSaved, onCancel }) {
  const editing = !!initial.id;
  const [f, setF] = useState(() => ({ ...EMPTY_AGENT, ...initial, config: { ...AGENT_DEF, ...(initial.config || {}) } }));
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const setC = (k, v) => setF(x => ({ ...x, config: { ...x.config, [k]: v } }));

  const save = async () => {
    setBusy(true); setMsg('');
    try {
      const body = { name: f.name, description: f.description, config: f.config };
      await api(editing ? `/agents/${f.id}` : '/agents', { method: editing ? 'PUT' : 'POST', body });
      onSaved();
    } catch (e) { setMsg(e.message); setBusy(false); }
  };

  return (
    <div className="card elev-sm conn-form">
      <div className="card-title" style={{ fontSize: 15 }}>{editing ? `Editar «${initial.name}»` : 'Nuevo agente'}</div>
      <div className="grid2">
        <div className="field"><label>Nombre</label><input className="input" value={f.name} onChange={e => setF(x => ({ ...x, name: e.target.value }))} placeholder="p. ej. Clasificador de tickets" autoFocus /></div>
        <div className="field"><label>Descripción</label><input className="input" value={f.description} onChange={e => setF(x => ({ ...x, description: e.target.value }))} placeholder="Para qué sirve" /></div>
      </div>
      <LlmFields node={{ id: `agent-${f.id || 'nuevo'}`, params: f.config }} setParam={setC} workers={workers} />
      {AGENT_FIELDS.filter(fl => fl[0] !== 'schema' || f.config.output === 'JSON').map(fl => <Field key={fl[0]} f={fl} value={f.config[fl[0]]} onChange={setC} />)}
      {editing && initial.usedIn?.length > 0 && (
        <small className="help">Los cambios se aplican a los {initial.usedIn.length} nodos que lo usan en la próxima ejecución.</small>
      )}
      {msg && <div className="banner-err">{msg}</div>}
      <div className="row" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-secondary btn-sm" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}><i className="ph ph-floppy-disk" />Guardar</button>
      </div>
    </div>
  );
}

const usedText = u => [...new Set(u.map(x => x.workflowName))].join('\n');

// id de la ruta: #/agents/<id> abre ese agente · #/agents/nuevo abre el formulario vacío
export default function Agents({ id, workers }) {
  const [list, setList] = useState(null);
  const [llm, setLlm] = useState(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(id === 'nuevo' ? EMPTY_AGENT : null);
  const load = () => api('/agents').then(l => { setList(l); return l; }).catch(e => setErr(e.message));
  useEffect(() => {
    load().then(l => { if (id && id !== 'nuevo') { const a = l?.find(x => x.id === id); a ? setForm(a) : setErr('Ese agente ya no existe'); } });
    api('/llm').then(setLlm).catch(() => {});
  }, []);

  const close = () => { setForm(null); if (id) location.hash = '#/agents'; };
  const remove = async a => {
    const warn = a.usedIn.length ? `\n\nLo usan ${a.usedIn.length} nodos (${[...new Set(a.usedIn.map(x => x.workflowName))].join(', ')}); dejarán de funcionar.` : '';
    if (!confirm(`¿Eliminar el agente «${a.name}»?${warn}`)) return;
    await api(`/agents/${a.id}`, { method: 'DELETE' }).catch(e => setErr(e.message));
    load();
  };

  return (
    <main className="page">
      <div className="page-inner">
        <div className="page-head">
          <div><h3>Agentes</h3><span className="sub">Agentes IA reutilizables: elígelos en cualquier nodo «Agente IA».</span></div>
          {!form && <button className="btn btn-primary" onClick={() => setForm(EMPTY_AGENT)}><i className="ph ph-plus" />Nuevo agente</button>}
        </div>
        {err && <div className="banner-err">{err}</div>}
        {form && <Form key={form.id || 'nuevo'} initial={form} workers={workers} onCancel={close} onSaved={() => { close(); load(); }} />}

        <div className="agent-grid">
          {(list || []).map(a => (
            <AgentCard key={a.id} agent={a} llm={llm}
              actions={<>
                <button className="btn btn-icon btn-xs" title="Editar" onClick={() => { setForm(a); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><i className="ph ph-pencil-simple" /></button>
                <button className="btn btn-icon btn-xs" title="Duplicar" onClick={() => setForm({ name: `${a.name} (copia)`, description: a.description, config: a.config })}><i className="ph ph-copy" /></button>
                <button className="btn btn-icon btn-xs" title="Eliminar" onClick={() => remove(a)}><i className="ph ph-trash" /></button>
              </>}
              footer={<>
                <span title={usedText(a.usedIn)}><i className="ph ph-flow-arrow" />{a.usedIn.length ? `Usado en ${a.usedIn.length} nodo${a.usedIn.length > 1 ? 's' : ''} · ${[...new Set(a.usedIn.map(u => u.workflowName))].join(', ')}` : 'Sin usar en ningún workflow'}</span>
                <span className="muted">modificado {ago(a.updatedAt)}</span>
              </>} />
          ))}
        </div>
        {list && !list.length && !form && <p className="muted">Aún no hay agentes. Crea uno con «Nuevo agente» o, desde un nodo Agente ya configurado, pulsa «Guardar como agente».</p>}
      </div>
    </main>
  );
}
