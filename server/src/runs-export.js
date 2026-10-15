// Exportación del listado de ejecuciones a CSV. Módulo puro (sin Express ni BD) para probarlo aislado.
// Solo metadatos de la ejecución: nunca input/output, que pueden contener secretos o datos personales.

// Mismos valores que el selector de estado de web/src/screens/Runs.jsx (FILTERS)
export const EXPORT_STATUSES = ['success', 'error', 'running', 'waiting'];
// Tope de filas por exportación (una base muy grande generaría una respuesta enorme en memoria)
export const EXPORT_MAX_ROWS = 10000;

const COLUMNS = ['id', 'seq', 'workflowId', 'workflowName', 'status', 'mode', 'startedAt', 'finishedAt', 'durationMs', 'parentRunId', 'error'];
// Celdas que Excel interpretaría como fórmula (inyección de fórmulas)
const FORMULA = /^[=+\-@\t\r]/;

// Filtros del listado y de la exportación (mismos nombres de query). Lanza 400 si el estado no es válido.
export function parseRunFilters(query = {}) {
  const status = query.status ? String(query.status) : '';
  if (status && !EXPORT_STATUSES.includes(status)) throw Object.assign(new Error(`Estado no válido: ${status}`), { status: 400 });
  const workflowId = query.workflowId ? String(query.workflowId) : '';
  return { workflowId: workflowId || undefined, status: status || undefined };
}

const iso = ts => (ts ? new Date(ts).toISOString() : '');
function valueOf(run, col) {
  if (col === 'startedAt' || col === 'finishedAt') return iso(run[col]);
  if (col === 'durationMs') return run.startedAt && run.finishedAt ? run.finishedAt - run.startedAt : '';
  return run[col];
}

function cell(v, sep) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && FORMULA.test(s)) s = `'${s}`;
  return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV con BOM UTF-8 (Excel lo abre bien) y separador «;» por defecto (Excel en español)
export function runsToCsv(runs, { sep = ';' } = {}) {
  const lines = [COLUMNS.join(sep), ...runs.map(r => COLUMNS.map(c => cell(valueOf(r, c), sep)).join(sep))];
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
