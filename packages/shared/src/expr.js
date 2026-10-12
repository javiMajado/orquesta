import vm from 'node:vm';
export { publicEnv } from './env.js';

// Nota: node:vm aísla el ámbito pero NO es una frontera de seguridad.
// Para usuarios no confiables usa isolated-vm o workers en contenedores.
const SAFE = { JSON, Math, Date, String, Number, Boolean, Array, Object, parseInt, parseFloat, encodeURIComponent, decodeURIComponent };

export function evalExpr(code, ctx, timeout = 200) {
  const sandbox = vm.createContext({ ...SAFE, ...ctx });
  return new vm.Script(`(${code})`, { filename: 'expresion' }).runInContext(sandbox, { timeout });
}

// Sustituye {{ expr }} en un texto. Si el texto es SOLO una expresión, devuelve el valor tal cual (objeto, array…).
export function render(tpl, ctx) {
  if (typeof tpl !== 'string' || !tpl.includes('{{')) return tpl;
  const whole = tpl.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
  if (whole && !whole[1].includes('}}')) return evalExpr(whole[1], ctx);
  return tpl.replace(/\{\{([\s\S]+?)\}\}/g, (_, e) => {
    const v = evalExpr(e, ctx);
    return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// «Texto principal» de la salida de un nodo, para los campos que se dejan vacíos (modo automático):
// respuesta de un agente (text), contenido de un fichero (contenido)… Si no hay, el objeto como JSON.
export const MAIN_FIELDS = ['text', 'contenido', 'texto', 'content'];
export function mainText(v) {
  if (v == null) return { text: '', field: null };
  if (typeof v === 'string') return { text: v, field: null };
  if (typeof v === 'object' && !Array.isArray(v)) {
    const k = MAIN_FIELDS.find(f => typeof v[f] === 'string');
    if (k) return { text: v[k], field: k };
  }
  return { text: JSON.stringify(v, null, 2), field: '(todo, como JSON)' };
}

export function renderParams(params, ctx, skip = []) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    try { out[k] = skip.includes(k) ? v : render(v, ctx); }
    catch (e) { throw new Error(`Error en el campo «${k}»: ${e.message}`); }
  }
  return out;
}
