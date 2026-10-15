import Anthropic from '@anthropic-ai/sdk';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

// Cliente de chat común para todos los proveedores:
//   const chat = openChat(provider, opts); const r = await chat.next(); chat.pushResults([...])
//   chat.pushCorrection(textoAnterior, mensaje): pide al modelo que corrija su última respuesta
// r = { text, calls: [{ id, name, input }], usage: { input, output, cacheRead, cacheWrite }, stop, estimated? }
//   opcionales: chat.prewarm() escribe la caché del prefijo; chat.compact() recorta el historial

// Error de API con indicación de si merece la pena reintentar (4xx salvo 429, no).
export function apiError(status, msg) {
  const e = new Error(status ? `HTTP ${status}: ${msg}` : msg);
  e.status = status;
  e.retryable = !status || status === 408 || status === 429 || status >= 500;
  return e;
}
const clip = s => String(s || '').slice(0, 400);

// OpenCode Go (https://opencode.ai/docs/go#where-can-i-use-it): exige un x-opencode-session
// estable por conversación para enrutar y cachear, y pide que el cliente se identifique con su
// propio user-agent en vez del nombre genérico del SDK. El id de sesión es el del worker si lo hay.
const OPENCODE_SESSION = `orquesta-${process.env.WORKER_ID || crypto.randomUUID()}`;
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0';
const isOpencode = url => { try { return new URL(url).host.endsWith('opencode.ai'); } catch { return false; } };
const opencodeHeaders = url => (isOpencode(url) ? { 'x-opencode-session': OPENCODE_SESSION, 'user-agent': `orquesta/${VERSION}` } : {});

// Hay modelos que ya no aceptan `temperature` (p. ej. claude-haiku-5-5): si el servidor responde
// 400 «`temperature` is deprecated», se reintenta sin ella y se recuerda para el resto del proceso.
const noTemperature = new Set(); // «kind:model»
const isDeprecatedTemp = (status, msg) => status === 400 && /`temperature` is deprecated/i.test(String(msg || ''));

// ── Caché de prompts
// Modo por proveedor (pantalla Workers, llega como opts.promptCache): auto | on | off.
// ORQ_LLM_PROMPT_CACHE=off la apaga en todo el worker. «auto» = activada, pero si el proveedor (p. ej.
// un gateway) rechaza cache_control con un 400, se reintenta sin ella y se recuerda (como temperature).
// Anthropic: marcadores explícitos en la última herramienta, las dos últimas secciones del system
// (mapa del repo y prompt del agente) y el último mensaje (se mueve en cada turno): 4 como máximo.
// OpenAI cachea solo los prefijos repetidos: basta con que tools y system no cambien entre turnos.
export const cacheMode = mode => (String(process.env.ORQ_LLM_PROMPT_CACHE || '').toLowerCase() === 'off' ? 'off'
  : ['on', 'off'].includes(mode) ? mode : 'auto');
const noCache = new Set(); // URL base de proveedores que rechazaron cache_control
const noCtxEdit = new Set(); // … o la limpieza de contexto del servidor
const CC = { type: 'ephemeral' };
// system puede ser un texto o una lista de secciones (p. ej. [mapa del repo, instrucciones])
const sectionsOf = system => (Array.isArray(system) ? system : [system]).map(s => String(s || '')).filter(Boolean);

// Uso de tokens normalizado: input = sin caché, cacheRead = leído de caché, cacheWrite = escrito en caché
const anthropicUsage = u => ({ input: u?.input_tokens || 0, output: u?.output_tokens || 0, cacheRead: u?.cache_read_input_tokens || 0, cacheWrite: u?.cache_creation_input_tokens || 0 });

// Copia de los mensajes con el marcador de caché en el último bloque. El historial guardado no lleva
// marcadores: así cada turno solo mueve el marcador y el contenido de los turnos anteriores no cambia.
function markLast(msgs) {
  const last = msgs[msgs.length - 1];
  const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
  if (!blocks?.length) return msgs;
  return [...msgs.slice(0, -1), { ...last, content: [...blocks.slice(0, -1), { ...blocks[blocks.length - 1], cache_control: CC }] }];
}

