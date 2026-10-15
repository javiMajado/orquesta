import { EventEmitter } from 'node:events';
import { Workflows, Runs, Steps, Logs } from './db.js';
import { NoWorkerError, CancelledError } from './registry.js';
import { CAPS, TRIGGERS, ACTION_TYPES, parseDuration } from '@orquesta/shared/types';
import { evalExpr, render, renderParams, publicEnv, mainText } from '@orquesta/shared/expr';
import { notifyApproval } from './notify.js';
import { resolveLlm } from './llm.js';
import { resolveForWorker } from './connections.js';
import { applyAgent } from './agents.js';
import { grant, grantsForWorker } from './grants.js';
import { env } from './env.js';

const SOURCE = { shell: 'heredada del shell', env: '.env de Orquesta' };
const yes = v => v === true || v === 'true' || v === 'Sí';

// Motor de ejecución: recorre el grafo, ejecuta nodos de control en el orquestador
// y delega los nodos de acción a los workers a través del Registry.
export class Engine extends EventEmitter {
  constructor(registry) {
    super();
    this.registry = registry;
    this.active = new Map(); // runId -> contexto
  }

  emitEvt(e) { this.emit('event', e); }

  log(ctx, level, node, worker, msg) {
    const row = Logs.add({ runId: ctx.runId, level, node, worker, msg });
    this.emitEvt({ type: 'log', runId: ctx.runId, workflowId: ctx.wf.id, log: row });
  }

  emitRun(runId) { this.emitEvt({ type: 'run', run: Runs.get(runId) }); }

  // stopAt: «ejecutar hasta aquí». Solo se ejecutan ese nodo y los que llevan hasta él; las demás ramas
  // no se lanzan y los bucles hacen solo su primer elemento. La salida de la ejecución es la de ese nodo.
  // parentStep: { stepId, stepEvt } del nodo Sub-workflow que lanza esta ejecución (para reflejar en él sus esperas)
  start(workflowId, { mode = 'manual', input = {}, triggerNodeId, parentRunId, parentStep, stopAt, caseId, batchId } = {}) {
    const wf = Workflows.get(workflowId);
    if (!wf) throw Object.assign(new Error('Workflow no encontrado'), { status: 404 });
    const g = { nodes: [], edges: [], ...(wf.graph || {}) };
    let only = null;
    if (stopAt) {
      if (!g.nodes.some(n => n.id === stopAt)) throw Object.assign(new Error('Ese nodo no existe en el workflow guardado'), { status: 400 });
      only = new Set([stopAt]);
      for (const queue = [stopAt]; queue.length;) {
        const id = queue.shift();
        for (const e of g.edges) if (e.to === id && !only.has(e.from)) { only.add(e.from); queue.push(e.from); }
      }
    }
    const trig = triggerNodeId ? g.nodes.find(n => n.id === triggerNodeId)
      : g.nodes.find(n => TRIGGERS.includes(n.type) && (!only || only.has(n.id)));
    if (!trig) throw new Error(only ? 'Ese nodo no está conectado a ningún disparador' : 'El workflow no tiene ningún disparador');

    const run = Runs.create({ workflowId: wf.id, workflowName: wf.name, mode, input, parentRunId, caseId, batchId });
    const ctx = {
      runId: run.id, wf, g, byId: Object.fromEntries(g.nodes.map(n => [n.id, n])),
      byName: {}, tokens: 0, cancelled: false, approvals: new Map(), merges: new Map(), timers: new Set(), children: [],
      only, stopAt: stopAt || null, parentRunId: parentRunId || null, parentStep: parentStep || null, waits: 0,
    };
    this.active.set(run.id, ctx);
    this.emitRun(run.id);
    this.log(ctx, 'info', null, 'orquestador', `Ejecución (${mode}) de «${wf.name}» · estrategia ${this.registry.strategy}`);
    if (only) this.log(ctx, 'info', null, 'orquestador', `Ejecutar hasta «${g.nodes.find(n => n.id === stopAt).name}»: solo ese nodo y los anteriores (${only.size} nodos)`);

    const done = this.runNode(ctx, trig, input, 'r')
      .then(leaves => {
        const output = leaves.length === 1 ? leaves[0] : leaves;
        Runs.finish(run.id, { status: 'success', output });
        this.log(ctx, 'ok', null, 'orquestador', 'Ejecución completada');
        return output;
      })
      .catch(err => {
        const status = err.cancelled ? 'cancelled' : 'error';
        // Detiene ramas paralelas que sigan vivas (aprobaciones, esperas, tareas en workers)
        if (!err.cancelled) { try { this.cancel(run.id); } catch {} }
        Runs.finish(run.id, { status, error: err.message });
        this.log(ctx, 'err', null, 'orquestador', err.cancelled ? 'Ejecución cancelada' : `Ejecución fallida: ${err.message}`);
        throw err;
      })
      .finally(() => { this.active.delete(run.id); this.emitRun(run.id); });
    done.catch(() => {});
    return { runId: run.id, done };
  }

