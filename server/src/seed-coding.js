import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAgent, updateAgent } from './agents.js';
import { Agents, Workflows, Settings } from './db.js';

// Colección «Coding»: flujos de construcción, revisión, QA, tests y seguridad sobre un repositorio.
// Piezas reutilizables («Coding · (sub) …», se pueden ejecutar solas) que componen los flujos
// principales con el nodo Sub-workflow. Los agentes solo LEEN el repositorio (listar_ficheros,
// leer_fichero): ninguno modifica código; las propuestas se guardan para que una persona las aplique.
// Carpetas y comandos piden permiso la primera vez. Sin LLM configurado responden los simulados.

const COL = 'Coding';
const POC = path.join(os.homedir(), 'orquesta-poc');
const ex = (timeout = '60 s', extra = {}) => ({ worker: 'auto', retries: '0', timeout, ...extra });
const hook = (id, p) => ({ id, type: 'webhook', name: 'Inicio', x: 40, y: 200, params: { method: 'POST', path: p, auth: 'Ninguna', respond: 'Inmediato' }, exec: ex() });
const chain = (pfx, ids) => ids.slice(1).map((to, i) => ({ id: `${pfx}${i + 1}`, from: ids[i], to, port: 'out' }));
const test = v => ({ testInput: JSON.stringify(v, null, 2) });
const code = lines => ({ code: lines.join('\n') });
// Los agentes que leen el repositorio reciben su mapa (parámetro repo); todos los flujos empiezan en «Inicio» con body.repo
const REPO_PARAM = '{{ $node["Inicio"].body.repo }}';
const agentNode = (id, a, x, y, input, extra = {}) => ({ id, type: 'agent', name: a.name.replace(/^Coding · /, ''), x, y, exec: ex('15 min', { retries: '2' }), params: { agentId: a.id, extraPrompt: '', input, ...(a.config?.tools ? { repo: REPO_PARAM } : {}), ...extra } });
const sub = (id, name, x, y) => ({ id, type: 'subflow', name: name.replace(/^Coding · \(sub\) /, ''), x, y, exec: ex(), params: { workflow: name } });

// Repositorio por defecto: el propio Orquesta si se ejecuta desde el código fuente
function defaultRepo() {
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  return !root.includes('.asar') && fs.existsSync(path.join(root, 'package.json')) ? root : path.join(os.homedir(), 'ruta', 'a', 'tu-repo');
}

const obj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' };
const list = items => ({ type: 'array', items });
const schema = s => JSON.stringify(s, null, 2);
const READ = { tools: 'listar_ficheros, buscar_ficheros, buscar_en_ficheros, leer_fichero', approveTools: 'Sí', maxTurns: '30' };
// Cómo explorar un repositorio, como los agentes de coding: buscar antes de leer y seguir el rastro.
// Se añade a las instrucciones de los agentes que leen código.
const EXPLORAR_HEAD = 'Cómo explorar el repositorio (busca antes de leer, no abras ficheros a ciegas):';
const EXPLORAR_STEPS = [
  '2. Saca de la tarea 3-6 términos de búsqueda: entidades, acciones, rutas de API, mensajes de error. Añade sus equivalentes en inglés y variantes (p. ej. «exportar ejecuciones» → export|exportar, run|runs|ejecuci, csv).',
  '3. Usa buscar_en_ficheros con esos términos (con regex: true puedes combinarlos con |; con «incluir» limitas a *.js, src/**…) y buscar_ficheros para localizar ficheros por nombre (p. ej. **/*run*, **/*.test.*).',
  '4. Lee con leer_fichero solo alrededor de las coincidencias útiles (desde unas líneas antes), no ficheros enteros si no hace falta.',
  '5. Sigue el rastro: busca los nombres de funciones, imports, rutas y tablas que descubras hasta entender el flujo completo. Para cuando tengas lo necesario.',
];
export const EXPLORAR = [EXPLORAR_HEAD,
  '1. Si al principio tienes el «Mapa del repositorio», empieza por él: estructura, scripts e instrucciones del proyecto. No listes la raíz ni releas README/CLAUDE.md salvo que necesites un detalle que no esté en el mapa. Si no lo tienes, lee README y, si existen, CLAUDE.md / AGENTS.md / docs de arquitectura.',
  ...EXPLORAR_STEPS].join('\n');