function anthropicChat(p, { model, system, user, maxTokens, temperature, tools, signal, promptCache }) {
  const { baseUrl, key } = p.secret();
  // authToken: null evita que el SDK lea ANTHROPIC_AUTH_TOKEN del entorno por su cuenta.
  // maxRetries: 0 porque los reintentos los decide el orquestador (y así se ven y se cuentan).
  const client = new Anthropic({ apiKey: key, authToken: null, baseURL: baseUrl, maxRetries: 0 });
  const baseHeaders = opencodeHeaders(baseUrl);
  const noTempKey = `anthropic:${model}`;
  const sections = sectionsOf(system);
  const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }];
  const mode = cacheMode(promptCache);
  const caching = () => mode === 'on' || (mode === 'auto' && !noCache.has(baseUrl));
  // Limpieza de contexto en el servidor: retira resultados de herramientas antiguos cuando el historial
  // crece mucho. En el cliente no se puede: editar turnos anteriores invalida el razonamiento (400).
  const editing = () => tools.length > 0 && process.env.ORQ_LLM_CONTEXT_EDIT !== 'off' && !noCtxEdit.has(baseUrl);

  const request = (extra = {}, { edit = editing() } = {}) => {
    const cache = caching();
    const mark = o => (cache ? { ...o, cache_control: CC } : o);
    const defs = tools.map((t, i) => (i === tools.length - 1 ? mark(t.def) : t.def));
    const sys = !sections.length ? null
      : cache ? sections.map((text, i) => (i >= sections.length - 2 ? mark({ type: 'text', text }) : { type: 'text', text }))
      : sections.join('\n\n');
    return {
      body: {
        model, max_tokens: maxTokens, messages: cache ? markLast(messages) : messages,
        ...(sys ? { system: sys } : {}),
        ...(Number.isFinite(temperature) && !noTemperature.has(noTempKey) ? { temperature } : {}),
        ...(defs.length ? { tools: defs } : {}),
        ...(edit ? { context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] } } : {}),
        ...extra,
      },
      headers: { ...baseHeaders, ...(edit ? { 'anthropic-beta': 'context-management-2025-06-27' } : {}) },
    };
  };

  async function send(extra, opts) {
    for (;;) {
      const { body, headers } = request(extra, opts);
      try {
        return await client.messages.create(body, { signal, headers });
      } catch (e) {
        if (e?.name === 'AbortError' || signal?.aborted) throw e;
        const msg = clip(e?.error?.error?.message || e?.message);
        if ('temperature' in body && isDeprecatedTemp(e?.status, msg)) { noTemperature.add(noTempKey); continue; }
        if (e?.status === 400 && mode === 'auto' && caching() && /cache_control/i.test(msg)) { noCache.add(baseUrl); continue; }
        if (e?.status === 400 && body.context_management && /context.?management|clear_tool_uses|anthropic-beta/i.test(msg)) { noCtxEdit.add(baseUrl); continue; }
        throw apiError(e?.status, msg);
      }
    }
  }

  return {
    get caching() { return caching(); },
    async next() {
      const res = await send();
      const toolUse = res.stop_reason === 'tool_use';
      if (toolUse) messages.push({ role: 'assistant', content: res.content });
      return {
        text: res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(),
        calls: toolUse ? res.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input })) : [],
        usage: anthropicUsage(res.usage),
        stop: res.stop_reason === 'max_tokens' ? 'max_tokens' : res.stop_reason,
      };
    },
    // Precalentamiento: escribe la caché del prefijo (herramientas + system + entrada) sin generar nada,
    // para que otros agentes lanzados a la vez con el mismo prefijo lo lean en vez de pagarlo enteros.
    // Si el proveedor no lo admite, se ignora.
    async prewarm() {
      if (!caching()) return null;
      try {
        // Mismos reintentos que un turno normal (temperature obsoleta, caché rechazada…)
        return anthropicUsage((await send({ max_tokens: 0 }, { edit: false })).usage);
      } catch (e) {
        if (e?.name === 'AbortError' || signal?.aborted) throw e;
        this.prewarmError = clip(e?.error?.error?.message || e?.message);
        return null;
      }
    },
    pushResults(rs) {
      messages.push({ role: 'user', content: rs.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError })) });
    },
    pushCorrection(previous, message) {
      messages.push({ role: 'assistant', content: previous || '(vacío)' }, { role: 'user', content: message });
    },
  };
}

// La URL base puede venir con o sin /v1 (https://api.openai.com/v1, …/v1beta/openai, http://gateway).
const openaiUrl = (base, path) => {
  const u = new URL(base);
  return `${base}${u.pathname === '/' || u.pathname === '' ? '/v1' : ''}${path}`;
};