  // Ejecuta un nodo y continúa por sus salidas. Devuelve las salidas de las hojas alcanzadas.
  async runNode(ctx, node, input, scope) {
    if (ctx.cancelled) throw new CancelledError();
    const incoming = ctx.g.edges.filter(e => e.to === node.id && (!ctx.only || ctx.only.has(e.from)));
    const mode = String(node.params?.mode || '');
    if (node.type === 'parallel' && incoming.length > 1 && mode.startsWith('Unir')) {
      const key = `${scope}|${node.id}`;
      const st = ctx.merges.get(key) || { inputs: [], n: 0 };
      st.inputs.push(input); st.n++;
      ctx.merges.set(key, st);
      const first = mode === 'Unir (primera)';
      if (first ? st.n > 1 : st.n < incoming.length) return [];
      if (!first) input = { entradas: st.inputs };
    }

    const stepId = Steps.start({ runId: ctx.runId, nodeId: node.id, nodeName: node.name, nodeType: node.type, input });
    const stepEvt = patch => this.emitEvt({ type: 'step', runId: ctx.runId, workflowId: ctx.wf.id, nodeId: node.id, ...patch });
    stepEvt({ status: 'running', worker: null, output: null, error: null, meta: null });

    let res;
    try {
      res = await this.execute(ctx, node, input, scope, { stepId, stepEvt });
    } catch (err) {
      const status = err.cancelled ? 'cancelled' : 'error';
      Steps.update(stepId, { status, error: err.message, finishedAt: Date.now() });
      stepEvt({ status, error: err.message });
      if (!err.cancelled) this.log(ctx, 'err', node.name, null, err.message);
      throw err;
    }

    const output = res.output === undefined ? null : res.output;
    const port = res.port || 'out';
    // La salida tomada se guarda solo si no es la normal (sí/no, cada/fin): es lo que cuenta la traza
    Steps.update(stepId, { status: 'success', output, finishedAt: Date.now(), port: port !== 'out' ? port : null });
    ctx.byName[node.name] = output;
    stepEvt({ status: 'success', output, ...(port !== 'out' ? { port } : {}) });

    const next = node.id === ctx.stopAt ? []
      : ctx.g.edges.filter(e => e.from === node.id && (e.port || 'out') === port && ctx.byId[e.to] && (!ctx.only || ctx.only.has(e.to)));
    if (!next.length) return [output];
    const results = await Promise.all(next.map(e => this.runNode(ctx, ctx.byId[e.to], output, scope)));
    return results.flat();
  }

