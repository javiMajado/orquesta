// Campos de entrada de un workflow: qué datos necesita su disparador, de dónde salen y cómo se validan.
// Lo usan el editor (formulario de ejecución, avisos en el lienzo) y el servidor (casos de prueba,
// validación de webhooks). Sin dependencias: corre igual en Node y en el navegador.

export const TRIGGER_TYPES = ['webhook', 'cron', 'event'];
// Nodos que reenvían su entrada sin cambiarla: tras ellos, $json sigue siendo la del disparador
const PASS = ['if', 'wait', 'approval'];
// Campos que, vacíos, reciben TODA la salida del nodo anterior (modo automático)
const AUTO = { agent: 'input', email: 'body', file: 'content' };
// Parámetros que no se analizan (respuestas simuladas)
const SKIP = ['mockOutput', 'mockTools'];

export const FIELD_TYPES = ['text', 'longtext', 'email', 'number', 'boolean', 'option', 'list', 'file', 'object'];
export const TYPE_LABEL = { text: 'Texto', longtext: 'Texto largo', email: 'Email', number: 'Número', boolean: 'Sí / No', option: 'Opción', list: 'Lista', file: 'Lista · archivo', object: 'Objeto' };
export const TYPE_HINT = { text: 'texto', longtext: 'texto largo', email: 'texto · email', number: 'número', boolean: 'sí / no', option: 'opción', list: 'lista', file: 'lista · archivo', object: 'objeto' };

// Prefijo de la salida del disparador donde van los datos: webhook → body, evento → payload, cron → raíz
export const rootOf = trigger => (trigger?.type === 'webhook' ? 'body' : trigger?.type === 'event' ? 'payload' : '');
export const pathFor = (trigger, key) => (rootOf(trigger) ? `${rootOf(trigger)}.${key}` : key);
export const triggerOf = graph => (graph?.nodes || []).find(n => TRIGGER_TYPES.includes(n.type)) || null;
export const fieldsOf = trigger => (Array.isArray(trigger?.params?.inputFields) ? trigger.params.inputFields : []);

const isEmpty = v => v == null || v === '' || (Array.isArray(v) && !v.length);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID = '[A-Za-z_$][\\w$]*';
const STR = `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'`;
const SEG = `\\s*\\??\\.\\s*${ID}|\\s*(?:\\?\\.)?\\[\\s*(?:${STR})\\s*\\]`;

function segments(chain) {
  const out = [];
  const re = new RegExp(`\\??\\.\\s*(${ID})|\\[\\s*(${STR})\\s*\\]`, 'g');
  for (let m; (m = re.exec(chain));) out.push(m[1] ?? m[2].slice(1, -1).replace(/\\(.)/g, '$1'));
  return out;
}

// Accesos a una base ($json o $node["X"]) dentro de un texto: [{ path: [..] } | { dynamic: 'motivo' }]
function accesses(text, base) {
  const re = new RegExp(`${base}(?![\\w$])((?:${SEG})*)(\\s*(?:\\?\\.)?\\[)?`, 'g');
  const out = [];
  for (let m; (m = re.exec(text));) {
    const segs = segments(m[1] || '');
    if (segs.length) out.push({ path: segs });
    else out.push({ dynamic: m[2] ? 'acceso calculado' : 'lo leen sin campo concreto' });
  }
  return out;
}

const strings = (v, out = []) => {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object') Object.values(v).forEach(x => strings(x, out));
  return out;
};
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ¿El $json del nodo id es la salida del disparador? Solo si todos sus padres son el disparador o nodos de paso
// (Condición, Esperar, Aprobación, Paralelo en modo Dividir) que a su vez lo cumplen.
function makePassthrough(graph, trigger) {
  const byId = Object.fromEntries(graph.nodes.map(n => [n.id, n]));
  const memo = new Map();
  const pass = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return false;
    seen.add(id);
    const parents = graph.edges.filter(e => e.to === id).map(e => ({ e, n: byId[e.from] })).filter(x => x.n);
    const ok = parents.length > 0 && parents.every(({ e, n }) => n.id === trigger.id
      || ((PASS.includes(n.type) || (n.type === 'parallel' && !String(n.params?.mode || '').startsWith('Unir'))) && e.port !== 'item' && pass(n.id, seen)));
    memo.set(id, ok);
    return ok;
  };
  return pass;
}