// Versión anterior (sin mapa): para actualizar los agentes ya creados que no se hayan tocado
export const EXPLORAR_V1 = [EXPLORAR_HEAD,
  '1. Lee README y, si existen, CLAUDE.md / AGENTS.md / docs de arquitectura: dicen cómo se organiza y cómo se llaman las cosas.',
  ...EXPLORAR_STEPS].join('\n');
// Los simulados listan y buscan en la carpeta (si la reciben) para que se vean el permiso y las herramientas
const MOCK_LIST = '{{ $json.body?.repo ? [{ name: "listar_ficheros", input: { ruta: $json.body.repo, profundidad: 2 } }, { name: "buscar_en_ficheros", input: { ruta: $json.body.repo, patron: "export|function", regex: true, maxResultados: 10 } }] : [] }}';
const base = { provider: '', model: '', temperature: '0', maxTokens: '4096', output: 'JSON' };

// ── Agentes (pantalla Agentes)
export const CODING_AGENTS = {
  revisor: {
    name: 'Coding · Revisor de código',
    description: 'Revisa código (el repositorio o un diff/propuesta) y devuelve hallazgos por severidad.',
    config: { ...base, ...READ, mockTools: MOCK_LIST,
      prompt: 'Eres un desarrollador senior haciendo code review. Si recibes un diff o una propuesta de cambios, revisa eso; si no, explora el repositorio centrándote en el foco indicado (como mucho 20 ficheros leídos). Busca errores de lógica, manejo de errores, duplicación, nombres confusos y código difícil de mantener. Cita solo ficheros que hayas visto. Veredicto «ok» si no hay hallazgos de severidad alta.' + '\n\n' + EXPLORAR,
      schema: schema(obj({ veredicto: { enum: ['ok', 'cambios'] }, resumen: str, hallazgos: list(obj({ severidad: { enum: ['alta', 'media', 'baja'] }, fichero: str, problema: str, propuesta: str }, ['severidad', 'problema'])) }, ['veredicto', 'resumen', 'hallazgos'])),
      mockOutput: '{{ ({ veredicto: "ok", resumen: "(simulado) Revisión sin LLM: no se ha analizado código.", hallazgos: [{ severidad: "baja", fichero: "README.md", problema: "(simulado) Ejemplo de hallazgo", propuesta: "(simulado) Configura un LLM para una revisión real" }] }) }}' },
  },
  seguridad: {
    name: 'Coding · Auditor de seguridad',
    description: 'Analiza el resultado de npm audit y el código en busca de riesgos de seguridad.',
    config: { ...base, ...READ, mockTools: '',
      prompt: 'Eres un auditor de seguridad de aplicaciones. Recibes el resultado de «npm audit» y la carpeta del repositorio. Resume las vulnerabilidades de dependencias (solo las de producción) y busca en el código los puntos sensibles (p. ej. buscar_en_ficheros con «exec|spawn|eval|query\(|password|secret|token» y regex: true): entradas sin validar, inyección (SQL, comandos, rutas), secretos en el código, permisos y configuración insegura. Cita solo ficheros que hayas leído. No inventes CVE.' + '\n\n' + EXPLORAR,
      schema: schema(obj({ riesgo: { enum: ['alto', 'medio', 'bajo', 'ninguno'] }, resumen: str, vulnerabilidades: list(obj({ severidad: { enum: ['alta', 'media', 'baja'] }, origen: { enum: ['dependencia', 'codigo', 'configuracion', 'secretos'] }, detalle: str, recomendacion: str }, ['severidad', 'origen', 'detalle'])) }, ['riesgo', 'resumen', 'vulnerabilidades'])),
      mockOutput: '{{ ({ riesgo: $json.codigo === 0 ? "ninguno" : "medio", resumen: "(simulado) npm audit terminó con código " + $json.codigo + ". Sin LLM no se ha revisado el código.", vulnerabilidades: $json.codigo === 0 ? [] : [{ severidad: "media", origen: "dependencia", detalle: "(simulado) npm audit informa de vulnerabilidades", recomendacion: "(simulado) Revisa la salida de npm audit" }] }) }}' },
  },
  qa: {
    name: 'Coding · Ingeniero QA',
    description: 'Propone un plan de pruebas para un objetivo (feature, cambio o módulo) y detecta huecos de cobertura.',
    config: { ...base, ...READ, mockTools: MOCK_LIST,
      prompt: 'Eres ingeniero de QA. Para el objetivo indicado (una feature, un cambio o un módulo), localiza el código y los tests existentes relacionados (busca también **/*.test.*, **/*spec*), y propone los casos de prueba necesarios: caso feliz, errores y límites. Marca «existe»: true si ya hay un test que lo cubre. En «huecos», lo que no está probado y debería.' + '\n\n' + EXPLORAR,
      schema: schema(obj({ resumen: str, casos: list(obj({ titulo: str, tipo: { enum: ['unitario', 'integracion', 'e2e', 'manual'] }, pasos: str, esperado: str, existe: { type: 'boolean' } }, ['titulo', 'tipo', 'esperado', 'existe'])), huecos: list(str) }, ['resumen', 'casos', 'huecos'])),
      mockOutput: '{{ ({ resumen: "(simulado) Plan de pruebas sin LLM para: " + ($json.body?.objetivo || "el repositorio"), casos: [{ titulo: "(simulado) Caso feliz", tipo: "unitario", pasos: "Llamar con datos válidos", esperado: "Devuelve el resultado esperado", existe: false }, { titulo: "(simulado) Entrada inválida", tipo: "unitario", pasos: "Llamar con datos vacíos", esperado: "Error claro", existe: false }], huecos: ["(simulado) Configura un LLM para un análisis real"] }) }}' },
  },
  arquitecto: {
    name: 'Coding · Arquitecto',
    description: 'Convierte una feature en un plan técnico sobre el repositorio real (ficheros, pasos, riesgos).',
    config: { ...base, ...READ, mockTools: MOCK_LIST,
      prompt: 'Eres el arquitecto del proyecto. Recibes una feature y la carpeta del repositorio. Explora el código relacionado (como mucho 20 ficheros leídos) y diseña cómo implementarla respetando la estructura y el estilo existentes. Cita solo ficheros que existan o que haya que crear.' + '\n\n' + EXPLORAR,
      schema: schema(obj({ resumen: str, ficheros: list(obj({ fichero: str, cambio: { enum: ['crear', 'modificar', 'borrar'] }, detalle: str }, ['fichero', 'cambio', 'detalle'])), pasos: list(str), riesgos: list(str) }, ['resumen', 'ficheros', 'pasos'])),
      mockOutput: '{{ ({ resumen: "(simulado) Plan para: " + $json.body.feature.slice(0, 80), ficheros: [{ fichero: "src/ejemplo.js", cambio: "modificar", detalle: "(simulado) Punto de entrada de la feature" }, { fichero: "test/ejemplo.test.js", cambio: "crear", detalle: "(simulado) Tests de la feature" }], pasos: ["(simulado) Paso 1", "(simulado) Paso 2"], riesgos: ["(simulado) Sin LLM no hay análisis real"] }) }}' },
  },
  desarrollador: {
    name: 'Coding · Desarrollador',
    description: 'Escribe la propuesta de cambios (código por fichero) siguiendo un plan técnico. No modifica el repositorio.',
    config: { ...base, output: 'Texto', schema: '', tools: READ.tools, approveTools: 'Sí', maxTurns: '30', maxTokens: '8192', mockTools: '',
      prompt: 'Eres desarrollador del proyecto. Recibes una feature y su plan técnico. Localiza y lee los ficheros a modificar y escribe la propuesta de cambios en Markdown: por cada fichero, un apartado «## ruta/del/fichero» con el código nuevo o un bloque ```diff con los cambios, y una línea explicando el porqué. Respeta el estilo del código existente e incluye los tests. No digas que has aplicado nada: es una propuesta para revisar.' + '\n\n' + EXPLORAR,
      mockOutput: '{{ "# Propuesta de cambios (simulada)\\n\\n" + $json.ficheros.map(f => "## " + f.fichero + "\\n\\n```diff\\n+ // (simulado) " + f.detalle + "\\n```\\n").join("\\n") }}' },
  },
  explorador: {
    name: 'Coding · Explorador',
    description: 'Responde preguntas sobre un repositorio buscando en el código (como un agente de coding) y cuenta qué buscó y qué leyó.',
    config: { ...base, ...READ, maxTurns: '25', mockTools: '{{ [{ name: "buscar_en_ficheros", input: { ruta: $json.body.repo, patron: $json.body.pregunta.split(/[^\\p{L}\\p{N}_]+/u).filter(w => w.length > 5).slice(0, 3).join("|") || "export", regex: true, incluir: "*.js,*.md", maxResultados: 10 } }] }}',
      prompt: 'Eres un desarrollador que conoce bien cómo explorar código. Responde a la pregunta sobre el repositorio basándote SOLO en lo que encuentres en él. En «busquedas», anota cada búsqueda que hiciste (patrón y para qué); en «ficheros», los ficheros y líneas que leíste y por qué eran relevantes. Si no encuentras la respuesta, dilo en «respuesta» y explica qué buscaste.' + '\n\n' + EXPLORAR,
      schema: schema(obj({ respuesta: str, ficheros: list(obj({ fichero: str, lineas: str, motivo: str }, ['fichero', 'motivo'])), busquedas: list(str) }, ['respuesta', 'ficheros', 'busquedas'])),
      mockOutput: '{{ ({ respuesta: "(simulado) Sin LLM no hay respuesta real: mira en los logs la búsqueda que ha hecho el simulado con las palabras de la pregunta.", ficheros: [], busquedas: ["(simulado) palabras largas de la pregunta"] }) }}' },
  },
  calidad: {
    name: 'Coding · Responsable de calidad',
    description: 'Consolida los informes de tests, revisión y seguridad en un veredicto de release.',
    config: { ...base, tools: '', approveTools: 'Sí', maxTurns: '', maxTokens: '2048', mockTools: '',
      prompt: 'Eres el responsable de calidad. Recibes los resultados de varias comprobaciones (tipo: tests, revision, seguridad). Decide: «no apto» si fallan los tests, hay riesgo de seguridad alto o hallazgos de severidad alta; «apto con cambios» si hay hallazgos medios; «apto» si no. En «bloqueantes», lo que impide la release; en «recomendaciones», lo demás, priorizado.',
      schema: schema(obj({ veredicto: { enum: ['apto', 'apto con cambios', 'no apto'] }, resumen: str, bloqueantes: list(str), recomendaciones: list(str) }, ['veredicto', 'resumen', 'bloqueantes', 'recomendaciones'])),
      mockOutput: '{{ (() => { const e = $json.entradas || []; const t = e.find(x => x.tipo === "tests"), s = e.find(x => x.tipo === "seguridad"), r = e.find(x => x.tipo === "revision"); const b = []; if (t && !t.ok) b.push("Los tests fallan (" + t.comando + ")"); if (s && s.riesgo === "alto") b.push("Riesgo de seguridad alto"); if (r && r.hallazgos.some(h => h.severidad === "alta")) b.push("Hallazgos de severidad alta en la revisión"); return { veredicto: b.length ? "no apto" : "apto", resumen: "(simulado) " + e.length + " comprobaciones: " + e.map(x => x.tipo).join(", "), bloqueantes: b, recomendaciones: ["(simulado) Revisa los hallazgos de cada informe"] }; })() }}' },
  },
};
const A = CODING_AGENTS;
const agents = () => Object.fromEntries(Object.entries(A).map(([k, def]) => [k, ensureAgent(def)]));