  async execute(ctx, node, input, scope, h) {
    const p = node.params || {};
    const ectx = { $json: input, $input: input, $node: ctx.byName, $run: { id: ctx.runId, workflow: ctx.wf.name }, $env: publicEnv() };
    const orq = () => { Steps.update(h.stepId, { worker: 'orquestador' }); h.stepEvt({ status: 'running', worker: 'orquestador' }); };

    switch (node.type) {
      case 'webhook': case 'cron': case 'event':
        orq();
        this.log(ctx, 'info', node.name, 'orquestador', 'Disparado');
        return { output: input };

      case 'if': {
        orq();
        // Es JavaScript directo; si alguien escribe {{ … }} (p. ej. insertado desde «Datos disponibles»), se acepta igual
        const expr = String(p.expr || 'false').trim().replace(/\{\{([\s\S]+?)\}\}/g, '($1)');
        const v = !!evalExpr(expr, ectx);
        this.log(ctx, 'info', node.name, 'orquestador', `Condición ${v ? 'verdadera' : 'falsa'} → rama «${v ? 'sí' : 'no'}»`);
        return { output: input, port: v ? 'true' : 'false' };
      }

      case 'wait': {
        orq();
        const ms = parseDuration(`${p.duration} ${p.unit || 'segundos'}`, 0);
        this.log(ctx, 'info', node.name, 'orquestador', `Esperando ${p.duration} ${p.unit}`);
        await this.sleep(ctx, ms);
        return { output: input };
      }

      case 'parallel':
        orq();
        return { output: input };

      case 'loop': {
        orq();
        let items = render(p.items, ectx);
        if (typeof items === 'string') { try { items = JSON.parse(items); } catch {} }
        if (!Array.isArray(items)) throw new Error('«Lista a iterar» no devuelve un array');
        const size = Math.max(1, parseInt(p.batch, 10) || 1);
        const itemEdges = ctx.g.edges.filter(e => e.from === node.id && e.port === 'item' && ctx.byId[e.to] && (!ctx.only || ctx.only.has(e.to)));
        // «Ejecutar hasta aquí» dentro del bucle: basta con el primer elemento para ver los datos
        if (ctx.only && itemEdges.length && items.length > 1) {
          this.log(ctx, 'info', node.name, 'orquestador', `Ejecutar hasta aquí: solo el primero de ${items.length} elementos`);
          items = items.slice(0, 1);
        }
        this.log(ctx, 'info', node.name, 'orquestador', `Iterando ${items.length} elementos (lotes de ${size})`);
        const results = [];
        for (let i = 0; i < items.length; i += size) {
          const chunk = items.slice(i, i + size);
          const outs = await Promise.all(chunk.map((item, k) => {
            const index = i + k;
            return Promise.all(itemEdges.map(e => this.runNode(ctx, ctx.byId[e.to], { item, index }, `${scope}/${node.id}#${index}`)))
              .then(r => r.flat());
          }));
          outs.forEach(o => results.push(o.length === 1 ? o[0] : o));
        }
        return { output: { items: results, total: items.length }, port: 'done' };
      }

      case 'subflow': {
        orq();
        const target = Workflows.get(p.workflow) || Workflows.findByName(p.workflow);
        if (!target) throw new Error(`Sub-workflow «${p.workflow}» no encontrado`);
        if (target.id === ctx.wf.id) throw new Error('Un workflow no puede invocarse a sí mismo');
        const child = this.start(target.id, { mode: 'subflow', input, parentRunId: ctx.runId, parentStep: h });
        ctx.children.push(child.runId);
        Steps.update(h.stepId, { childRunId: child.runId });
        h.stepEvt({ childRunId: child.runId });
        this.log(ctx, 'info', node.name, 'orquestador', `Invocando «${target.name}» (${child.runId})`);
        return { output: await child.done };
      }

      case 'approval':
        return this.approval(ctx, node, input, h);

      default:
        if (ACTION_TYPES.includes(node.type)) return this.dispatch(ctx, node, input, ectx, h);
        throw new Error(`Tipo de nodo desconocido: ${node.type}`);
    }
  }

