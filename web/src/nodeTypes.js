import { CAPS, TRIGGERS } from '@orquesta/shared/types';
export { CAPS, TRIGGERS };

export const NW = 212, NH = 64;

export const TYPES = {
  webhook: { label: 'Webhook', kind: 'Disparador', icon: 'ph-webhooks-logo', group: 'Disparadores', desc: 'Recibe una petición HTTP' },
  cron: { label: 'Cron', kind: 'Disparador', icon: 'ph-clock', group: 'Disparadores', desc: 'Se ejecuta según horario' },
  event: { label: 'Evento', kind: 'Disparador', icon: 'ph-broadcast', group: 'Disparadores', desc: 'POST /api/events/<tópico>' },
  agent: { label: 'Agente IA', kind: 'Agente IA', icon: 'ph-robot', group: 'Inteligencia', desc: 'Claude, GPT o Gemini' },
  node: { label: 'Proceso Node.js', kind: 'Node.js', icon: 'ph-file-js', group: 'Acciones', desc: 'Script en un worker' },
  http: { label: 'HTTP request', kind: 'HTTP', icon: 'ph-globe-simple', group: 'Acciones', desc: 'Llama a una API externa' },
  db: { label: 'Base de datos', kind: 'Base de datos', icon: 'ph-database', group: 'Acciones', desc: 'Postgres o SQLite' },
  email: { label: 'Email', kind: 'Email', icon: 'ph-envelope-simple', group: 'Acciones', desc: 'Envía un correo (SMTP)' },
  command: { label: 'Comando', kind: 'Comando', icon: 'ph-terminal-window', group: 'Acciones', desc: 'Ejecuta un comando permitido (npm test…)' },
  file: { label: 'Fichero', kind: 'Fichero', icon: 'ph-file-text', group: 'Acciones', desc: 'Lee o escribe un fichero de texto' },
  if: { label: 'Condición', kind: 'Condición', icon: 'ph-git-branch', group: 'Control', desc: 'Ramifica según una expresión' },
  loop: { label: 'Bucle', kind: 'Bucle', icon: 'ph-arrows-clockwise', group: 'Control', desc: 'Itera sobre una lista' },
  parallel: { label: 'Paralelo / merge', kind: 'Paralelo', icon: 'ph-git-fork', group: 'Control', desc: 'Divide o une ramas' },
  wait: { label: 'Esperar', kind: 'Espera', icon: 'ph-hourglass-medium', group: 'Control', desc: 'Pausa durante un tiempo' },
  subflow: { label: 'Sub-workflow', kind: 'Sub-workflow', icon: 'ph-flow-arrow', group: 'Control', desc: 'Invoca otro workflow' },
  approval: { label: 'Aprobación humana', kind: 'Humano', icon: 'ph-user-check', group: 'Humano', desc: 'Pausa hasta que alguien apruebe' },
};
export const GROUPS = ['Disparadores', 'Inteligencia', 'Acciones', 'Control', 'Humano'];

export const DEF = {
  webhook: { method: 'POST', path: '/mi-ruta', auth: 'Ninguna', respond: 'Inmediato' },
  cron: { expr: '0 8 * * 1-5', tz: 'Europe/Madrid' },
  event: { topic: 'mi.evento' },
  agent: { agentId: '', extraPrompt: '', overrideProvider: '', overrideModel: '', provider: '', model: '', prompt: '', input: '', output: 'Texto', schema: '', tools: '', approveTools: 'Sí', maxTurns: '', temperature: '', maxTokens: '2048', mockOutput: '', mockTools: '' },
  node: { code: '// $json contiene la salida del nodo anterior\nreturn { ...$json, procesado: true };' },
  http: { method: 'GET', url: 'https://', headers: '', body: '', failOnError: 'Sí' },
  db: { conn: '', query: 'SELECT 1 AS ok;', params: '' },
  email: { to: '{{ $json.email }}', subject: '', body: '', from: '' },
  command: { comando: 'npm test', carpeta: '', failOnError: 'No' },
  file: { action: 'Leer', path: '', format: 'Texto', ifMissing: 'Fallar', content: '', ifExists: 'Fallar' },
  if: { expr: '$json.valor === true' },
  loop: { items: '{{ $json.items }}', batch: '1' },
  parallel: { mode: 'Dividir' },
  wait: { duration: '5', unit: 'segundos' },
  subflow: { workflow: '', overrides: {} },
  approval: { assignee: 'equipo', channel: 'Panel', timeout: '4 h' },
};

