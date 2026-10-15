// Ajustes de un nodo Sub-workflow sobre el workflow que invoca: { [idNodoHijo]: { param: valor } }.
// Valen solo para esa ejecución: el workflow hijo no se modifica. Un nodo Sub-workflow del hijo puede
// recibir a su vez `overrides` (ajustes de sus propios hijos): se combinan con los que ya tenga.
// Los valores admiten {{ expresiones }}, que se evalúan dentro del hijo como cualquier parámetro.
const isObj = o => !!o && typeof o === 'object' && !Array.isArray(o);

export function mergeParams(params = {}, ov = {}) {
  const out = { ...params };
  for (const [k, v] of Object.entries(ov)) out[k] = k === 'overrides' && isObj(v) ? mergeOverrides(params.overrides, v) : v;
  return out;
}

export function mergeOverrides(base, extra) {
  const out = { ...(isObj(base) ? base : {}) };
  for (const [id, ov] of Object.entries(isObj(extra) ? extra : {})) if (isObj(ov)) out[id] = mergeParams(out[id], ov);
  return out;
}

// Grafo con los ajustes aplicados y los nombres de los nodos que han cambiado
export function applyOverrides(graph, overrides) {
  const applied = [];
  if (!isObj(overrides)) return { graph, applied };
  const nodes = (graph.nodes || []).map(n => {
    const ov = overrides[n.id];
    if (!isObj(ov) || !Object.keys(ov).length) return n;
    applied.push(n.name);
    return { ...n, params: mergeParams(n.params, ov) };
  });
  return { graph: { ...graph, nodes }, applied };
}

// Quita los ajustes vacíos (nodos sin ningún parámetro cambiado), para guardar el grafo limpio
export function pruneOverrides(overrides) {
  const out = {};
  for (const [id, ov] of Object.entries(isObj(overrides) ? overrides : {})) {
    if (!isObj(ov)) continue;
    const o = { ...ov };
    if ('overrides' in o) { o.overrides = pruneOverrides(o.overrides); if (!Object.keys(o.overrides).length) delete o.overrides; }
    if (Object.keys(o).length) out[id] = o;
  }
  return out;
}