const SUB = { tests: 'Coding · (sub) Tests', revision: 'Coding · (sub) Revisión de código', seguridad: 'Coding · (sub) Seguridad', qa: 'Coding · (sub) Plan de QA' };
const REPO = defaultRepo();

export const CODING = {
  // ── Piezas reutilizables. Entrada común: { body: { repo, … } }. Salida con «tipo» para identificarla.
  codingSubTests() {
    return {
      name: SUB.tests, collection: COL,
      description: 'Pieza reutilizable: ejecuta los tests del repositorio (body.tests, por defecto «npm test») y devuelve { tipo: "tests", ok, codigo, comando, resumen } con el final de la salida. Que fallen no hace fallar el flujo: lo decide quien la usa.',
      graph: {
        settings: test({ body: { repo: REPO, tests: 'npm test' } }),
        nodes: [hook('t1', '/coding-sub-tests'),
          { id: 't2', type: 'command', name: 'Ejecutar tests', x: 300, y: 200, exec: ex('15 min'), params: { comando: '{{ $json.body.tests || "npm test" }}', carpeta: '{{ $json.body.repo }}', failOnError: 'No' } },
          { id: 't3', type: 'node', name: 'Resultado tests', x: 560, y: 200, exec: ex('10 s'), params: code([
            "return { tipo: 'tests', ok: $json.ok, codigo: $json.codigo, comando: $json.comando, resumen: $json.salida.split('\\n').slice(-40).join('\\n') };",
          ]) }],
        edges: chain('te', ['t1', 't2', 't3']),
      },
    };
  },

  codingSubRevision() {
    const a = agents();
    return {
      name: SUB.revision, collection: COL,
      description: 'Pieza reutilizable: el «Revisor de código» revisa el repositorio (body.repo, con body.foco opcional) o, si lo recibe, un diff (body.diff). Devuelve { tipo: "revision", veredicto, resumen, hallazgos }.',
      graph: {
        settings: test({ body: { repo: REPO, foco: 'el motor de ejecución (server/src/engine.js)' } }),
        nodes: [hook('r1', '/coding-sub-revision'),
          agentNode('r2', a.revisor, 300, 200, 'Repositorio: {{ $json.body.repo }}\nFoco: {{ $json.body.foco || "todo el código" }}{{ $json.body.diff ? "\\n\\nDiff a revisar:\\n" + $json.body.diff : "" }}'),
          { id: 'r3', type: 'node', name: 'Resultado revisión', x: 560, y: 200, exec: ex('10 s'), params: code(["return { tipo: 'revision', ...$json };"]) }],
        edges: chain('re', ['r1', 'r2', 'r3']),
      },
    };
  },

  codingSubSeguridad() {
    const a = agents();
    return {
      name: SUB.seguridad, collection: COL,
      description: 'Pieza reutilizable: ejecuta «npm audit» (dependencias de producción) y el «Auditor de seguridad» lo analiza junto al código. Devuelve { tipo: "seguridad", riesgo, resumen, vulnerabilidades }.',
      graph: {
        settings: test({ body: { repo: REPO } }),
        nodes: [hook('s1', '/coding-sub-seguridad'),
          { id: 's2', type: 'command', name: 'npm audit', x: 300, y: 200, exec: ex('5 min'), params: { comando: 'npm audit --omit=dev --json', carpeta: '{{ $json.body.repo }}', failOnError: 'No' } },
          agentNode('s3', a.seguridad, 560, 200, 'Repositorio: {{ $node["Inicio"].body.repo }}\n\nResultado de npm audit (código {{ $json.codigo }}):\n{{ $json.salida }}'),
          { id: 's4', type: 'node', name: 'Resultado seguridad', x: 820, y: 200, exec: ex('10 s'), params: code(["return { tipo: 'seguridad', ...$json };"]) }],
        edges: chain('se', ['s1', 's2', 's3', 's4']),
      },
    };
  },

  codingSubQa() {
    const a = agents();
    return {
      name: SUB.qa, collection: COL,
      description: 'Pieza reutilizable: el «Ingeniero QA» propone casos de prueba para un objetivo (body.objetivo: feature, cambio o módulo; body.diff opcional) y marca los huecos de cobertura. Devuelve { tipo: "qa", resumen, casos, huecos }.',
      graph: {
        settings: test({ body: { repo: REPO, objetivo: 'los permisos de carpetas y comandos (worker/src/access.js)' } }),
        nodes: [hook('q1', '/coding-sub-qa'),
          agentNode('q2', a.qa, 300, 200, 'Repositorio: {{ $json.body.repo }}\nObjetivo: {{ $json.body.objetivo }}{{ $json.body.diff ? "\\n\\nCambio a probar:\\n" + $json.body.diff : "" }}'),
          { id: 'q3', type: 'node', name: 'Resultado QA', x: 560, y: 200, exec: ex('10 s'), params: code(["return { tipo: 'qa', ...$json };"]) }],
        edges: chain('qe', ['q1', 'q2', 'q3']),
      },
    };
  },

  // ── Flujos principales
  codingExplorar() {
    const a = agents();
    return {
      name: 'Coding · Explorar el repositorio (búsqueda)', collection: COL,
      description: 'Pregunta lo que quieras sobre el código: el «Explorador» busca con buscar_ficheros / buscar_en_ficheros, lee solo las zonas relevantes y responde indicando qué búsquedas hizo y qué ficheros y líneas leyó. Sirve para ver cómo decide qué buscar (mira también las llamadas a herramientas en los logs). Cambia «repo» y «pregunta» en «Datos de prueba».',
      graph: {
        settings: test({ body: { repo: REPO, pregunta: '¿Dónde se comprueban los permisos de una carpeta antes de leer un fichero, y qué pasa si no hay permiso?' } }),
        nodes: [hook('x1', '/coding-explorar'),
          agentNode('x2', a.explorador, 300, 200, 'Repositorio: {{ $json.body.repo }}\n\nPregunta: {{ $json.body.pregunta }}')],
        edges: chain('xe', ['x1', 'x2']),
      },
    };
  },

  codingPipeline() {
    const a = agents();
    const informe = '{{ (() => { const c = $json, e = $node["Unir resultados"].entradas, t = e.find(x => x.tipo === "tests") || {}, r = e.find(x => x.tipo === "revision") || { hallazgos: [] }, s = e.find(x => x.tipo === "seguridad") || { vulnerabilidades: [] }; return ["# Informe de calidad", "", "Repositorio: " + $node["Inicio"].body.repo, "Fecha: " + new Date().toLocaleString("es-ES"), "", "## Veredicto: " + c.veredicto, "", c.resumen, "", "### Bloqueantes", ...(c.bloqueantes.length ? c.bloqueantes.map(x => "- " + x) : ["- Ninguno"]), "", "### Recomendaciones", ...c.recomendaciones.map(x => "- " + x), "", "## Tests", "`" + t.comando + "` → " + (t.ok ? "OK" : "FALLAN (código " + t.codigo + ")"), "", "## Revisión de código (" + r.veredicto + ")", r.resumen, ...r.hallazgos.map(h => "- **" + h.severidad + "** " + (h.fichero ? "`" + h.fichero + "` " : "") + h.problema + (h.propuesta ? " → " + h.propuesta : "")), "", "## Seguridad (riesgo " + s.riesgo + ")", s.resumen, ...s.vulnerabilidades.map(v => "- **" + v.severidad + "** [" + v.origen + "] " + v.detalle + (v.recomendacion ? " → " + v.recomendacion : ""))].join("\\n"); })() }}';
    return {
      name: 'Coding · Pipeline de calidad', collection: COL,
      description: 'Tests, revisión de código y seguridad EN PARALELO (cada uno es un sub-workflow), el «Responsable de calidad» consolida un veredicto, se guarda el informe en Markdown y, si no es «no apto», se pide validar la release. La primera vez pedirá permisos (comandos y lectura del repo, escritura del informe).',
      graph: {
        settings: test({ body: { repo: REPO, foco: 'todo el código', tests: 'npm test', informe: path.join(POC, 'informe-calidad.md') } }),
        nodes: [hook('p1', '/coding-pipeline'),
          { id: 'p2', type: 'parallel', name: 'En paralelo', x: 300, y: 200, exec: ex(), params: { mode: 'Dividir' } },
          sub('p3', SUB.tests, 560, 60), sub('p4', SUB.revision, 560, 200), sub('p5', SUB.seguridad, 560, 340),
          { id: 'p6', type: 'parallel', name: 'Unir resultados', x: 820, y: 200, exec: ex(), params: { mode: 'Unir (esperar todas)' } },
          agentNode('p7', a.calidad, 1080, 200, 'Resultados de las comprobaciones:\n{{ JSON.stringify($json.entradas, null, 2) }}'),
          { id: 'p8', type: 'file', name: 'Guardar informe', x: 1340, y: 200, exec: ex(), params: { action: 'Escribir', path: '{{ $node["Inicio"].body.informe }}', format: 'Texto', ifMissing: 'Fallar', ifExists: 'Sobrescribir', content: informe } },
          { id: 'p9', type: 'if', name: '¿Se puede publicar?', x: 1600, y: 200, exec: ex(), params: { expr: '$node["Responsable de calidad"].veredicto !== "no apto"' } },
          { id: 'p10', type: 'approval', name: 'Validar release', x: 1860, y: 120, exec: ex(), params: { assignee: 'responsable de release', channel: 'Panel', timeout: '1 d' } }],
        edges: [{ id: 'pe1', from: 'p1', to: 'p2', port: 'out' },
          { id: 'pe2', from: 'p2', to: 'p3', port: 'out' }, { id: 'pe3', from: 'p2', to: 'p4', port: 'out' }, { id: 'pe4', from: 'p2', to: 'p5', port: 'out' },
          { id: 'pe5', from: 'p3', to: 'p6', port: 'out' }, { id: 'pe6', from: 'p4', to: 'p6', port: 'out' }, { id: 'pe7', from: 'p5', to: 'p6', port: 'out' },
          { id: 'pe8', from: 'p6', to: 'p7', port: 'out' }, { id: 'pe9', from: 'p7', to: 'p8', port: 'out' }, { id: 'pe10', from: 'p8', to: 'p9', port: 'out' },
          { id: 'pe11', from: 'p9', to: 'p10', port: 'true' }],
      },
    };
  },

  codingFeature() {
    const a = agents();
    const I = '$node["Inicio"].body';
    return {
      name: 'Coding · Construir feature', collection: COL,
      description: 'El «Arquitecto» planifica sobre el código real, el «Desarrollador» escribe la propuesta de cambios (no toca el repositorio), el «Revisor de código» la revisa, y la propuesta con su revisión se guarda en Markdown para que una persona la valide y la aplique.',
      graph: {
        settings: test({ body: { repo: REPO, feature: 'Exportar el listado de ejecuciones a CSV, respetando los filtros de workflow y estado.', propuesta: path.join(POC, 'propuesta-feature.md') } }),
        nodes: [hook('f1', '/coding-feature'),
          agentNode('f2', a.arquitecto, 300, 200, 'Repositorio: {{ $json.body.repo }}\n\nFeature:\n{{ $json.body.feature }}'),
          agentNode('f3', a.desarrollador, 560, 200, `{{ "Repositorio: " + ${I}.repo + "\\n\\nFeature:\\n" + ${I}.feature + "\\n\\nPlan técnico:\\n" + JSON.stringify($json, null, 2) }}`),
          agentNode('f4', a.revisor, 820, 200, `{{ "Feature: " + ${I}.feature + "\\n\\nPropuesta de cambios a revisar:\\n" + $json.text }}`, { extraPrompt: 'Revisa SOLO la propuesta de cambios que recibes (no el repositorio entero): que cumpla la feature, que no rompa nada evidente y que incluya tests.' }),
          { id: 'f5', type: 'file', name: 'Guardar propuesta', x: 1080, y: 200, exec: ex(), params: { action: 'Escribir', path: `{{ ${I}.propuesta }}`, format: 'Texto', ifMissing: 'Fallar', ifExists: 'Sobrescribir',
            content: '{{ $node["Desarrollador"].text + "\\n\\n---\\n\\n# Revisión (" + $json.veredicto + ")\\n\\n" + $json.resumen + "\\n\\n" + $json.hallazgos.map(h => "- **" + h.severidad + "** " + (h.fichero ? "`" + h.fichero + "` " : "") + h.problema + (h.propuesta ? " → " + h.propuesta : "")).join("\\n") }}' } },
          { id: 'f6', type: 'approval', name: 'Validar y aplicar', x: 1340, y: 200, exec: ex(), params: { assignee: 'desarrollador', channel: 'Panel', timeout: '1 d' } }],
        edges: chain('fe', ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']),
      },
    };
  },

  codingCommit() {
    return {
      name: 'Coding · Revisar último commit', collection: COL,
      description: 'Obtiene el diff del último commit (git) y, en paralelo, lo revisa y propone las pruebas que necesita, reutilizando los sub-workflows de revisión y QA. Necesita un repositorio git con al menos dos commits.',
      graph: {
        settings: test({ body: { repo: REPO } }),
        nodes: [hook('c1', '/coding-commit'),
          { id: 'c2', type: 'command', name: 'git diff', x: 300, y: 200, exec: ex('60 s'), params: { comando: 'git diff HEAD~1', carpeta: '{{ $json.body.repo }}', failOnError: 'Sí' } },
          { id: 'c3', type: 'if', name: '¿Hay cambios?', x: 560, y: 200, exec: ex(), params: { expr: '$json.salida.trim().length > 0' } },
          { id: 'c4', type: 'node', name: 'Preparar', x: 820, y: 120, exec: ex('10 s'), params: code([
            '// Misma forma de entrada que los sub-workflows: { body: { repo, … } }',
            "return { body: { repo: $json.carpeta, foco: 'los cambios del último commit', objetivo: 'los cambios del último commit', diff: $json.salida } };",
          ]) },
          { id: 'c5', type: 'parallel', name: 'En paralelo', x: 1080, y: 120, exec: ex(), params: { mode: 'Dividir' } },
          sub('c6', SUB.revision, 1340, 40), sub('c7', SUB.qa, 1340, 200),
          { id: 'c8', type: 'parallel', name: 'Unir', x: 1600, y: 120, exec: ex(), params: { mode: 'Unir (esperar todas)' } },
          { id: 'c9', type: 'node', name: 'Informe', x: 1860, y: 120, exec: ex('10 s'), params: code([
            "const r = $json.entradas.find(x => x.tipo === 'revision'), q = $json.entradas.find(x => x.tipo === 'qa');",
            'return { veredicto: r.veredicto, revision: r, pruebas: q.casos, huecos: q.huecos };',
          ]) }],
        edges: [...chain('ce', ['c1', 'c2', 'c3']), { id: 'ce3', from: 'c3', to: 'c4', port: 'true' }, { id: 'ce4', from: 'c4', to: 'c5', port: 'out' },
          { id: 'ce5', from: 'c5', to: 'c6', port: 'out' }, { id: 'ce6', from: 'c5', to: 'c7', port: 'out' }, { id: 'ce7', from: 'c6', to: 'c8', port: 'out' }, { id: 'ce8', from: 'c7', to: 'c8', port: 'out' }, { id: 'ce9', from: 'c8', to: 'c9', port: 'out' }],
      },
    };
  },
};

// Actualiza lo creado por versiones anteriores (los ejemplos se crean una sola vez). v2: mapa del repo.
// Solo toca lo que el usuario no ha cambiado: el prompt de un agente si sigue siendo el original, las
// herramientas del Desarrollador si siguen siendo las de antes, y añade el parámetro repo a los nodos
// Agente de la colección que no lo tengan.
export function upgradeCoding() {
  if ((Settings.get('codingVersion', 1) || 1) >= 2) return;
  const readers = new Set();
  for (const def of Object.values(A)) {
    const cur = Agents.findByName(def.name);
    if (!cur) continue;
    const patch = {};
    if (def.config.prompt && cur.config.prompt === def.config.prompt.replace(EXPLORAR, EXPLORAR_V1)) patch.prompt = def.config.prompt;
    if (def === A.desarrollador && cur.config.tools === 'buscar_ficheros, buscar_en_ficheros, leer_fichero') patch.tools = READ.tools;
    if (Object.keys(patch).length) updateAgent(cur.id, { config: patch });
    if (patch.tools || cur.config.tools) readers.add(cur.id);
  }
  for (const w of Workflows.list().filter(x => x.collection === COL)) {
    let changed = false;
    const nodes = (w.graph?.nodes || []).map(n => {
      if (n.type !== 'agent' || !readers.has(n.params?.agentId) || 'repo' in (n.params || {})) return n;
      changed = true;
      return { ...n, params: { ...n.params, repo: REPO_PARAM } };
    });
    if (changed) Workflows.update(w.id, { graph: { ...w.graph, nodes } });
  }
  Settings.set('codingVersion', 2);
}