  async dispatch(ctx, node, input, ectx, h) {
    const { stepId, stepEvt } = h;
    const exec = node.exec || {};
    const retries = Math.max(0, parseInt(exec.retries, 10) || 0);
    const timeoutMs = parseDuration(exec.timeout, 60000);
    // Agente personalizado: su configuración sustituye a la del nodo (el nodo aporta la entrada)
    const ag = node.type === 'agent' ? applyAgent(node.params) : null;
    if (ag?.agent) this.log(ctx, 'info', node.name, 'orquestador', `Agente personalizado «${ag.agent.name}»`);
    const nodeParams = ag ? ag.params : node.params;
    const llm = node.type === 'agent' ? resolveLlm(nodeParams, this.registry.llmProviders?.() || []) : null;
    // La respuesta y las herramientas simuladas solo se evalúan (y se envían) si el proveedor es el simulado
    const isMock = llm && (llm.info ? llm.info.kind === 'mock' : llm.provider === 'mock');
    const raw = llm && !isMock ? (({ mockOutput, mockTools, ...rest }) => rest)(nodeParams || {}) : nodeParams;
    const params = renderParams(raw, ectx, node.type === 'node' ? ['code'] : []);
    // Campos vacíos = automáticos: el texto principal del nodo anterior. Se resuelve aquí (y no en el
    // worker) para que la revisión humana muestre exactamente lo que se va a usar.
    const autoField = node.type === 'agent' ? 'input' : node.type === 'file' && params.action === 'Escribir' ? 'content' : node.type === 'email' ? 'body' : null;
    if (autoField && (params[autoField] == null || params[autoField] === '')) {
      const m = mainText(input);
      params[autoField] = m.text;
      this.log(ctx, 'info', node.name, 'orquestador', `${{ input: 'Entrada', content: 'Contenido', body: 'Cuerpo' }[autoField]} automático: ${m.field ? `campo «${m.field}» del nodo anterior` : 'salida del nodo anterior'}`);
    }
    let provider;
    if (llm) {
      Object.assign(params, { provider: llm.provider, model: llm.model });
      provider = llm.provider;
      const key = !llm.info ? 'proveedor no conectado' : llm.info.kind === 'mock' ? 'simulado, sin clave'
        : `clave ${llm.info.keyEnv} (${SOURCE[llm.info.source] || llm.info.source}) · huella ${llm.info.fingerprint}`;
      this.log(ctx, 'info', node.name, 'orquestador', `LLM: ${llm.info?.label || provider} · ${llm.model || '¿modelo?'} · ${key}${llm.fromDefault ? ' · por defecto' : ''}`);
      const budget = env.LLM_MAX_TOKENS_PER_RUN;
      if (budget > 0 && ctx.tokens >= budget) throw new Error(`Presupuesto de tokens de la ejecución agotado (${ctx.tokens.toLocaleString('es')} / ${budget.toLocaleString('es')}, ORQ_LLM_MAX_TOKENS_PER_RUN)`);
    }

    // Revisión humana: se enseña exactamente lo que se va a ejecutar y no se ejecuta sin aprobación
    if (yes(exec.humanReview)) {
      const { mockOutput, mockTools, ...shown } = params;
      await this.waitDecision(ctx, node, h, {
        assignee: exec.reviewer || 'quien ejecuta', channel: 'Panel', timeout: exec.reviewTimeout || '4 h',
        meta: { revision: { params: shown, input } }, what: 'Revisión antes de ejecutar',
      });
      this.log(ctx, 'ok', node.name, 'cola-humana', 'Aprobado · se ejecuta con los parámetros revisados');
    }

    // Conexión a BD dada de alta en la UI: se añade DESPUÉS de la revisión humana para que la
    // contraseña no aparezca en la tarjeta de revisión (las del .env las resuelve el worker)
    if (node.type === 'db') {
      const connection = resolveForWorker(params.conn);
      if (connection) {
        params.connection = connection;
        this.log(ctx, 'info', node.name, 'orquestador', `Conexión «${connection.name}» (${connection.driver === 'pg' ? 'PostgreSQL' : 'SQLite'}) · ${connection.readOnly ? 'solo lectura' : 'lectura y escritura'}`);
      }
    }

    let attempt = 0, lastErr;
    while (attempt <= retries) {
      if (ctx.cancelled) throw new CancelledError();
      attempt++;
      try {
        const { output, worker, meta } = await this.registry.dispatch({
          runId: ctx.runId, cap: CAPS[node.type], pin: exec.worker, provider, affKey: `${ctx.wf.id}:${node.id}`,
          nodeType: node.type, params, input, timeoutMs, grants: grantsForWorker(),
          onQueued: () => this.log(ctx, 'warn', node.name, 'orquestador', 'Todos los workers compatibles están ocupados · en cola'),
          onAssigned: w => {
            Steps.update(stepId, { worker: w.id, attempt });
            stepEvt({ status: 'running', worker: w.id });
            this.log(ctx, 'info', node.name, w.id, `Asignado (carga ${w.load}/${w.max})${attempt > 1 ? ` · intento ${attempt}` : ''}`);
          },
          onLog: (msg, wid) => this.log(ctx, 'info', node.name, wid, msg),
          onApproval: (req, wid) => this.toolApproval(ctx, node, h, req, wid),
        });
        this.addMeta(ctx, stepId, stepEvt, meta);
        this.log(ctx, 'ok', node.name, worker, 'Completado');
        return { output };
      } catch (err) {
        lastErr = err;
        this.addMeta(ctx, stepId, stepEvt, err.meta);
        if (err.cancelled || err instanceof NoWorkerError || ctx.cancelled) throw err;
        if (err.retryable === false) {
          if (attempt <= retries) this.log(ctx, 'warn', node.name, null, 'Error no recuperable · no se reintenta');
          throw err;
        }
        if (attempt <= retries) {
          const wait = 1000 * 2 ** (attempt - 1);
          this.log(ctx, 'warn', node.name, null, `${err.message} · reintento en ${wait / 1000} s`);
          await this.sleep(ctx, wait);
        }
      }
    }
    throw lastErr;
  }