async function openaiFetch(p, path, { method = 'GET', body, signal } = {}) {
  const { baseUrl, key } = p.secret();
  let r;
  try {
    r = await fetch(openaiUrl(baseUrl, path), {
      method, signal,
      headers: { authorization: `Bearer ${key}`, ...opencodeHeaders(baseUrl), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e?.name === 'AbortError' || signal?.aborted) throw e;
    throw apiError(0, `No se pudo conectar con ${p.host}: ${e.message}`);
  }
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!r.ok) throw apiError(r.status, clip(data?.error?.message || text));
  return data;
}

// Recorte del historial por lotes (solo OpenAI y simulado; en Anthropic editar turnos anteriores da 400
// y lo hace el servidor). Si el historial pasa de ORQ_LLM_COMPACT_AT caracteres (60 000 por defecto),
// los resultados de herramientas de hace más de 5 turnos y de más de 1 500 caracteres se cambian por una
// línea. Todo de golpe: invalida la caché del proveedor una vez en lugar de en cada turno.
const COMPACT_KEEP = 5, COMPACT_MIN = 1500;
function compactToolResults(messages, calls) {
  const at = Number(process.env.ORQ_LLM_COMPACT_AT ?? 60000);
  const size = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0);
  if (!(at > 0) || size <= at) return 0;
  let later = 0, n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) { later++; continue; }
    if (m.role !== 'tool' || later < COMPACT_KEEP || typeof m.content !== 'string' || m.content.length <= COMPACT_MIN || m.content.startsWith('[omitido')) continue;
    const c = calls.get(m.tool_call_id);
    m.content = `[omitido del historial para ahorrar contexto: resultado de ${c ? `${c.name} ${JSON.stringify(c.input).slice(0, 160)}` : 'una herramienta'} (${m.content.length.toLocaleString('es')} caracteres). Si lo necesitas, vuelve a llamar a la herramienta.]`;
    n++;
  }
  return n;
}

function openaiChat(p, { model, system, user, maxTokens, temperature, tools, signal }) {
  const noTempKey = `openai:${model}`;
  const sys = sectionsOf(system).join('\n\n');
  const messages = [...(sys ? [{ role: 'system', content: sys }] : []), { role: 'user', content: user }];
  const calls = new Map(); // id → { name, input }, para describir lo que se omite al compactar
  return {
    caching: true,
    async next() {
      let data;
      for (;;) {
        try {
          data = await openaiFetch(p, '/chat/completions', {
            method: 'POST', signal,
            body: {
              model, messages, max_tokens: maxTokens,
              ...(Number.isFinite(temperature) && !noTemperature.has(noTempKey) ? { temperature } : {}),
              ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: { name: t.def.name, description: t.def.description, parameters: t.def.input_schema } })) } : {}),
            },
          });
          break;
        } catch (e) {
          if (e?.name === 'AbortError' || signal?.aborted) throw e;
          if (Number.isFinite(temperature) && !noTemperature.has(noTempKey) && isDeprecatedTemp(e?.status, e?.message)) {
            noTemperature.add(noTempKey);
            continue;
          }
          throw e;
        }
      }
      const c = data?.choices?.[0] || {};
      const msg = c.message || {};
      const found = (msg.tool_calls || []).map(t => {
        let input = {};
        try { input = JSON.parse(t.function?.arguments || '{}'); } catch {}
        return { id: t.id, name: t.function?.name, input };
      });
      if (found.length) {
        messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
        for (const f of found) calls.set(f.id, f);
      }
      const text = typeof msg.content === 'string' ? msg.content : (msg.content || []).map(x => x.text || '').join('\n');
      const prompt = data?.usage?.prompt_tokens || 0, cached = data?.usage?.prompt_tokens_details?.cached_tokens || 0;
      return {
        text: text.trim(), calls: found,
        usage: { input: prompt - cached, output: data?.usage?.completion_tokens || 0, cacheRead: cached, cacheWrite: 0 },
        stop: c.finish_reason === 'length' ? 'max_tokens' : c.finish_reason,
      };
    },
    pushResults(rs) {
      for (const r of rs) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    },
    pushCorrection(previous, message) {
      messages.push({ role: 'assistant', content: previous || '(vacío)' }, { role: 'user', content: message });
    },
    compact: () => compactToolResults(messages, calls),
  };
}

// Sin red ni coste. Si el nodo trae «Respuesta simulada» se devuelve tal cual; si no, eco de la entrada.
// mockTools (JSON): [{ name, input }] que el simulado «pide» en su primer turno, o una lista por turnos
// ([[turno 1], [turno 2], …]), para probar herramientas y aprobaciones sin LLM. Después responde con
// mockOutput como siempre. Los tokens se estiman (~4 caracteres por token) sobre la petición completa
// (herramientas, system e historial) e imitan la caché de prompts, para medir ahorros sin gastar.
function parseMockTurns(v) {
  if (v == null || v === '') return [];
  let list = v;
  if (typeof v === 'string') {
    try { list = JSON.parse(v); } catch (e) { throw Object.assign(new Error(`Llamadas simuladas a herramientas: JSON no válido (${e.message})`), { retryable: false }); }
  }
  if (!Array.isArray(list)) list = [list];
  const turns = list.length && list.every(Array.isArray) ? list : [list];
  return turns.map((t, k) => t.map((c, i) => ({ id: `mock_${k + 1}_${i + 1}`, name: String(c?.name || ''), input: c?.input || {} })));
}

