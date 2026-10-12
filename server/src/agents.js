import { Agents, Workflows } from './db.js';

// Agentes personalizados: un nodo Agente con params.agentId toma de aquí proveedor, modelo,
// instrucciones, formato, herramientas (y si se aprueban), turnos, temperatura, tokens y simulación. El nodo solo
// aporta la entrada y, opcionalmente, instrucciones adicionales (params.extraPrompt).

export const AGENT_KEYS = ['provider', 'model', 'prompt', 'output', 'schema', 'tools', 'approveTools', 'maxTurns', 'temperature', 'maxTokens', 'mockOutput', 'mockTools'];
const OUTPUTS = ['Texto', 'JSON'];
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function clean(body) {
  const name = String(body?.name ?? '').trim();
  if (!name) throw bad('El nombre es obligatorio');
  if (name.length > 80) throw bad('El nombre es demasiado largo (máx. 80 caracteres)');
  const c = body.config || {};
  const config = Object.fromEntries(AGENT_KEYS.map(k => [k, c[k] == null ? '' : String(c[k])]));
  config.output = OUTPUTS.includes(config.output) ? config.output : 'Texto';
  config.tools = config.tools.split(',').map(s => s.trim()).filter(Boolean).join(', ');
  config.approveTools = config.approveTools === 'No' ? 'No' : 'Sí';
  if (config.schema.trim()) {
    let s;
    try { s = JSON.parse(config.schema); } catch (e) { throw bad(`El esquema JSON no es JSON válido: ${e.message}`); }
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw bad('El esquema JSON debe ser un objeto (p. ej. { "type": "object", "properties": { … } })');
  }
  if (config.maxTurns.trim()) {
    const n = Number(config.maxTurns);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw bad('Máx. turnos debe ser un entero entre 1 y 100');
  }
  if (config.temperature.trim()) {
    const t = Number(config.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) throw bad('La temperatura debe estar entre 0 y 2');
  }
  if (config.maxTokens.trim()) {
    const m = Number(config.maxTokens);
    if (!Number.isInteger(m) || m < 1) throw bad('Máx. tokens debe ser un entero positivo');
  }
  return { name, description: String(body.description ?? '').trim(), config };
}

function dupCheck(name, id) {
  const other = Agents.findByName(name);
  if (other && other.id !== id) throw bad(`Ya existe un agente llamado «${name}»`, 409);
}

// Nodos que usan cada agente: { agentId: [{ workflowId, workflowName, node }] }
function usage() {
  const out = {};
  for (const w of Workflows.list()) {
    for (const n of w.graph?.nodes || []) {
      if (n.type === 'agent' && n.params?.agentId) (out[n.params.agentId] ||= []).push({ workflowId: w.id, workflowName: w.name, node: n.name });
    }
  }
  return out;
}

export function listAgents() {
  const used = usage();
  return Agents.list().map(a => ({ ...a, usedIn: used[a.id] || [] }));
}

export const getAgent = id => Agents.get(id);

export function createAgent(body) {
  const v = clean(body);
  dupCheck(v.name);
  return Agents.create(v);
}

export function updateAgent(id, body) {
  const cur = Agents.get(id);
  if (!cur) return null;
  const v = clean({ ...cur, ...body, config: { ...cur.config, ...(body.config || {}) } });
  dupCheck(v.name, id);
  return Agents.update(id, v);
}

export const deleteAgent = id => Agents.remove(id);

// Para los ejemplos: usa el agente con ese nombre si ya existe, si no lo crea
export const ensureAgent = def => Agents.findByName(def.name) || createAgent(def);

// Parámetros efectivos de un nodo Agente. Sin agentId, los del propio nodo.
export function applyAgent(params = {}) {
  const { agentId, extraPrompt, ...rest } = params;
  if (!agentId) return { params: rest, agent: null };
  const agent = Agents.get(agentId);
  if (!agent) throw Object.assign(new Error(`El agente personalizado «${agentId}» ya no existe: elige otro en el nodo`), { retryable: false });
  const extra = String(extraPrompt || '').trim();
  const prompt = [agent.config.prompt, extra].filter(Boolean).join('\n\n');
  return { params: { ...rest, ...agent.config, prompt }, agent };
}