  // Guarda proveedor/modelo/tokens del paso y los suma al presupuesto de la ejecución
  addMeta(ctx, stepId, stepEvt, meta) {
    if (!meta) return;
    if (meta.usage?.total) ctx.tokens += meta.usage.total;
    Steps.update(stepId, { meta });
    stepEvt({ meta });
  }

  async approval(ctx, node, input, h) {
    const p = node.params || {};
    const decision = await this.waitDecision(ctx, node, h, { assignee: p.assignee, channel: p.channel, timeout: p.timeout, what: 'Esperando aprobación' });
    const base = input && typeof input === 'object' && !Array.isArray(input) ? input : { valor: input };
    return { output: { ...base, aprobacion: { por: decision.by || 'usuario', comentario: decision.comment || '', fecha: new Date().toISOString() } } };
  }

  // El worker pide algo a mitad de tarea: un permiso que falta (carpeta o comando) o aprobar una
  // llamada a ejecutar_comando. Rechazar no hace fallar aquí: el worker decide (el agente sigue sin ello;
  // un nodo Fichero/Comando falla). «Permitir siempre» guarda el permiso para próximas ejecuciones.
  async toolApproval(ctx, node, h, req, workerId) {
    const permiso = req.kind === 'permiso';
    const { tool = 'herramienta', kind, ...args } = req;
    const label = !permiso ? tool : args.tipo === 'comando' ? `ejecutar «${args.comando}»` : `${args.acceso} en ${args.carpeta}`;
    const shown = !permiso ? { herramienta: tool, ...args }
      : args.tipo === 'comando' ? { permiso: 'Ejecutar comando', comando: args.comando, carpeta: args.carpeta }
      : { permiso: args.acceso === 'escritura' ? 'Leer y escribir en la carpeta' : 'Leer la carpeta', carpeta: args.carpeta, motivo: args.ruta };
    try {
      const d = await this.waitDecision(ctx, node, h, {
        assignee: node.exec?.reviewer || 'quien ejecuta', channel: 'Panel', timeout: node.exec?.reviewTimeout || '4 h',
        meta: { revision: { params: shown }, tool: !permiso, permiso: permiso ? args : undefined },
        what: permiso ? `Permiso pedido (${label})` : `Aprobación de herramienta (${tool})`,
      });
      const always = permiso && d.scope === 'always';
      if (always) {
        grant(args.tipo === 'comando'
          ? { path: args.carpeta, commands: [args.comando], by: d.by || 'usuario' }
          : { path: args.carpeta, read: true, write: args.acceso === 'escritura', by: d.by || 'usuario' });
      }
      this.log(ctx, 'ok', node.name, 'cola-humana', `${permiso ? `Permiso (${label})` : tool} concedido por ${d.by || 'usuario'}${permiso ? (always ? ' · siempre (guardado en Permisos)' : ' · solo esta vez') : ''}`);
      return { approved: true, scope: always ? 'always' : 'once', by: d.by || 'usuario', comment: d.comment || '' };
    } catch (e) {
      if (e.cancelled || ctx.cancelled) throw e;
      this.log(ctx, 'warn', node.name, 'cola-humana', `${permiso ? `Permiso (${label})` : tool}: ${e.message}`);
      return { approved: false, by: 'usuario', comment: e.message };
    } finally {
      // La tarea sigue en el worker: se vuelve a mostrar quién la ejecuta
      if (workerId && !ctx.cancelled) { Steps.update(h.stepId, { worker: workerId }); h.stepEvt({ worker: workerId }); }
    }
  }

