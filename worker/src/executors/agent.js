import { openChat } from '../llm/clients.js';
import { guardedFetch } from '../llm/net-guard.js';
import { mainText } from '@orquesta/shared/expr';
import { listFiles, readText, searchText, findFiles, checkCommand, runCommand } from '../workspace.js';
import { makeAccess } from '../access.js';
import { validateSchema, parseSchema } from '../llm/json-schema.js';

// Herramientas que un agente puede usar (campo «Herramientas», separadas por comas).
// Por defecto ninguna. Ninguna escribe en disco. Carpetas y comandos necesitan permiso (pantalla
// Permisos); si falta, se pide al usuario. Además, salvo «Aprobar cada comando» = No, cada
// ejecutar_comando espera aprobación aunque el comando ya esté permitido.
const TOOLS = {
  http_request: {
    def: {
      name: 'http_request',
      description: 'Hace una petición HTTP a un dominio permitido y devuelve el estado y el cuerpo de la respuesta (máx. 20 000 caracteres).',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          body: { type: 'string' },
        },
        required: ['url'],
      },
    },
    async run({ url, method = 'GET', headers, body }, { signal }) {
      const r = await guardedFetch(url, { method, headers, body: method === 'GET' ? undefined : body, signal });
      return JSON.stringify({ status: r.status, body: (await r.text()).slice(0, 20000) });
    },
  },
  listar_ficheros: {
    def: {
      name: 'listar_ficheros',
      description: 'Lista ficheros y carpetas (recursivo) de una carpeta permitida. Omite node_modules, .git, dist… Rutas absolutas.',
      input_schema: {
        type: 'object',
        properties: { ruta: { type: 'string', description: 'Carpeta (ruta absoluta)' }, profundidad: { type: 'integer', description: 'Niveles a recorrer (1-8, por defecto 3)' } },
        required: ['ruta'],
      },
    },
    run: async (args, { access }) => JSON.stringify(await listFiles(args, { access })),
  },
  buscar_en_ficheros: {
    def: {
      name: 'buscar_en_ficheros',
      description: 'Busca un texto (o una expresión regular) en todos los ficheros de texto de una carpeta permitida, como grep. Devuelve líneas «ruta:línea: texto». Úsala para encontrar dónde está algo antes de leer: busca los términos de la tarea (y sus equivalentes en inglés, que es como suele estar el código), los nombres de funciones, rutas de API o mensajes de error, y después lee con leer_fichero solo alrededor de esas líneas. Con regex: true, «export|csv» busca cualquiera de los dos.',
      input_schema: {
        type: 'object',
        properties: {
          ruta: { type: 'string', description: 'Carpeta donde buscar (ruta absoluta)' },
          patron: { type: 'string', description: 'Texto a buscar (o expresión regular si regex = true)' },
          regex: { type: 'boolean', description: 'Tratar el patrón como expresión regular (por defecto false)' },
          mayusculas: { type: 'boolean', description: 'Distinguir mayúsculas (por defecto false)' },
          incluir: { type: 'string', description: 'Solo estos ficheros, globs separados por comas (p. ej. «*.js,*.ts» o «src/**»)' },
          contexto: { type: 'integer', description: 'Líneas de contexto antes y después (0-5, por defecto 0)' },
          maxResultados: { type: 'integer', description: 'Máximo de coincidencias (por defecto 50, máx. 200)' },
        },
        required: ['ruta', 'patron'],
      },
    },
    run: async (args, { access }) => JSON.stringify(await searchText(args, { access })),
  },
  buscar_ficheros: {
    def: {
      name: 'buscar_ficheros',
      description: 'Encuentra ficheros por nombre o ruta con un patrón glob (como glob en los editores): «**/*.test.js», «src/**/routes/*», «*export*», «{package.json,README.md}». Sin «/» se compara con el nombre del fichero. Devuelve rutas relativas a la carpeta.',
      input_schema: {
        type: 'object',
        properties: { ruta: { type: 'string', description: 'Carpeta donde buscar (ruta absoluta)' }, patron: { type: 'string', description: 'Patrón glob; varios separados por comas' } },
        required: ['ruta', 'patron'],
      },
    },
    run: async (args, { access }) => JSON.stringify(await findFiles(args, { access })),
  },
  leer_fichero: {
    def: {
      name: 'leer_fichero',
      description: 'Lee un fichero de texto de una carpeta permitida, por tramos de líneas. Si hay más, la respuesta incluye «siguiente» (línea desde la que seguir). Para un resultado de buscar_en_ficheros en la línea N, lee desde unas líneas antes (p. ej. desde: N-20, lineas: 80) en vez del fichero entero.',
      input_schema: {
        type: 'object',
        properties: { ruta: { type: 'string', description: 'Fichero (ruta absoluta)' }, desde: { type: 'integer', description: 'Primera línea (por defecto 1)' }, lineas: { type: 'integer', description: 'Nº de líneas (por defecto 400, máx. 2000)' } },
        required: ['ruta'],
      },
    },
    run: async (args, { access }) => JSON.stringify(await readText(args, { access })),
  },
  ejecutar_comando: {
    def: {
      name: 'ejecutar_comando',
      description: 'Ejecuta un comando en una carpeta y devuelve el código de salida y el final de la salida. Ya permitidos (exactamente así): COMANDOS. Otro comando requiere que el usuario lo autorice.',
      input_schema: {
        type: 'object',
        properties: { comando: { type: 'string' }, carpeta: { type: 'string', description: 'Carpeta de trabajo (ruta absoluta)' } },
        required: ['comando', 'carpeta'],
      },
    },
    async run(args, { signal, log, params, requestApproval, access }) {
      const checked = await checkCommand(args, { access });
      // Si se acaba de pedir permiso para este comando, no se vuelve a preguntar
      if (params.approveTools !== 'No' && !checked.asked) {
        if (!requestApproval) throw new Error('Este worker no puede pedir aprobaciones');
        log(`Esperando aprobación para ejecutar «${checked.comando}» en ${checked.carpeta}`);
        const d = await requestApproval({ tool: 'ejecutar_comando', ...checked });
        if (!d.approved) throw new Error(`El usuario rechazó ejecutar «${checked.comando}»${d.comment ? `: ${d.comment}` : ''}. No lo vuelvas a intentar.`);
        log(`Aprobado por ${d.by || 'usuario'}`);
      }
      const timeoutMs = parseInt(process.env.ORQ_COMMANDS_TIMEOUT_MS, 10) || 600000;
      const { comando, codigo, ok, salida, error } = await runCommand(checked, { access, signal, log, timeoutMs });
      return JSON.stringify({ comando, codigo, ok, ...(error ? { error } : {}), salida });
    },
  },
  fecha_actual: {
    def: { name: 'fecha_actual', description: 'Devuelve la fecha y hora actuales en ISO 8601.', input_schema: { type: 'object', properties: {} } },
    run: async () => new Date().toISOString(),
  },
};