// Qué campos de la entrada del disparador usa el workflow.
// opts.agents: { [agentId]: config } para analizar también las instrucciones de agentes guardados.
// Devuelve { used: [{ path, key, nodes }], dynamic: [{ nodeId, reason }], undeclared: [...used no declarados ni ignorados] }
export function analyzeInputs(graph, triggerId, opts = {}) {
  const g = { nodes: [], edges: [], ...(graph || {}) };
  const trigger = g.nodes.find(n => n.id === triggerId) || triggerOf(g);
  const res = { used: [], dynamic: [], undeclared: [] };
  if (!trigger) return res;
  const root = rootOf(trigger);
  const pass = makePassthrough(g, trigger);
  const used = new Map();
  const add = (segs, nodeId) => {
    let s = segs;
    if (root) { if (s[0] !== root || s.length < 2) return; s = s.slice(1); }
    else if (s[0] === 'disparado') return;
    const key = s[0], path = root ? `${root}.${key}` : key;
    const u = used.get(path) || { path, key, nodes: [] };
    if (!u.nodes.includes(nodeId)) u.nodes.push(nodeId);
    used.set(path, u);
  };
  const dyn = (nodeId, reason) => { if (!res.dynamic.some(d => d.nodeId === nodeId)) res.dynamic.push({ nodeId, reason }); };
  const nodeRe = `\\$node\\s*\\[\\s*(?:"${escapeRe(trigger.name)}"|'${escapeRe(trigger.name)}')\\s*\\]`;

  for (const n of g.nodes) {
    if (n.id === trigger.id) continue;
    let params = Object.fromEntries(Object.entries(n.params || {}).filter(([k]) => !SKIP.includes(k)));
    if (n.type === 'agent' && n.params?.agentId && opts.agents?.[n.params.agentId]) {
      const c = opts.agents[n.params.agentId];
      params = { ...params, _agentPrompt: c.prompt || '', _agentSchema: c.schema || '' };
    }
    const texts = strings(params);
    const direct = pass(n.id);
    for (const t of texts) {
      for (const a of accesses(t, nodeRe)) a.path ? add(a.path, n.id) : dyn(n.id, a.dynamic);
      if (direct) for (const a of accesses(t, '\\$json')) a.path ? add(a.path, n.id) : dyn(n.id, a.dynamic);
    }
    const auto = AUTO[n.type];
    if (direct && auto && (n.type !== 'file' || n.params?.action === 'Escribir') && isEmpty(n.params?.[auto])) dyn(n.id, 'lo leen sin campo concreto');
  }
  res.used = [...used.values()];
  const declared = new Set(fieldsOf(trigger).map(f => f.path));
  const ignored = new Set(trigger.params?.ignoredInputs || []);
  res.undeclared = res.used.filter(u => !declared.has(u.path) && !ignored.has(u.path));
  return res;
}

// Valores efectivos de un caso: comunes del conjunto + los propios, sin los que el caso quita
export function effectiveValues(dataset, kase) {
  const v = { ...(dataset?.common || {}), ...(kase?.values || {}) };
  for (const k of kase?.removed || []) delete v[k];
  return v;
}

