import { Workflows, Runs, Steps, Datasets, Cases, Batches } from './db.js';
import { CAPS } from '@orquesta/shared/types';
import {
  triggerOf, fieldsOf, effectiveValues, buildTriggerInput, valuesFromInput, inferFields, flattenTestInput,
  validateInput, missingRequired, checkExpectations, parseCsv, coerce, diffFromCommon,
} from '@orquesta/shared/inputs';
import { resolveLlm } from './llm.js';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const must = (v, msg = 'No encontrado') => { if (!v) throw err(msg, 404); return v; };
const hhmm = (ts = Date.now()) => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const CONCURRENCY = 4;
const LISTEN_MS = 5 * 60 * 1000;

// Conjuntos de datos y casos de prueba de cada workflow, ejecución de casos y lotes, modo escucha del
// webhook y generación de casos con IA. broadcast: envía eventos a /ws/ui.
export function createDatasets({ engine, registry, broadcast }) {
  const listening = new Map(); // workflowId -> { until, timer }

  // ── Migración: graph.settings.testInput → campos de entrada + conjunto «Por defecto» ──
  function migrateOne(wf) {
    const t = wf?.graph?.settings?.testInput;
    if (typeof t !== 'string') return false;
    const trigger = triggerOf(wf.graph);
    let parsed = null;
    try { parsed = t.trim() ? JSON.parse(t) : {}; } catch { console.warn(`[datasets] «${wf.name}»: los Datos de prueba no son JSON válido; se conservan sin migrar`); return false; }
    const graph = structuredClone(wf.graph);
    delete graph.settings.testInput;
    const values = flattenTestInput(trigger, parsed);
    if (trigger) {
      const tn = graph.nodes.find(n => n.id === trigger.id);
      if (!fieldsOf(tn).length && Object.keys(values).length) tn.params = { ...tn.params, inputFields: inferFields(trigger, values) };
    }
    if (!Datasets.byWorkflow(wf.id).length) {
      const ds = Datasets.create({ workflowId: wf.id, name: 'Por defecto' });
      Cases.create({ datasetId: ds.id, name: 'Datos de prueba', values });
    }
    Workflows.setGraph(wf.id, graph);
    return true;
  }
  const migrateAll = () => Workflows.list().reduce((n, wf) => n + (migrateOne(wf) ? 1 : 0), 0);

  // ── Lectura ──
  function caseView(c, ds, fields) {
    return { ...c, missing: missingRequired(fields, ds, c) };
  }
  function datasetView(ds, fields) {
    const cases = Cases.byDataset(ds.id).map(c => caseView(c, ds, fields));
    const last = Batches.last(ds.id);
    return { ...ds, cases, lastBatch: last ? summary(last) : null };
  }
  const summary = b => ({ id: b.id, status: b.status, startedAt: b.startedAt, finishedAt: b.finishedAt, total: b.results.length, passed: b.results.filter(r => r.pass).length, failed: b.results.filter(r => r.pass === false).length });
  const wfOf = id => must(Workflows.get(id), 'Workflow no encontrado');
  const ctxOfDataset = dsId => {
    const ds = must(Datasets.get(dsId), 'Conjunto no encontrado');
    const wf = wfOf(ds.workflowId);
    const trigger = triggerOf(wf.graph);
    return { ds, wf, trigger, fields: fieldsOf(trigger) };
  };
  const llmReady = () => registry.list?.().some(w => w.enabled && w.caps.includes('llm')) ?? true;

  function list(wfId) {
    const wf = wfOf(wfId);
    const fields = fieldsOf(triggerOf(wf.graph));
    const l = listening.get(wfId);
    return { datasets: Datasets.byWorkflow(wfId).map(ds => datasetView(ds, fields)), llmReady: llmReady(), listening: l ? { until: l.until } : null };
  }
  const changed = wfId => broadcast({ type: 'datasets', workflowId: wfId });

  // ── Escritura ──
  function createDataset(wfId, { name, common } = {}) {
    wfOf(wfId);
    const ds = Datasets.create({ workflowId: wfId, name: String(name || '').trim() || 'Nuevo conjunto', common: common || {} });
    changed(wfId);
    return ds;
  }
  function updateDataset(id, b = {}) {
    const ds = must(Datasets.update(id, { name: b.name, common: b.common, position: b.position }));
    changed(ds.workflowId);
    return ds;
  }
  function removeDataset(id) {
    const ds = must(Datasets.get(id));
    Datasets.remove(id);
    changed(ds.workflowId);
    return { ok: true };
  }
  function duplicateDataset(id) {
    const ds = must(Datasets.get(id));
    const copy = Datasets.create({ workflowId: ds.workflowId, name: `${ds.name} (copia)`, common: ds.common });
    for (const c of Cases.byDataset(id)) Cases.create({ datasetId: copy.id, name: c.name, values: c.values, removed: c.removed, expect: c.expect, expectError: c.expectError, source: c.source });
    changed(ds.workflowId);
    return copy;
  }
  function createCase(dsId, b = {}) {
    const ds = must(Datasets.get(dsId), 'Conjunto no encontrado');
    const n = Cases.byDataset(dsId).length + 1;
    const c = Cases.create({ datasetId: dsId, name: String(b.name || '').trim() || `Caso ${n}`, values: b.values || {}, removed: b.removed || [], expect: b.expect || [], expectError: !!b.expectError, source: b.source || { type: 'manual' } });
    changed(ds.workflowId);
    return c;
  }
  function updateCase(id, b = {}) {
    const c = must(Cases.update(id, { name: b.name, values: b.values, removed: b.removed, expect: b.expect, expectError: b.expectError, position: b.position }));
    changed(Datasets.get(c.datasetId)?.workflowId);
    return c;
  }
  function removeCase(id) {
    const c = must(Cases.get(id));
    Cases.remove(id);
    changed(Datasets.get(c.datasetId)?.workflowId);
    return { ok: true };
  }

  // ── Ejecución ──
  // Lanza un caso. values: valores ya resueltos (borrador del panel); si no, los guardados del caso.
  function runCase(caseId, { stopAt, batchId, values } = {}) {
    const c = must(Cases.get(caseId), 'Caso no encontrado');
    const { ds, wf, trigger, fields } = ctxOfDataset(c.datasetId);
    if (!trigger) throw err('El workflow no tiene ningún disparador');
    const vals = values || effectiveValues(ds, c);
    const input = buildTriggerInput(trigger, fields, vals);
    const started = engine.start(wf.id, { mode: stopAt ? 'hasta-aqui' : batchId ? 'lote' : 'caso', input, triggerNodeId: trigger.id, stopAt, caseId: c.id, batchId });
    const result = started.done.then(() => null, () => null).then(() => {
      const run = Runs.get(started.runId);
      const { pass, diffs } = stopAt ? { pass: null, diffs: [] } : checkExpectations(c, run, Steps.byRun(run.id));
      if (!stopAt) { Cases.setResult(c.id, { runId: run.id, status: run.status, pass }); changed(wf.id); }
      return { caseId: c.id, runId: run.id, status: run.status, pass, diffs };
    });
    return { runId: started.runId, result };
  }

  function runBatch(dsId, { caseIds } = {}) {
    const { ds, wf } = ctxOfDataset(dsId);
    const cases = Cases.byDataset(dsId).filter(c => !caseIds?.length || caseIds.includes(c.id));
    if (!cases.length) throw err('El conjunto no tiene casos');
    const results = cases.map(c => ({ caseId: c.id, name: c.name, runId: null, status: 'pending', pass: null, diffs: [] }));
    const batch = Batches.create({ datasetId: ds.id, workflowId: wf.id, results });
    const emit = status => {
      Batches.save(batch.id, { status, results, finished: status !== 'running' });
      broadcast({ type: 'batch', workflowId: wf.id, batch: Batches.get(batch.id) });
    };
    let next = 0;
    const worker = async () => {
      while (next < cases.length) {
        const i = next++;
        try {
          const { runId, result } = runCase(cases[i].id, { batchId: batch.id });
          Object.assign(results[i], { runId, status: 'running' });
          emit('running');
          Object.assign(results[i], await result);
        } catch (e) {
          Object.assign(results[i], { status: 'error', pass: false, diffs: [{ label: 'error', expected: 'ejecutar', got: e.message }] });
        }
        emit('running');
      }
    };
    Promise.all(Array.from({ length: Math.min(CONCURRENCY, cases.length) }, worker)).then(() => emit('done'));
    emit('running');
    return Batches.get(batch.id);
  }

  // ── Datos reales ──
  function saveRunAsCase(runId, { datasetId, name } = {}) {
    const run = must(Runs.get(runId), 'Ejecución no encontrada');
    const wf = wfOf(run.workflowId);
    const trigger = triggerOf(wf.graph);
    const ds = datasetId ? must(Datasets.get(datasetId), 'Conjunto no encontrado') : (Datasets.byWorkflow(wf.id)[0] || Datasets.create({ workflowId: wf.id, name: 'Por defecto' }));
    const vals = valuesFromInput(trigger, fieldsOf(trigger), run.input);
    const { values, removed } = diffFromCommon(ds.common, vals);
    return createCase(ds.id, { name: name || `Desde ${run.id}`, values, removed, source: { type: 'run', runId } });
  }

  function listen(wfId) {
    const wf = wfOf(wfId);
    if (triggerOf(wf.graph)?.type !== 'webhook') throw err('Solo se puede escuchar un disparador Webhook');
    stopListening(wfId, false);
    const until = Date.now() + LISTEN_MS;
    listening.set(wfId, { until, timer: setTimeout(() => stopListening(wfId), LISTEN_MS) });
    broadcast({ type: 'listen', workflowId: wfId, until });
    return { until };
  }
  function stopListening(wfId, notify = true) {
    const l = listening.get(wfId);
    if (l) clearTimeout(l.timer);
    listening.delete(wfId);
    if (notify) broadcast({ type: 'listen', workflowId: wfId, until: null });
    return { ok: true };
  }
  const isListening = wfId => listening.has(wfId);
  // Lo llama triggers.js con cada llamada real a un webhook
  function onWebhook(wf, node, input, req) {
    if (!listening.has(wf.id)) return;
    stopListening(wf.id);
    let ds = Datasets.findKind(wf.id, 'capture');
    if (!ds) ds = Datasets.create({ workflowId: wf.id, name: 'Capturados de producción', kind: 'capture' });
    const vals = valuesFromInput(node, fieldsOf(node), input);
    const c = Cases.create({ datasetId: ds.id, name: `Capturado · hoy ${hhmm()}`, values: vals, source: { type: 'webhook', at: Date.now(), ip: req.ip } });
    changed(wf.id);
    broadcast({ type: 'capture', workflowId: wf.id, datasetId: ds.id, caseId: c.id });
  }

  // ── Importar CSV / JSON: una fila = un caso; _name y _expect_error son columnas especiales ──
  function importData(dsId, { text, format } = {}) {
    const { ds, fields } = ctxOfDataset(dsId);
    const src = String(text || '').trim();
    if (!src) throw err('No hay nada que importar');
    let rows;
    if (format === 'json' || (!format && /^[[{]/.test(src))) {
      let j; try { j = JSON.parse(src); } catch (e) { throw err(`JSON no válido: ${e.message}`); }
      rows = Array.isArray(j) ? j : [j];
    } else rows = parseCsv(src);
    if (!rows.length) throw err('No se encontraron filas');
    const created = rows.map((r, i) => {
      const { _name, _expect_error, ...rest } = r || {};
      const vals = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, coerce(fields.find(f => f.key === k), v)]));
      const { values } = diffFromCommon(ds.common, vals);
      return Cases.create({ datasetId: ds.id, name: String(_name || '').trim() || `Importado ${i + 1}`, values, expectError: coerce({ type: 'boolean' }, String(_expect_error ?? '')) === true, source: { type: 'import' } });
    });
    changed(ds.workflowId);
    return { created: created.length };
  }

  // ── IA: generar casos nuevos o completar los que tienen campos obligatorios vacíos ──
  async function generate(dsId, { mode = 'new', count = 3, prompt = '' } = {}) {
    const { ds, wf, fields } = ctxOfDataset(dsId);
    if (!fields.length) throw err('Declara antes los campos de entrada del disparador');
    if (!llmReady()) throw err('Necesita un worker con capacidad llm');
    const cases = Cases.byDataset(ds.id);
    const targets = mode === 'fill' ? cases.filter(c => missingRequired(fields, ds, c).length) : [];
    if (mode === 'fill' && !targets.length) return { updated: 0 };
    const n = mode === 'fill' ? targets.length : Math.max(1, Math.min(20, Number(count) || 3));
    const typeSchema = f => f.type === 'number' ? { type: 'number' } : f.type === 'boolean' ? { type: 'boolean' }
      : ['list', 'file'].includes(f.type) ? { type: 'array', items: { type: 'string' } } : f.type === 'object' ? { type: 'object' }
      : f.type === 'option' && f.options?.length ? { type: 'string', enum: f.options } : { type: 'string' };
    const schema = {
      type: 'object', required: ['casos'], additionalProperties: false,
      properties: { casos: { type: 'array', minItems: n, maxItems: n, items: {
        type: 'object', required: ['nombre', 'valores'],
        properties: { nombre: { type: 'string' }, valores: { type: 'object', properties: Object.fromEntries(fields.map(f => [f.key, typeSchema(f)])) } },
      } } },
    };
    const instrucciones = [
      'Generas datos de prueba realistas para ejecutar un workflow. Responde solo con JSON.',
      `Workflow: «${wf.name}». ${wf.description || ''}`,
      `Campos de entrada: ${JSON.stringify(fields.map(f => ({ campo: f.key, tipo: f.type, obligatorio: !!f.required, opciones: f.options, ayuda: f.help || undefined })))}`,
      `Valores comunes del conjunto (no hace falta repetirlos): ${JSON.stringify(ds.common)}`,
      mode === 'fill'
        ? `Completa estos casos. Para cada uno devuelve SOLO los campos que le faltan, con el mismo nombre de caso y en el mismo orden: ${JSON.stringify(targets.map(c => ({ nombre: c.name, valores: effectiveValues(ds, c), faltan: missingRequired(fields, ds, c) })))}`
        : `Crea ${n} casos variados y distintos de los existentes: ${JSON.stringify(cases.map(c => c.name))}. Pon a cada uno un nombre corto y descriptivo en español.`,
      prompt ? `Indicaciones del usuario: ${prompt}` : '',
    ].filter(Boolean).join('\n\n');

    const llm = resolveLlm({}, registry.llmProviders?.() || []);
    const isMock = llm.info ? llm.info.kind === 'mock' : llm.provider === 'mock';
    const fake = () => ({ casos: (mode === 'fill' ? targets : Array.from({ length: n })).map((c, i) => ({
      nombre: c?.name || `Caso generado ${cases.length + i + 1}`,
      valores: Object.fromEntries(fields.filter(f => mode !== 'fill' || missingRequired(fields, ds, c).includes(f.key)).map(f => [f.key, sample(f, i)])),
    })) });
    const { output } = await registry.dispatch({
      runId: `generar-${ds.id}`, cap: CAPS.agent, provider: llm.provider, nodeType: 'agent', input: null, timeoutMs: 120000,
      params: { provider: llm.provider, model: llm.model, prompt: instrucciones, input: 'Genera los casos.', output: 'JSON', schema: JSON.stringify(schema), maxTokens: '4096', tools: '', ...(isMock ? { mockOutput: JSON.stringify(fake()) } : {}) },
    });
    const list = Array.isArray(output?.casos) ? output.casos : [];
    const clean = v => Object.fromEntries(Object.entries(v || {}).filter(([k]) => fields.some(f => f.key === k)).map(([k, x]) => [k, coerce(fields.find(f => f.key === k), x)]));
    if (mode === 'fill') {
      targets.forEach((c, i) => { const g = list.find(x => x.nombre === c.name) || list[i]; if (g) Cases.update(c.id, { values: { ...c.values, ...clean(g.valores) } }); });
      changed(wf.id);
      return { updated: targets.length };
    }
    const created = list.slice(0, n).map(g => Cases.create({ datasetId: ds.id, name: String(g.nombre || 'Caso generado').slice(0, 80), values: diffFromCommon(ds.common, clean(g.valores)).values, source: { type: 'ia' } }));
    changed(wf.id);
    return { created: created.length };
  }

  // Validación de llamadas reales a webhooks (si el nodo tiene «Validar llamadas reales»)
  function validateWebhook(node, input) {
    const fields = fieldsOf(node);
    if (!node.params?.validateInput || !fields.length) return [];
    return validateInput(fields, valuesFromInput(node, fields, input));
  }

  return {
    migrateOne, migrateAll, list, createDataset, updateDataset, removeDataset, duplicateDataset,
    createCase, updateCase, removeCase, runCase, runBatch, saveRunAsCase, listen, stopListening, isListening,
    onWebhook, importData, generate, validateWebhook, getBatch: id => must(Batches.get(id)),
  };
}

// Valor de ejemplo para el simulado (sin LLM)
function sample(f, i) {
  if (f.default !== undefined && f.default !== '') return f.default;
  switch (f.type) {
    case 'email': return `persona${i + 1}@ejemplo.com`;
    case 'number': return i + 1;
    case 'boolean': return i % 2 === 0;
    case 'option': return f.options?.[i % (f.options.length || 1)] ?? '';
    case 'list': case 'file': return [];
    case 'object': return {};
    case 'longtext': return `Texto de ejemplo ${i + 1} para «${f.key}».`;
    default: return `${f.key} ${i + 1}`;
  }
}
