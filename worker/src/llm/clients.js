import Anthropic from '@anthropic-ai/sdk';

// Cliente de chat común para todos los proveedores:
//   const chat = openChat(provider, opts); const r = await chat.next(); chat.pushResults([...])
//   chat.pushCorrection(textoAnterior, mensaje): pide al modelo que corrija su última respuesta
// r = { text, calls: [{ id, name, input }], usage: { input, output }, stop, estimated? }

// Error de API con indicación de si merece la pena reintentar (4xx salvo 429, no).
export function apiError(status, msg) {
  const e = new Error(status ? `HTTP ${status}: ${msg}` : msg);
  e.status = status;
  e.retryable = !status || status === 408 || status === 429 || status >= 500;
  return e;
}
const clip = s => String(s || '').slice(0, 400);

function anthropicChat(p, { model, system, user, maxTokens, temperature, tools, signal }) {
  const { baseUrl, key } = p.secret();
  // authToken: null evita que el SDK lea ANTHROPIC_AUTH_TOKEN del entorno por su cuenta.
  // maxRetries: 0 porque los reintentos los decide el orquestador (y así se ven y se cuentan).
  const client = new Anthropic({ apiKey: key, authToken: null, baseURL: baseUrl, maxRetries: 0 });
  const messages = [{ role: 'user', content: user }];
  return {
    async next() {
      let res;
      try {
        res = await client.messages.create({
          model, max_tokens: maxTokens, messages,
          ...(system ? { system } : {}),
          ...(Number.isFinite(temperature) ? { temperature } : {}),
          ...(tools.length ? { tools: tools.map(t => t.def) } : {}),
        }, { signal });
      } catch (e) {
        if (e?.name === 'AbortError' || signal?.aborted) throw e;
        throw apiError(e?.status, clip(e?.error?.error?.message || e?.message));
      }
      const toolUse = res.stop_reason === 'tool_use';
      if (toolUse) messages.push({ role: 'assistant', content: res.content });
      return {
        text: res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(),
        calls: toolUse ? res.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input })) : [],
        usage: { input: res.usage?.input_tokens || 0, output: res.usage?.output_tokens || 0 },
        stop: res.stop_reason === 'max_tokens' ? 'max_tokens' : res.stop_reason,
      };
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
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
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

function openaiChat(p, { model, system, user, maxTokens, temperature, tools, signal }) {
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }];
  return {
    async next() {
      const data = await openaiFetch(p, '/chat/completions', {
        method: 'POST', signal,
        body: {
          model, messages, max_tokens: maxTokens,
          ...(Number.isFinite(temperature) ? { temperature } : {}),
          ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: { name: t.def.name, description: t.def.description, parameters: t.def.input_schema } })) } : {}),
        },
      });
      const c = data?.choices?.[0] || {};
      const msg = c.message || {};
      const calls = (msg.tool_calls || []).map(t => {
        let input = {};
        try { input = JSON.parse(t.function?.arguments || '{}'); } catch {}
        return { id: t.id, name: t.function?.name, input };
      });
      if (calls.length) messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
      const text = typeof msg.content === 'string' ? msg.content : (msg.content || []).map(x => x.text || '').join('\n');
      return {
        text: text.trim(), calls,
        usage: { input: data?.usage?.prompt_tokens || 0, output: data?.usage?.completion_tokens || 0 },
        stop: c.finish_reason === 'length' ? 'max_tokens' : c.finish_reason,
      };
    },
    pushResults(rs) {
      for (const r of rs) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    },
    pushCorrection(previous, message) {
      messages.push({ role: 'assistant', content: previous || '(vacío)' }, { role: 'user', content: message });
    },
  };
}

// Sin red ni coste. Si el nodo trae «Respuesta simulada» se devuelve tal cual; si no, eco de la entrada.
// mockTools (JSON): [{ name, input }] que el simulado «pide» en su primer turno, para probar
// herramientas y aprobaciones sin LLM. Después responde con mockOutput como siempre.
function parseMockTools(v) {
  if (v == null || v === '') return [];
  let list = v;
  if (typeof v === 'string') {
    try { list = JSON.parse(v); } catch (e) { throw Object.assign(new Error(`Llamadas simuladas a herramientas: JSON no válido (${e.message})`), { retryable: false }); }
  }
  if (!Array.isArray(list)) list = [list];
  return list.map((c, i) => ({ id: `mock_${i + 1}`, name: String(c?.name || ''), input: c?.input || {} }));
}

function mockChat(_p, { user, mockOutput, mockTools, wantsJson }) {
  let pendingCalls = parseMockTools(mockTools);
  return {
    async next() {
      if (pendingCalls.length) {
        const calls = pendingCalls;
        pendingCalls = [];
        return { text: '', calls, usage: { input: Math.ceil(user.length / 4), output: 20 * calls.length }, stop: 'tool_use', estimated: true };
      }
      let text = mockOutput != null && String(mockOutput).trim() !== '' ? (typeof mockOutput === 'string' ? mockOutput : JSON.stringify(mockOutput)) : '';
      if (!text) {
        let entrada = user;
        try { entrada = JSON.parse(user); } catch {}
        text = wantsJson ? JSON.stringify({ simulado: true, entrada }) : `[simulado] ${String(user).slice(0, 500)}`;
      }
      // Tokens estimados (~4 caracteres por token) para que el presupuesto y los logs sean realistas
      return { text, calls: [], usage: { input: Math.ceil(user.length / 4), output: Math.ceil(text.length / 4) }, stop: 'end_turn', estimated: true };
    },
    pushResults() {},
    pushCorrection() {},
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
  const r = await fetch(`${baseUrl}/v1/models?limit=1000`, { signal, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
  if (!r.ok) throw apiError(r.status, clip(await r.text()));
  return ((await r.json())?.data || []).map(m => m.id).sort();
}