const get = (obj, path) => String(path).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
const set = (obj, path, val) => {
  const ks = String(path).split('.').filter(Boolean);
  let o = obj;
  ks.slice(0, -1).forEach(k => { if (!o[k] || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {}; o = o[k]; });
  if (ks.length) o[ks[ks.length - 1]] = val;
  return obj;
};
export { get as getPath };

// Entrada real del disparador a partir de los valores planos de un caso
export function buildTriggerInput(trigger, fields, values) {
  const base = trigger?.type === 'webhook' ? { body: {}, query: {}, headers: {}, method: trigger.params?.method || 'POST' }
    : trigger?.type === 'event' ? { topic: trigger.params?.topic || '', payload: {} }
    : { disparado: new Date().toISOString() };
  for (const [k, v] of Object.entries(values || {})) {
    if (v === undefined) continue;
    const f = fields.find(x => x.key === k);
    set(base, f?.path || pathFor(trigger, k), v);
  }
  return base;
}

// Valores planos a partir de una entrada real (webhook capturado, ejecución del historial)
export function valuesFromInput(trigger, fields, input) {
  const out = {};
  const root = rootOf(trigger);
  const src = root ? input?.[root] : input;
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const [k, v] of Object.entries(src)) if (!(root === '' && k === 'disparado')) out[k] = v;
  }
  for (const f of fields) { const v = get(input, f.path); if (v !== undefined) out[f.key] = v; }
  return out;
}

const guessType = (k, v) => typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : Array.isArray(v) ? 'list'
  : v && typeof v === 'object' ? 'object' : (/email/i.test(k) || EMAIL.test(String(v ?? ''))) ? 'email'
  : String(v ?? '').length > 80 || String(v ?? '').includes('\n') ? 'longtext' : 'text';

export function newField(trigger, key, type) {
  return { key, path: pathFor(trigger, key), type: type || (/email/i.test(key) ? 'email' : 'text'), required: true, default: undefined, help: '' };
}

// Campos propuestos a partir de un JSON de ejemplo (plano o con la forma de la entrada del disparador)
export function inferFields(trigger, sample) {
  const root = rootOf(trigger);
  const src = root && sample && typeof sample === 'object' && sample[root] && typeof sample[root] === 'object' ? sample[root] : sample;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return [];
  return Object.entries(src).filter(([k]) => k !== 'disparado').map(([k, v]) => ({ key: k, path: pathFor(trigger, k), type: guessType(k, v), required: false, help: '' }));
}

// Antiguo graph.settings.testInput → valores planos
export function flattenTestInput(trigger, parsed) {
  const root = rootOf(trigger);
  if (root && parsed && typeof parsed === 'object' && parsed[root] && typeof parsed[root] === 'object' && !Array.isArray(parsed[root])) return { ...parsed[root] };
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const { disparado, ...rest } = parsed;
    return rest;
  }
  return {};
}

// Errores de validación: [{ key, message }]
export function validateInput(fields, values) {
  const errs = [];
  for (const f of fields || []) {
    const v = values?.[f.key];
    if (isEmpty(v)) { if (f.required) errs.push({ key: f.key, message: 'Obligatorio' }); continue; }
    if (f.type === 'email' && !EMAIL.test(String(v))) errs.push({ key: f.key, message: 'No es un email válido' });
    else if (f.type === 'number' && !(typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))))) errs.push({ key: f.key, message: 'Debe ser un número' });
    else if (f.type === 'option' && f.options?.length && !f.options.includes(v)) errs.push({ key: f.key, message: 'Valor no permitido' });
    else if ((f.type === 'list' || f.type === 'file') && !Array.isArray(v)) errs.push({ key: f.key, message: 'Debe ser una lista' });
    else if (f.type === 'object' && (typeof v !== 'object' || Array.isArray(v))) errs.push({ key: f.key, message: 'Debe ser un objeto' });
  }
  return errs;
}

// Obligatorios que le faltan a un caso (los que quita a propósito no cuentan)
export function missingRequired(fields, dataset, kase) {
  if (kase?.expectError) return [];
  const v = effectiveValues(dataset, kase);
  return (fields || []).filter(f => f.required && isEmpty(v[f.key]) && !(kase?.removed || []).includes(f.key)).map(f => f.key);
}

