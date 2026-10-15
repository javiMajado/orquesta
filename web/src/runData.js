import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

// Conjuntos de datos y casos de prueba de un workflow, recargados en vivo (eventos datasets/listen/capture)
export function useDatasets(wfId, subscribe) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const reload = useCallback(() => api(`/workflows/${wfId}/datasets`).then(d => { setData(d); setErr(''); }, e => setErr(e.message)), [wfId]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => subscribe(m => {
    if (['datasets', 'listen', 'capture'].includes(m.type) && m.workflowId === wfId) reload();
  }), [wfId, subscribe, reload]);
  return { data, err, reload };
}

// Conjunto activo recordado por workflow
export const lsKey = wfId => `orq_ds_${wfId}`;
export const readActive = wfId => { try { return localStorage.getItem(lsKey(wfId)) || null; } catch { return null; } };
export const writeActive = (wfId, id) => { try { id ? localStorage.setItem(lsKey(wfId), id) : localStorage.removeItem(lsKey(wfId)); } catch {} };