  // Pausa el paso hasta que alguien aprueba (resuelve) o rechaza / caduca (lanza error)
  async waitDecision(ctx, node, { stepId, stepEvt }, { assignee, channel, timeout, meta, what }) {
    Steps.update(stepId, { status: 'waiting', worker: 'cola-humana', meta });
    stepEvt({ status: 'waiting', worker: 'cola-humana', ...(meta ? { meta } : {}) });
    this.markWaiting(ctx, +1);
    this.log(ctx, 'warn', node.name, 'cola-humana', `${what} de ${assignee || '—'} (${channel || 'Panel'})`);
    notifyApproval({ runId: ctx.runId, workflow: ctx.wf.name, node: node.name, channel, assignee })
      .catch(e => this.log(ctx, 'warn', node.name, 'cola-humana', `No se pudo notificar: ${e.message}`));

    const timeoutMs = parseDuration(timeout, 4 * 3600e3);
    let decision;
    try {
      decision = await new Promise((resolve, reject) => {
        const t = setTimeout(() => { ctx.approvals.delete(node.id); reject(new Error('La aprobación caducó')); }, Math.min(timeoutMs, 2 ** 31 - 1));
        ctx.approvals.set(node.id, {
          resolve: d => { clearTimeout(t); resolve(d); },
          reject: e => { clearTimeout(t); reject(e); },
        });
      });
    } finally {
      ctx.approvals.delete(node.id);
      if (!ctx.cancelled) this.markWaiting(ctx, -1);
    }
    Steps.update(stepId, { status: 'running' });
    stepEvt({ status: 'running' });

    if (!decision.approved) throw new Error(`Rechazado por ${decision.by || 'usuario'}${decision.comment ? `: ${decision.comment}` : ''}`);
    if (!meta) this.log(ctx, 'ok', node.name, 'cola-humana', `Aprobado por ${decision.by || 'usuario'}`);
    return decision;
  }

  // Una aprobación pendiente (aquí o en un sub-workflow) deja «esperando» esta ejecución, sus padres y
  // los nodos Sub-workflow que las lanzaron; al resolverse todas vuelven a «en curso»
  markWaiting(ctx, delta) {
    for (let c = ctx; c; c = c.parentRunId ? this.active.get(c.parentRunId) : null) {
      c.waits = Math.max(0, c.waits + delta);
      const status = c.waits ? 'waiting' : 'running';
      Runs.setStatus(c.runId, status);
      this.emitRun(c.runId);
      if (c.parentStep) { Steps.update(c.parentStep.stepId, { status }); c.parentStep.stepEvt({ status }); }
    }
  }

  pending(runId) {
    const ctx = this.active.get(runId);
    return ctx ? [...ctx.approvals.keys()] : [];
  }

  decide(runId, nodeId, decision) {
    const a = this.active.get(runId)?.approvals.get(nodeId);
    if (!a) throw new Error('No hay ninguna aprobación pendiente para ese nodo');
    a.resolve(decision);
  }

  cancel(runId) {
    const ctx = this.active.get(runId);
    if (!ctx) throw new Error('La ejecución no está activa');
    ctx.cancelled = true;
    for (const a of ctx.approvals.values()) a.reject(new CancelledError());
    for (const t of ctx.timers) { clearTimeout(t.id); t.reject(new CancelledError()); }
    ctx.timers.clear();
    this.registry.cancelRun(runId);
    ctx.children.forEach(c => { try { this.cancel(c); } catch {} });
  }

  sleep(ctx, ms) {
    return new Promise((resolve, reject) => {
      const t = { reject };
      t.id = setTimeout(() => { ctx.timers.delete(t); resolve(); }, ms);
      ctx.timers.add(t);
    });
  }
}