const show = v => (v === true ? 'Sí' : v === false ? 'No' : typeof v === 'object' ? JSON.stringify(v) : String(v));
// «cambia: asunto, mensaje» · «cambia: cliente_vip → Sí» · «quita: email · debe fallar»
export function caseSummary(fields, dataset, kase) {
  const common = dataset?.common || {};
  const changed = Object.keys(kase?.values || {}).filter(k => JSON.stringify(kase.values[k]) !== JSON.stringify(common[k]));
  const parts = [];
  if (changed.length === 1 && ['boolean', 'option'].includes(fields?.find(f => f.key === changed[0])?.type)) parts.push(`cambia: ${changed[0]} → ${show(kase.values[changed[0]])}`);
  else if (changed.length) parts.push(`cambia: ${changed.join(', ')}`);
  if (kase?.removed?.length) parts.push(`quita: ${kase.removed.join(', ')}`);
  if (!parts.length) parts.push('igual que los valores comunes');
  if (kase?.expectError) parts.push('debe fallar');
  return parts.join(' · ');
}

// Solo lo que difiere de los valores comunes (lo que se guarda en el caso)
export function diffFromCommon(common, values) {
  const out = {}, removed = [];
  for (const [k, v] of Object.entries(values || {})) {
    if (isEmpty(v) && !isEmpty(common?.[k])) { removed.push(k); continue; }
    if (JSON.stringify(v) !== JSON.stringify(common?.[k])) out[k] = v;
  }
  for (const k of Object.keys(common || {})) if (!(k in (values || {})) && !isEmpty(common[k])) removed.push(k);
  return { values: out, removed };
}

// Texto de una expectativa (chip)
export const expectText = x => (x.type === 'visits' ? `pasa por «${x.node}»` : `$node["${x.node}"].${x.path} = ${JSON.stringify(x.value)}`);

// Comprueba las expectativas de un caso contra los pasos de su ejecución
export function checkExpectations(kase, run, steps) {
  const diffs = [];
  const failed = run.status === 'error';
  if (kase.expectError) {
    if (!failed) diffs.push({ label: 'debe fallar', expected: 'error', got: run.status });
    return { pass: !diffs.length, diffs };
  }
  if (run.status !== 'success') diffs.push({ label: 'estado', expected: 'success', got: run.status + (run.error ? `: ${run.error}` : '') });
  for (const x of kase.expect || []) {
    const st = [...steps].reverse().find(s => s.nodeName === x.node || s.nodeId === x.node);
    if (x.type === 'visits') {
      if (!st || st.status !== 'success') diffs.push({ label: expectText(x), expected: `pasa por «${x.node}»`, got: st ? st.status : 'no se ejecutó' });
    } else {
      const got = st ? get(st.output, x.path) : undefined;
      const eq = JSON.stringify(got) === JSON.stringify(x.value) || (got != null && typeof got !== 'object' && String(got) === String(x.value));
      if (!eq) diffs.push({ label: `${x.node}.${x.path}`, expected: `${x.path} = ${JSON.stringify(x.value)}`, got: `${x.path} = ${got === undefined ? '—' : JSON.stringify(got)}` });
    }
  }
  return { pass: !diffs.length, diffs };
}

// CSV mínimo: comillas dobles, separador , o ; (el que más aparezca en la cabecera)
export function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const first = src.split(/\r?\n/)[0] || '';
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(x => x.trim() !== ''));
  if (!head) return [];
  return body.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

// Convierte un valor de texto (CSV, formulario) al tipo del campo
export function coerce(field, v) {
  if (v == null || !field) return v;
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (field.type === 'boolean') return ['true', 'sí', 'si', '1', 'yes', 'x'].includes(s.toLowerCase());
  if (field.type === 'number') return s === '' ? '' : isNaN(Number(s)) ? s : Number(s);
  if (field.type === 'list' || field.type === 'file') { if (!s) return []; try { const j = JSON.parse(s); if (Array.isArray(j)) return j; } catch {} return s.split('|').map(x => x.trim()).filter(Boolean); }
  if (field.type === 'object') { try { return JSON.parse(s); } catch { return s; } }
  return v;
}
