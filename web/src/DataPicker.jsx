import { useEffect, useState } from 'react';
import { api } from './api.js';
import { TYPES, TRIGGERS } from './nodeTypes.js';

// Qué datos llegan a un nodo, antes de ejecutarlo. Para cada nodo anterior se usa su salida real (última
// ejecución) o, si aún no se ha ejecutado, una estimación según su tipo. Las estimaciones describen el
// campo («texto del fichero») en vez de un valor real.

let agentsCache = null;
function useAgents() {
  const [agents, setAgents] = useState(agentsCache || {});
  useEffect(() => {
    if (agentsCache) return;
    api('/agents').then(l => { agentsCache = Object.fromEntries(l.map(a => [a.id, a])); setAgents(agentsCache); }).catch(() => {});
  }, []);
  return agents;
}

const parseJson = s => { try { return s && s.trim() ? JSON.parse(s) : {}; } catch { return null; } };

// Salida estimada de un nodo según su tipo (null = no se puede saber sin ejecutarlo)
function estimate(n, x, seen) {
  const p = n.params || {};
  const before = () => incoming(n.id, x, seen)?.value;
  switch (n.type) {
    case 'webhook': case 'event': return { value: parseJson(x.testInput) ?? {}, note: x.testLabel || 'según el caso de prueba activo' };
    case 'cron': return { value: { disparado: 'fecha y hora de la ejecución' } };
    case 'agent': {
      const c = p.agentId ? x.agents[p.agentId]?.config || {} : p;
      if (c.output !== 'JSON') return { value: { text: 'respuesta del agente' } };
      const props = (() => { try { return JSON.parse(c.schema)?.properties; } catch { return null; } })();
      return props
        ? { value: Object.fromEntries(Object.entries(props).map(([k, s]) => [k, s?.description || s?.type || 'valor'])), note: 'según su esquema JSON' }
        : { value: null, note: 'JSON: sus campos dependen de las instrucciones del agente (o define un esquema)' };
    }
    case 'file': return { value: p.action === 'Escribir' ? { ruta: 'ruta del fichero', bytes: 'tamaño escrito', modo: 'Sobrescribir / Añadir' } : { ruta: 'ruta completa', nombre: 'nombre del fichero', contenido: 'texto del fichero', bytes: 'tamaño', modificado: 'fecha' } };
    case 'http': return { value: { status: 'código HTTP', headers: 'cabeceras', body: 'respuesta de la API' } };
    case 'db': return { value: { rows: 'filas (lista)', rowCount: 'nº de filas' } };
    case 'command': return { value: { comando: 'comando', carpeta: 'carpeta', codigo: 'código de salida', ok: 'true si terminó bien', salida: 'final de la salida', duracionMs: 'duración' } };
    case 'email': return { value: { enviado: 'true si se envió', messageId: 'id del mensaje' } };
    case 'node': return { value: null, note: 'lo que devuelva su return' };
    case 'subflow': return { value: null, note: 'la salida del workflow invocado' };
    case 'loop': return { value: { items: 'resultados de cada vuelta (lista)', total: 'nº de elementos' } };
    case 'approval': return { value: { ...(before() || {}), aprobacion: { por: 'quién aprobó', comentario: 'comentario', fecha: 'fecha' } } };
    case 'parallel': if (String(p.mode).startsWith('Unir')) return { value: { entradas: 'salida de cada rama (lista)' } };
    // fallthrough: Dividir, Condición y Esperar dejan pasar lo que reciben
    case 'if': case 'wait': return { value: before() ?? null, note: 'deja pasar lo que recibe' };
    default: return { value: null };
  }
}

// Salida de un nodo: la real si se ha ejecutado, si no la estimada
function outputOf(n, x, seen = new Set()) {
  if (seen.has(n.id)) return { value: null };
  seen.add(n.id);
  const st = x.steps[n.id];
  if (st && st.status === 'success' && st.output !== undefined) return { value: st.output, real: true };
  return estimate(n, x, seen);
}

// Lo que recibe un nodo como $json (su conexión de entrada)
function incoming(id, x, seen = new Set()) {
  const ins = x.graph.edges.filter(e => e.to === id);
  if (!ins.length) return null;
  const e = ins[0], from = x.byId[e.from];
  if (!from) return null;
  if (from.type === 'loop' && e.port === 'item') return { value: { item: 'elemento de la lista', index: 'posición (0, 1, …)' }, from, many: ins.length > 1, note: 'cada vuelta del bucle' };
  return { ...outputOf(from, x, seen), from, many: ins.length > 1 };
}

// Nodos anteriores (por distancia: los más cercanos primero)
function ancestors(id, x) {
  const out = [], seen = new Set([id]);
  for (let level = [id]; level.length;) {
    const next = [];
    for (const nid of level) for (const e of x.graph.edges) if (e.to === nid && !seen.has(e.from) && x.byId[e.from]) { seen.add(e.from); next.push(e.from); out.push(x.byId[e.from]); }
    level = next;
  }
  return out;
}

const ID = /^[A-Za-z_$][\w$]*$/;
const pathExpr = (base, path) => base + path.map(k => (ID.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)).join('');
const preview = (v, real) => (v == null ? String(v) : typeof v === 'string' ? (real ? `"${v.slice(0, 50)}${v.length > 50 ? '…' : ''}"` : v) : Array.isArray(v) ? `lista (${v.length})` : typeof v === 'object' ? 'objeto' : String(v));