// Caché simulada, compartida por todo el proceso (como la del proveedor): hash de prefijo → caducidad
const mockCache = new Map();
const MOCK_TTL = 5 * 60 * 1000;
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
export const clearMockCache = () => mockCache.clear();

function mockUsage({ tools, sections, messages, cache }) {
  const parts = [tools.length ? JSON.stringify(tools.map(t => t.def)) : '', ...sections, ...messages.map(m => JSON.stringify(m))];
  // Marcadores como en Anthropic: tras las herramientas, en las dos últimas secciones del system y al final
  const marks = new Set([...(tools.length ? [0] : []), ...[sections.length - 1, sections.length].filter(i => i >= 1), parts.length - 1]);
  let acc = '';
  const all = [], prefixes = [];
  parts.forEach((s, i) => { acc += s; all.push(acc); if (marks.has(i)) prefixes.push(acc); });
  const tok = c => Math.ceil(c / 4);
  if (!cache) return { input: tok(acc.length), cacheRead: 0, cacheWrite: 0 };
  // Como la API: desde cada marcador se busca hacia atrás (hasta 20 bloques) el último prefijo cacheado
  const now = Date.now();
  let read = 0;
  for (let i = all.length - 1; i >= Math.max(0, all.length - 21); i--) {
    if ((mockCache.get(sha1(all[i])) || 0) > now) { read = all[i].length; break; }
  }
  if (!read) for (const pfx of prefixes) if ((mockCache.get(sha1(pfx)) || 0) > now) read = Math.max(read, pfx.length);
  for (const pfx of prefixes) mockCache.set(sha1(pfx), now + MOCK_TTL);
  return { input: 0, cacheRead: tok(read), cacheWrite: tok(acc.length - read) };
}

function mockChat(_p, { system, user, tools = [], mockOutput, mockTools, wantsJson, promptCache }) {
  const turns = parseMockTurns(mockTools);
  const sections = sectionsOf(system);
  const cache = cacheMode(promptCache) !== 'off';
  const messages = [{ role: 'user', content: user }];
  const calls = new Map();
  let turn = 0;
  const usage = () => mockUsage({ tools, sections, messages, cache });
  return {
    caching: cache,
    async next() {
      const u = usage();
      const pending = turns[turn++] || [];
      if (pending.length) {
        messages.push({ role: 'assistant', content: null, tool_calls: pending.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) });
        for (const c of pending) calls.set(c.id, c);
        return { text: '', calls: pending, usage: { ...u, output: 20 * pending.length }, stop: 'tool_use', estimated: true };
      }
      let text = mockOutput != null && String(mockOutput).trim() !== '' ? (typeof mockOutput === 'string' ? mockOutput : JSON.stringify(mockOutput)) : '';
      if (!text) {
        let entrada = user;
        try { entrada = JSON.parse(user); } catch {}
        text = wantsJson ? JSON.stringify({ simulado: true, entrada }) : `[simulado] ${String(user).slice(0, 500)}`;
      }
      return { text, calls: [], usage: { ...u, output: Math.ceil(text.length / 4) }, stop: 'end_turn', estimated: true };
    },
    async prewarm() { return cache ? { ...usage(), output: 0 } : null; },
    pushResults(rs) {
      for (const r of rs) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    },
    pushCorrection(previous, message) {
      messages.push({ role: 'assistant', content: previous || '(vacío)' }, { role: 'user', content: message });
    },
    compact: () => compactToolResults(messages, calls),
  };
}

export function openChat(p, opts) {
  if (p.kind === 'anthropic') return anthropicChat(p, opts);
  if (p.kind === 'openai') return openaiChat(p, opts);
  if (p.kind === 'mock') return mockChat(p, opts);
  throw new Error(`Proveedor de tipo «${p.kind}» no soportado`);
}

export async function listModels(p, { signal } = {}) {
  if (p.kind === 'mock') return ['mock'];
  if (p.kind === 'openai') {
    const d = await openaiFetch(p, '/models', { signal });
    return (d?.data || []).map(m => m.id).sort();
  }
  const { baseUrl, key } = p.secret();
  const r = await fetch(`${baseUrl}/v1/models?limit=1000`, { signal, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...opencodeHeaders(baseUrl) } });
  if (!r.ok) throw apiError(r.status, clip(await r.text()));
  return ((await r.json())?.data || []).map(m => m.id).sort();
}