function parseJson(t) {
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw Object.assign(new Error(`El agente no devolvió JSON válido: ${t.slice(0, 200)}`), { retryable: true });
}

// Correcciones que se piden al modelo si su JSON no cumple el esquema, antes de dar el nodo por fallido
const MAX_FIXES = 2;

export default async function agent(params, input, { signal, log, providers = new Map(), setMeta = () => {}, requestApproval, access = makeAccess(), open = openChat }) {
  const p = providers.get(params.provider);
  if (!p) throw Object.assign(new Error(`Este worker no tiene el proveedor LLM «${params.provider}»`), { retryable: false });
  if (!p.enabled) throw Object.assign(new Error(`Proveedor «${p.label}» desactivado: ${p.reason}`), { retryable: false });
  const model = params.model || p.defaultModel;
  if (!model) throw Object.assign(new Error(`Elige un modelo para el proveedor «${p.label}»`), { retryable: false });

  const tools = String(params.tools || '').split(',').map(s => s.trim()).filter(Boolean).map(n => {
    if (!TOOLS[n]) throw Object.assign(new Error(`Herramienta desconocida: ${n}. Disponibles: ${Object.keys(TOOLS).join(', ')}`), { retryable: false });
    return TOOLS[n];
  });
  // El modelo ve en la descripción qué comandos exactos puede pedir
  const cmds = access.commandList().map(c => `«${c}»`).join(', ') || '(ninguno todavía)';
  for (const [i, t] of tools.entries()) if (t === TOOLS.ejecutar_comando) tools[i] = { ...t, def: { ...t.def, description: t.def.description.replace('COMANDOS', cmds) } };
  const wantsJson = params.output === 'JSON';
  // Esquema de la respuesta (solo con salida JSON): va en las instrucciones y se comprueba al final
  const schema = wantsJson && params.schema && (typeof params.schema === 'object' || String(params.schema).trim()) ? parseSchema(params.schema) : null;
  const system = [
    params.prompt || '',
    wantsJson ? 'Responde ÚNICAMENTE con JSON válido, sin texto adicional ni bloques de código.' : '',
    schema ? `El JSON debe cumplir exactamente este JSON Schema (todas las propiedades obligatorias, sin añadir otras):\n${JSON.stringify(schema, null, 2)}` : '',
  ].filter(Boolean).join('\n\n');
  // Entrada vacía = automática: el texto principal del nodo anterior
  const auto = params.input == null || params.input === '';
  const picked = auto ? mainText(input) : null;
  const src = auto ? picked.text : params.input;
  const user = (typeof src === 'string' ? src : JSON.stringify(src, null, 2)) || '(sin datos)';
  if (auto) log(`Entrada automática: ${picked.field ? `campo «${picked.field}» del nodo anterior` : 'salida del nodo anterior'}`);

  const maxChars = Number(process.env.ORQ_LLM_MAX_INPUT_CHARS || 400000);
  if (user.length + system.length > maxChars) {
    throw Object.assign(new Error(`La entrada tiene ${(user.length + system.length).toLocaleString('es')} caracteres y el límite es ${maxChars.toLocaleString('es')} (ORQ_LLM_MAX_INPUT_CHARS). Divide el documento con un Bucle o sube el límite.`), { retryable: false });
  }

  const temperature = params.temperature === '' || params.temperature == null ? undefined : Number(params.temperature);
  const maxTokens = parseInt(params.maxTokens, 10) || 2048;
  const maxTurns = parseInt(params.maxTurns, 10) || 8;
  const usage = { input: 0, output: 0 };
  const meta = () => ({
    llm: { provider: p.id, label: p.label, kind: p.kind, host: p.host, model, keyEnv: p.keyEnv, source: p.source, fingerprint: p.fingerprint },
    usage: { ...usage, total: usage.input + usage.output, ...(p.kind === 'mock' ? { estimado: true } : {}) },
  });

  const key = p.kind === 'mock' ? 'sin clave' : `clave ${p.keyEnv} (${p.sourceLabel}) · huella ${p.fingerprint}`;
  log(`LLM ${p.label}${p.host ? ` (${p.host})` : ''} · ${model} · ${key} · entrada ${user.length.toLocaleString('es')} caracteres`);

  const chat = open(p, { model, system, user, maxTokens, temperature, tools, signal, wantsJson, mockOutput: params.mockOutput, mockTools: params.mockTools });
  let fixes = 0;
  try {
    for (let turn = 0; turn < maxTurns + MAX_FIXES; turn++) {
      const r = await chat.next();
      usage.input += r.usage.input;
      usage.output += r.usage.output;

      if (r.calls.length) {
        const results = [];
        for (const c of r.calls) {
          log(`Herramienta ${c.name} ${JSON.stringify(c.input).slice(0, 140)}`);
          let out, isError = false;
          try {
            if (!tools.some(t => t.def.name === c.name)) throw new Error(`Herramienta no habilitada: ${c.name}`);
            out = await TOOLS[c.name].run(c.input || {}, { signal, log, params, requestApproval, access });
          } catch (e) { out = e.message; isError = true; log(`Herramienta ${c.name} · error: ${e.message}`); }
          results.push({ id: c.id, content: String(out), isError });
        }
        chat.pushResults(results);
        continue;
      }

      log(`${model} · ${usage.input.toLocaleString('es')} tokens de entrada · ${usage.output.toLocaleString('es')} de salida${p.kind === 'mock' ? ' (estimados)' : ''}`);
      if (r.stop === 'max_tokens') log(`Aviso: la respuesta se cortó al llegar a «Máx. tokens» (${maxTokens})`);
      if (!wantsJson) return { text: r.text };
      if (!schema) return parseJson(r.text);
      // Con esquema: si no es JSON o no lo cumple, se le devuelve al modelo con los errores concretos
      let out, problems;
      try { out = parseJson(r.text); problems = validateSchema(schema, out); }
      catch (e) { problems = [`no es JSON válido (${e.message.slice(0, 160)})`]; }
      if (!problems.length) {
        if (fixes) log(`Respuesta corregida: cumple el esquema`);
        return out;
      }
      if (fixes >= MAX_FIXES) throw Object.assign(new Error(`La respuesta no cumple el esquema JSON tras ${MAX_FIXES} correcciones: ${problems.slice(0, 5).join('; ')}`), { retryable: false });
      fixes++;
      log(`La respuesta no cumple el esquema (${problems.slice(0, 3).join('; ')}) · se pide corrección ${fixes}/${MAX_FIXES}`);
      chat.pushCorrection(r.text, `Tu respuesta no cumple el JSON Schema pedido:\n- ${problems.join('\n- ')}\n\nDevuelve de nuevo SOLO el JSON corregido, sin texto adicional.`);
    }
    throw new Error(`El agente superó ${maxTurns} turnos sin terminar`);
  } finally {
    setMeta(meta());
  }
}