// Campos de un valor: primer nivel y, dentro de objetos, un nivel más (body.repo…). Las cabeceras HTTP
// no se despliegan: son muchas y casi nunca se usan
const FLAT = ['headers'];
function fields(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  const out = [];
  for (const [k, val] of Object.entries(v)) {
    out.push({ path: [k], value: val });
    if (val && typeof val === 'object' && !Array.isArray(val) && !FLAT.includes(k)) for (const [k2, v2] of Object.entries(val).slice(0, 12)) out.push({ path: [k, k2], value: v2 });
  }
  return out.slice(0, 40);
}

const MAIN = ['text', 'contenido', 'texto', 'content'];

function Chips({ value, real, base, onPick, auto }) {
  const list = fields(value);
  if (!list.length) return null;
  return (
    <div className="chips">
      {list.map(f => {
        const expr = pathExpr(base, f.path);
        return (
          <button key={f.path.join('.')} type="button" className={`chip ${f.path.length > 1 ? 'sub' : ''} ${auto === f.path[0] && f.path.length === 1 ? 'on' : ''}`} title={`Insertar {{ ${expr} }}`} onClick={() => onPick(expr)}>
            <span className="mono">{f.path.join('.')}</span><small>{preview(f.value, real)}</small>
          </button>
        );
      })}
    </div>
  );
}

const source = o => (o.real ? 'última ejecución' : o.value == null ? 'sin datos aún' : 'estimado');

// Aviso bajo un campo automático: qué usará si se deja vacío
export function AutoHint({ node, graph, steps, testInput, value }) {
  const agents = useAgents();
  if (value) return null;
  const x = { graph, steps, testInput, agents, byId: Object.fromEntries(graph.nodes.map(n => [n.id, n])) };
  const inc = incoming(node.id, x);
  if (!inc) return <small className="help">Conecta un nodo a la entrada para que este reciba sus datos.</small>;
  const v = inc.value;
  const k = v && typeof v === 'object' && !Array.isArray(v) ? MAIN.find(f => f in v) : null;
  return (
    <small className="help auto-hint">
      <i className="ph ph-arrow-bend-down-right" />Vacío = automático: usará {k ? <>el campo <span className="mono">{k}</span></> : typeof v === 'string' ? 'el texto' : 'toda la salida, como JSON'} de <b>{inc.from.name}</b>.
    </small>
  );
}

// «Datos disponibles»: lo que recibe el nodo ($json) y lo de los nodos anteriores ($node["…"])
export function DataPicker({ node, graph, steps, testInput, testLabel, onPick, onRunUntil }) {
  const agents = useAgents();
  const [open, setOpen] = useState(true);
  if (TRIGGERS.includes(node.type)) return null;
  const x = { graph, steps, testInput, testLabel, agents, byId: Object.fromEntries(graph.nodes.map(n => [n.id, n])) };
  const inc = incoming(node.id, x);
  const others = ancestors(node.id, x).filter(n => n.id !== inc?.from?.id);
  const missing = [inc, ...others.map(n => outputOf(n, x))].some(o => o && !o.real);

  return (
    <div className="data-picker">
      <button type="button" className="data-picker-head" onClick={() => setOpen(o => !o)}>
        <i className={`ph ${open ? 'ph-caret-down' : 'ph-caret-right'}`} /><span className="eyebrow">Datos disponibles</span>
        <span className="rule" />
      </button>
      {open && (!inc ? <small className="help">Conecta un nodo a la entrada para ver qué datos recibe este.</small> : (
        <>
          <div className="dp-block">
            <div className="dp-title">
              <span>Recibe de <b>{inc.from.name}</b> <span className="mono muted">$json</span></span>
              <small className={inc.real ? 'ok' : 'muted'}>{inc.note && !inc.real ? inc.note : source(inc)}</small>
            </div>
            {inc.value == null || typeof inc.value !== 'object'
              ? <small className="help">{inc.note || (typeof inc.value === 'string' ? 'Un texto.' : 'Aún no se sabe qué campos tendrá.')} Ejecuta hasta aquí para ver los datos reales.</small>
              : <Chips value={inc.value} real={inc.real} base="$json" onPick={onPick} />}
            {inc.many && <small className="help">Tiene varias entradas: $json es la de la rama que llega.</small>}
          </div>
          {others.map(n => {
            const o = outputOf(n, x);
            const t = TYPES[n.type];
            return (
              <details key={n.id} className="dp-block">
                <summary className="dp-title">
                  <span><i className={`ph ${t?.icon}`} /> {n.name} <span className="mono muted">$node["{n.name}"]</span></span>
                  <small className={o.real ? 'ok' : 'muted'}>{source(o)}</small>
                </summary>
                {o.value && typeof o.value === 'object' ? <Chips value={o.value} real={o.real} base={`$node[${JSON.stringify(n.name)}]`} onPick={onPick} /> : <small className="help">{o.note || 'Aún no se sabe qué campos tendrá.'}</small>}
              </details>
            );
          })}
          <small className="help">Haz clic en un campo para insertarlo donde tengas el cursor (o se copia).</small>
          {missing && onRunUntil && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onRunUntil(inc.from.id)} title={`Ejecuta el flujo solo hasta «${inc.from.name}» (lo anterior a este nodo) con el caso de prueba activo`}>
              <i className="ph ph-play" />Obtener datos reales (ejecutar hasta «{inc.from.name}»)
            </button>
          )}
        </>
      ))}
    </div>
  );
}