const M = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
// [clave, etiqueta, tipo (i=input, t=textarea, s=select), opciones, mono, filas, ayuda]
export const FIELDS = {
  webhook: [['method', 'Método', 's', M], ['path', 'Ruta', 'i', 0, 1, 0, 'Se publica en /hooks<ruta>'], ['auth', 'Autenticación', 's', ['Ninguna', 'API key', 'HMAC']], ['respond', 'Responder', 's', ['Inmediato', 'Al terminar'], 0, 0, '«Al terminar» devuelve la salida final del workflow']],
  cron: [['expr', 'Expresión cron', 'i', 0, 1, 0, 'min hora día mes día-semana'], ['tz', 'Zona horaria', 'i']],
  event: [['topic', 'Tópico', 'i', 0, 1, 0, 'Se dispara con POST /api/events/<tópico>']],
  // Proveedor, modelo y respuesta simulada se pintan aparte en NodePanel (LlmFields)
  agent: [
    ['prompt', 'Instrucciones del sistema', 't', 0, 0, 6],
    ['input', 'Entrada', 't', 0, 1, 3, 'Vacío = automático: el texto del nodo anterior (el contenido de un fichero, la respuesta de otro agente…). Rellénalo solo si quieres otra cosa.'],
    ['output', 'Formato de salida', 's', ['Texto', 'JSON']],
    ['schema', 'Esquema JSON de la respuesta', 't', 0, 1, 8, 'Opcional, solo con salida JSON. Se añade a las instrucciones y se comprueba la respuesta: si no lo cumple, se le pide al modelo que la corrija (hasta 2 veces). Ej.: { "type": "object", "properties": { "sql": { "type": "string" } }, "required": ["sql"], "additionalProperties": false }'],
    ['tools', 'Herramientas', 'i', 0, 1, 0, 'Separadas por comas. Vacío = ninguna. Disponibles: listar_ficheros, buscar_ficheros, buscar_en_ficheros, leer_fichero, ejecutar_comando (si la carpeta o el comando no tienen permiso, se te pedirá), http_request (dominios de ORQ_AGENT_HTTP_ALLOW), fecha_actual'],
    ['approveTools', 'Aprobar cada comando', 's', ['Sí', 'No'], 0, 0, 'Sí = cada llamada a ejecutar_comando se para y espera tu aprobación en el panel.'],
    ['maxTurns', 'Máx. turnos con herramientas', 'i', 0, 0, 0, 'Vacío = 8. Para explorar un repositorio, 20-40.'],
    ['temperature', 'Temperatura', 'i', 0, 0, 0, 'Vacío = la del modelo'], ['maxTokens', 'Máx. tokens de salida', 'i'],
  ],
  node: [['code', 'Código (cuerpo de función async)', 't', 0, 1, 12, 'Disponibles: $json, fetch, env (ORQ_* sin secretos), console. Devuelve el resultado con return.']],
  http: [['method', 'Método', 's', M], ['url', 'URL', 'i', 0, 1], ['headers', 'Cabeceras (JSON)', 't', 0, 1, 3], ['body', 'Cuerpo', 't', 0, 1, 4, 'Texto o {{ expresión }}; los objetos se envían como JSON'], ['failOnError', 'Fallar si status ≥ 400', 's', ['Sí', 'No']]],
  db: [['conn', 'Conexión', 'CONN'], ['query', 'Consulta', 't', 0, 1, 5, 'Usa $1, $2 (pg) o ? (sqlite)'], ['params', 'Parámetros', 'i', 0, 1, 0, 'Ej: {{ [$json.email] }}']],
  command: [
    ['comando', 'Comando', 'i', 0, 1, 0, 'P. ej. npm test. Si aún no está permitido en esa carpeta, se te pedirá permiso al ejecutar.'],
    ['carpeta', 'Carpeta de trabajo', 'i', 0, 1, 0, 'Ruta absoluta. Admite {{ expresiones }}.'],
    ['failOnError', 'Fallar si el código no es 0', 's', ['No', 'Sí'], 0, 0, 'No = termina bien y entrega { ok, codigo, salida } para decidir con una Condición.'],
  ],
  file: [
    ['action', 'Acción', 's', ['Leer', 'Escribir']],
    ['path', 'Ruta absoluta', 'i', 0, 1, 0, 'Si la carpeta no tiene permiso, se te pedirá al ejecutar (pantalla Permisos). Admite {{ expresiones }}'],
    ['format', 'Leer como', 's', ['Texto', 'JSON'], 0, 0, 'Admite .txt, .md, .csv, .json y .pdf (se extrae su texto). Salida: { ruta, nombre, contenido, bytes }'],
    ['ifMissing', 'Si el fichero no existe', 's', ['Fallar', 'Devolver vacío'], 0, 0, '«Devolver vacío» entrega { contenido: null, existe: false } en lugar de fallar (útil para un fichero de estado que se crea en la primera ejecución).'],
    ['content', 'Contenido a escribir', 't', 0, 1, 4, 'Vacío = automático: el texto del nodo anterior (p. ej. la respuesta del agente). Si es un objeto, se guarda como JSON.'],
    ['ifExists', 'Si el fichero existe', 's', ['Fallar', 'Sobrescribir', 'Añadir']],
  ],
  email: [['to', 'Para', 'i', 0, 1], ['subject', 'Asunto', 'i'], ['body', 'Cuerpo', 't', 0, 0, 6, 'Vacío = automático: el texto del nodo anterior (p. ej. la respuesta del agente).'], ['from', 'Remitente', 'i', 0, 0, 0, 'Vacío = SMTP_FROM']],
  if: [['expr', 'Condición (JavaScript)', 'i', 0, 1, 0, 'Sin {{ }}. Verdadera → salida «sí»; falsa → «no». Ej.: $json.rowCount > 0 · $json.status === "OK" · $node["Inicio"].body.importe > 1000']],
  loop: [['items', 'Lista a iterar', 'i', 0, 1, 0, 'Salida «cada»: { item, index } · salida «fin»: { items }'], ['batch', 'Elementos en paralelo', 'i']],
  parallel: [['mode', 'Modo', 's', ['Dividir', 'Unir (esperar todas)', 'Unir (primera)']]],
  wait: [['duration', 'Duración', 'i'], ['unit', 'Unidad', 's', ['segundos', 'minutos', 'horas']]],
  subflow: [['workflow', 'Workflow', 's', 'WF']],
  approval: [['assignee', 'Asignado a', 'i'], ['channel', 'Notificar por', 's', ['Panel', 'Slack', 'Email']], ['timeout', 'Caduca tras', 'i']],
};

export const outPorts = type =>
  type === 'if' ? [{ port: 'true', top: 14, label: 'sí' }, { port: 'false', top: 38, label: 'no' }]
  : type === 'loop' ? [{ port: 'item', top: 14, label: 'cada' }, { port: 'done', top: 38, label: 'fin' }]
  : [{ port: 'out', top: NH / 2 - 6, label: '' }];
export const portY = (type, port) => (outPorts(type).find(p => p.port === port)?.top ?? NH / 2 - 6) + 6;

export const tileClass = t => (t === 'agent' ? 'agent' : TRIGGERS.includes(t) ? 'trigger' : '');

// Nodos con efectos fuera de Orquesta: nacen con «Requiere aprobación humana» activado
export const SIDE_EFFECT = ['email', 'http', 'db'];

export const newNode = (type, x, y) => ({
  id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
  type, name: TYPES[type].label, x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10,
  params: { ...DEF[type] }, exec: { worker: 'auto', retries: type === 'command' ? '0' : '1', timeout: type === 'agent' ? '120 s' : type === 'command' ? '10 min' : '60 s', humanReview: SIDE_EFFECT.includes(type) },
});
