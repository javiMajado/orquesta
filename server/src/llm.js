import { env } from './env.js';
import { Settings } from './db.js';

// ORQ_LLM_DEFAULT = "proveedor:modelo" (el modelo puede contener ':')
export function llmDefault() {
  const [provider = '', ...rest] = String(env.LLM_DEFAULT || '').split(':');
  return { provider: provider.trim(), model: rest.join(':').trim() };
}

// Qué proveedor y modelo usará un nodo Agente. Si el nodo no elige y no hay ORQ_LLM_DEFAULT,
// se usa el simulado: nunca se tira de una clave real sin haberlo configurado explícitamente.
export function resolveLlm(params = {}, providers = []) {
  const def = llmDefault();
  const id = params.provider || def.provider || 'mock';
  const info = providers.find(p => p.id === id) || null;
  const model = params.model || (id === def.provider ? def.model : '') || info?.defaultModel || (id === 'mock' ? 'mock' : '');
  return { provider: id, model, info, fromDefault: !params.provider };
}

// Caché de prompts por proveedor (pantalla Workers): auto (por defecto: activada, y se desactiva sola si el
// proveedor la rechaza), on u off. Viaja con cada tarea (params.promptCache); el worker la aplica.
export const CACHE_MODES = ['auto', 'on', 'off'];
export const llmCache = () => Settings.get('llmCache', {}) || {};
export const llmCacheMode = provider => (CACHE_MODES.includes(llmCache()[provider]) ? llmCache()[provider] : 'auto');
export function setLlmCache(patch = {}) {
  const cur = llmCache();
  for (const [id, mode] of Object.entries(patch)) if (CACHE_MODES.includes(mode)) cur[id] = mode;
  Settings.set('llmCache', cur);
  return cur;
}
