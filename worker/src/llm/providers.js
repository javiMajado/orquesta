import crypto from 'node:crypto';
import { keySource, SOURCE_LABEL } from '@orquesta/shared/env';

// Proveedores LLM de este worker (ORQ_LLM_PROVIDERS). Las claves se quedan aquí:
// al orquestador solo se le envía describe() — origen de la clave y una huella, nunca la clave.
//
// Descriptor: { id, label, kind: 'anthropic' | 'openai' | 'mock', baseUrl | baseUrlEnv, keyEnv, defaultModel }
//   anthropic → Messages API (Anthropic o un gateway compatible)
//   openai    → /v1/chat/completions (OpenAI, LiteLLM, Gemini, OpenRouter, o cualquier gateway compatible)
//   mock      → respuesta simulada, sin coste ni red

export const MOCK = { id: 'mock', label: 'Simulado (sin coste)', kind: 'mock', defaultModel: 'mock' };
const KINDS = ['anthropic', 'openai', 'mock'];
const DEFAULT_BASE = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com' };

export const fingerprint = key => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 8);

const hostOf = url => { try { return new URL(url).host; } catch { return ''; } };

export function loadProviders(env = process.env) {
  let raw;
  try { raw = JSON.parse(env.ORQ_LLM_PROVIDERS || '[]'); } catch { throw new Error('ORQ_LLM_PROVIDERS no es un JSON válido'); }
  if (!Array.isArray(raw)) throw new Error('ORQ_LLM_PROVIDERS debe ser un array');
  const allowShell = env.ORQ_LLM_ALLOW_SHELL === 'true';
  const list = raw.some(p => p.kind === 'mock') ? raw : [...raw, MOCK];

  return list.map(d => {
    const p = { id: String(d.id || ''), label: d.label || d.id, kind: d.kind, defaultModel: d.defaultModel || '', keyEnv: d.keyEnv || '' };
    const base = d.baseUrl || (d.baseUrlEnv && env[d.baseUrlEnv]) || DEFAULT_BASE[d.kind] || '';
    const priv = { baseUrl: base.replace(/\/+$/, ''), key: p.keyEnv ? env[p.keyEnv] || '' : '' };
    const info = { ...p, host: hostOf(base), source: 'none', sourceLabel: SOURCE_LABEL.none, fingerprint: '', enabled: true, reason: '' };

    const off = reason => Object.assign(info, { enabled: false, reason });
    if (!p.id) off('Falta «id»');
    else if (!KINDS.includes(d.kind)) off(`Tipo «${d.kind}» no soportado (anthropic, openai o mock)`);
    else if (d.kind !== 'mock') {
      if (!p.keyEnv) off('Falta «keyEnv» (nombre de la variable con la clave)');
      else if (!priv.key) off(`La variable ${p.keyEnv} está vacía`);
      else {
        info.source = keySource(p.keyEnv, env);
        info.sourceLabel = SOURCE_LABEL[info.source];
        info.fingerprint = fingerprint(priv.key);
        if (info.source === 'shell' && !allowShell) off(`La clave ${p.keyEnv} viene del shell; pon ORQ_LLM_ALLOW_SHELL=true para permitirla`);
      }
      if (info.enabled && !priv.baseUrl) off('Falta la URL base');
    }
    // describe() viaja al orquestador; secret() no sale nunca del worker
    return { describe: () => ({ ...info }), secret: () => priv, ...info };
  });
}
