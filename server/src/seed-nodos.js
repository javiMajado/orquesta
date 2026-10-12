import os from 'node:os';
import path from 'node:path';
import { ensureAgent } from './agents.js';

// Colección «Ejemplos de nodos»: un workflow por tipo de nodo, para ver cómo funciona cada uno.
// Todos se lanzan con «Ejecutar» y sus «Datos de prueba»; ninguno está activo salvo el receptor de
// eventos (que debe estarlo para recibirlos). Los agentes usan el proveedor por defecto
// (ORQ_LLM_DEFAULT; sin él, el simulado, sin coste), y su «Respuesta simulada» cumple su esquema.

const COL = 'Ejemplos de nodos';
const POC = path.join(os.homedir(), 'orquesta-poc');
const TOPIC = 'ejemplo.saludo';

const ex = (timeout = '60 s', extra = {}) => ({ worker: 'auto', retries: '0', timeout, ...extra });
const hook = (id, p) => ({ id, type: 'webhook', name: 'Inicio', x: 40, y: 200, params: { method: 'POST', path: p, auth: 'Ninguna', respond: 'Al terminar' }, exec: ex() });
const chain = (pfx, ids) => ids.slice(1).map((to, i) => ({ id: `${pfx}${i + 1}`, from: ids[i], to, port: 'out' }));
const test = v => ({ testInput: JSON.stringify(v, null, 2) });
const code = lines => ({ code: lines.join('\n') });
const wf = (name, description, settings, nodes, edges, extra = {}) => ({ name: `Nodo · ${name}`, collection: COL, description, active: false, graph: { settings, nodes, edges }, ...extra });

// Agente guardado que usa el ejemplo de Agente IA (aparece en la pantalla Agentes)
const CLASIFICADOR = {
  name: 'Ejemplo · Clasificador de textos',
  description: 'Clasifica un texto (tono, temas, urgencia) con salida JSON y esquema. Lo usa «Nodo · Agente IA».',
  config: {
    provider: '', model: '', output: 'JSON', tools: '', approveTools: 'Sí', maxTurns: '', temperature: '0', maxTokens: '1024', mockTools: '',
    prompt: 'Clasifica el texto que recibes. «tono»: positivo, neutro o negativo. «temas»: de 1 a 3 temas cortos en minúsculas. «urgente»: true solo si pide acción inmediata.',
    schema: JSON.stringify({
      type: 'object',
      properties: { tono: { enum: ['positivo', 'neutro', 'negativo'] }, temas: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 }, urgente: { type: 'boolean' } },
      required: ['tono', 'temas', 'urgente'],
      additionalProperties: false,
    }, null, 2),
    mockOutput: '{{ ({ tono: /error|falla|urgente|no funciona/i.test($json.text || "") ? "negativo" : "neutro", temas: ["ejemplo"], urgente: /urgente/i.test($json.text || "") }) }}',
  },
};

export const NODOS = {
  nodoNode() {
    return wf('Proceso Node.js', 'Un script recibe lo que llega del nodo anterior en $json, calcula y devuelve un objeto con return (su salida). console.log escribe en los logs. Mira la tabla en la salida.',
      test({ body: { ventas: [{ producto: 'Teclado', unidades: 12, precio: 24.9 }, { producto: 'Ratón', unidades: 30, precio: 12.5 }, { producto: 'Monitor', unidades: 4, precio: 189 }] } }),
      [hook('a1', '/nodo-node'),
        { id: 'a2', type: 'node', name: 'Calcular estadísticas', x: 300, y: 200, exec: ex('10 s'), params: code([
          '// $json = lo que entrega el nodo anterior (aquí, el webhook: { body: { ventas } })',
          'const filas = $json.body.ventas.map(v => ({ ...v, importe: +(v.unidades * v.precio).toFixed(2) }));',
          'const total = filas.reduce((s, f) => s + f.importe, 0);',
          'console.log(`Procesadas ${filas.length} ventas`);',
          'return { total: +total.toFixed(2), masVendido: filas.reduce((a, b) => (b.importe > a.importe ? b : a)).producto, filas };',
        ]) }],
      chain('ae', ['a1', 'a2']));
  },

  nodoAgente() {
    const clasif = ensureAgent(CLASIFICADOR);
    return wf('Agente IA', 'Dos agentes encadenados. «Resumir» se configura en el propio nodo (salida Texto). «Clasificar» usa un agente guardado (pantalla Agentes) con salida JSON y esquema, y su Entrada está vacía: recibe automáticamente el texto del nodo anterior.',
      test({ body: { texto: 'Desde esta mañana la exportación de facturas falla con un error 500. Es urgente porque cerramos el mes el viernes y finanzas necesita los informes.' } }),
      [hook('b1', '/nodo-agente'),
        { id: 'b2', type: 'agent', name: 'Resumir', x: 300, y: 200, exec: ex('120 s', { retries: '2' }), params: {
          provider: '', model: '', output: 'Texto', schema: '', tools: '', approveTools: 'Sí', maxTurns: '', temperature: '0', maxTokens: '1024', mockTools: '',
          prompt: 'Resume el texto en una sola frase, en español.', input: '{{ $json.body.texto }}',
          mockOutput: '{{ "(simulado) " + $json.body.texto.split(".")[0] + "." }}' } },
        { id: 'b3', type: 'agent', name: clasif.name, x: 560, y: 200, exec: ex('120 s', { retries: '2' }), params: { agentId: clasif.id, extraPrompt: '', input: '' } }],
      chain('be', ['b1', 'b2', 'b3']));
  },

  nodoBd() {
    return wf('Base de datos', 'Elige tu conexión en «Consultar» (pantalla Conexiones; mejor de solo lectura). La consulta usa un parámetro del body: $1 en PostgreSQL (en SQLite sería ?). Se para para que la revises antes de ejecutarla. Salida: { rows, rowCount }.',
      test({ body: { minimo: 1 } }),
      [hook('c1', '/nodo-bd'),
        { id: 'c2', type: 'db', name: 'Consultar', x: 300, y: 200, exec: ex('30 s', { humanReview: true }), params: { conn: '', query: 'SELECT 1 AS ok, CURRENT_TIMESTAMP AS ahora WHERE 1 >= $1', params: '{{ [$json.body.minimo] }}' } },
        { id: 'c3', type: 'if', name: '¿Trae filas?', x: 560, y: 200, exec: ex(), params: { expr: '$json.rowCount > 0' } },
        { id: 'c4', type: 'node', name: 'Usar filas', x: 820, y: 120, exec: ex('10 s'), params: code(['return { primera: $json.rows[0], total: $json.rowCount };']) },
        { id: 'c5', type: 'node', name: 'Sin datos', x: 820, y: 290, exec: ex('10 s'), params: code(["return { mensaje: 'La consulta no devolvió filas' };"]) }],
      [...chain('ce', ['c1', 'c2', 'c3']), { id: 'ce3', from: 'c3', to: 'c4', port: 'true' }, { id: 'ce4', from: 'c3', to: 'c5', port: 'false' }]);
  },

  nodoHttp() {
    return wf('HTTP request', 'GET a una API pública de ejemplo (JSONPlaceholder): la respuesta llega en $json.body. Un script la transforma (mira la tabla en su salida) y un POST de prueba se revisa antes de enviarse (la API simula la creación, no guarda nada).',
      test({}),
      [hook('d1', '/nodo-http'),
        { id: 'd2', type: 'http', name: 'Pedir usuarios', x: 300, y: 200, exec: ex('30 s'), params: { method: 'GET', url: 'https://jsonplaceholder.typicode.com/users', headers: '', body: '', failOnError: 'Sí' } },
        { id: 'd3', type: 'node', name: 'Formatear usuarios', x: 560, y: 200, exec: ex('10 s'), params: code([
          '// $json = respuesta del HTTP: { status, headers, body }',
          'const usuarios = $json.body.map(u => ({ nombre: u.name, email: u.email, ciudad: u.address.city }));',
          'return { total: usuarios.length, usuarios };',
        ]) },
        { id: 'd4', type: 'http', name: 'Crear post (prueba)', x: 820, y: 200, exec: ex('30 s', { humanReview: true }), params: {
          method: 'POST', url: 'https://jsonplaceholder.typicode.com/posts', headers: '', failOnError: 'Sí',
          body: '{{ ({ title: "Usuarios importados", body: $json.usuarios.map(u => u.nombre).join(", "), userId: 1 }) }}' } }],
      chain('de', ['d1', 'd2', 'd3', 'd4']));
  },

  nodoFichero() {
    return wf('Fichero', 'Escribe un texto en un fichero y lo vuelve a leer. La primera vez pide permiso sobre la carpeta («Permitir siempre» lo guarda en Permisos). La carpeta debe existir: cambia la ruta en «Datos de prueba».',
      test({ body: { ruta: path.join(POC, 'ejemplo-fichero.txt') } }),
      [hook('e1', '/nodo-fichero'),
        { id: 'e2', type: 'file', name: 'Escribir', x: 300, y: 200, exec: ex('30 s'), params: { action: 'Escribir', path: '{{ $json.body.ruta }}', format: 'Texto', ifMissing: 'Fallar', ifExists: 'Sobrescribir', content: '{{ "Hola desde Orquesta.\\nEscrito el " + new Date().toLocaleString("es-ES") + "." }}' } },
        { id: 'e3', type: 'file', name: 'Leer', x: 560, y: 200, exec: ex('30 s'), params: { action: 'Leer', path: '{{ $json.ruta }}', format: 'Texto', ifMissing: 'Fallar', content: '', ifExists: 'Fallar' } }],
      chain('ee', ['e1', 'e2', 'e3']));
  },

  nodoComando() {
    return wf('Comando', 'Ejecuta un comando en una carpeta y entrega { ok, codigo, salida }. La primera vez pide permiso para ese comando exacto en esa carpeta. Al proceso no le llegan las variables con secretos.',
      test({ body: { carpeta: POC } }),
      [hook('f1', '/nodo-comando'),
        { id: 'f2', type: 'command', name: 'node --version', x: 300, y: 200, exec: ex('60 s'), params: { comando: 'node --version', carpeta: '{{ $json.body.carpeta }}', failOnError: 'Sí' } },
        { id: 'f3', type: 'node', name: 'Mostrar versión', x: 560, y: 200, exec: ex('10 s'), params: code(['return { node: $json.salida.trim(), carpeta: $json.carpeta };']) }],
      chain('fe', ['f1', 'f2', 'f3']));
  },

  nodoEmail() {
    return wf('Email', 'Un script prepara el texto y el Email lo envía: con el Cuerpo vacío usa automáticamente el texto del nodo anterior. Se revisa antes de enviarse. Sin SMTP_URL en el .env, el envío solo se simula (se registra).',
      test({ body: { nombre: 'Marta', pedido: 'P-1042' } }),
      [hook('g1', '/nodo-email'),
        { id: 'g2', type: 'node', name: 'Redactar', x: 300, y: 200, exec: ex('10 s'), params: code(['return { text: `Hola ${$json.body.nombre},\\n\\nTu pedido ${$json.body.pedido} ya está en camino.\\n\\nUn saludo.` };']) },
        { id: 'g3', type: 'email', name: 'Enviar aviso', x: 560, y: 200, exec: ex('30 s', { humanReview: true }), params: { to: 'cliente@ejemplo.com', subject: '{{ "Tu pedido " + $node["Inicio"].body.pedido }}', body: '', from: '' } }],
      chain('ge', ['g1', 'g2', 'g3']));
  },

  nodoCondicion() {
    return wf('Condición y aprobación humana', 'La Condición es JavaScript (sin {{ }}): si el importe supera 1000 € va por la salida «sí» a una aprobación humana; si no, por «no». Cambia el importe en «Datos de prueba» para ver la otra rama.',
      test({ body: { concepto: 'Portátil', importe: 1450 } }),
      [hook('h1', '/nodo-condicion'),
        { id: 'h2', type: 'if', name: '¿Más de 1000 €?', x: 300, y: 200, exec: ex(), params: { expr: '$json.body.importe > 1000' } },
        { id: 'h3', type: 'approval', name: 'Validar gasto', x: 560, y: 120, exec: ex(), params: { assignee: 'responsable', channel: 'Panel', timeout: '4 h' } },
        { id: 'h4', type: 'node', name: 'Aprobado por persona', x: 820, y: 120, exec: ex('10 s'), params: code(['return { ...$json.body, estado: `aprobado por ${$json.aprobacion.por}` };']) },
        { id: 'h5', type: 'node', name: 'Aprobado automático', x: 560, y: 290, exec: ex('10 s'), params: code(["return { ...$json.body, estado: 'aprobado automáticamente' };"]) }],
      [{ id: 'he1', from: 'h1', to: 'h2', port: 'out' }, { id: 'he2', from: 'h2', to: 'h3', port: 'true' }, { id: 'he3', from: 'h3', to: 'h4', port: 'out' }, { id: 'he4', from: 'h2', to: 'h5', port: 'false' }]);
  },

  nodoBucle() {
    return wf('Bucle', 'Recorre una lista: por la salida «cada» pasa cada elemento ($json.item, $json.index), de 2 en 2; por la salida «fin», los resultados juntos ($json.items).',
      test({ body: { ciudades: ['Madrid', 'Sevilla', 'Bilbao', 'Valencia', 'Zaragoza'] } }),
      [hook('i1', '/nodo-bucle'),
        { id: 'i2', type: 'loop', name: 'Por cada ciudad', x: 300, y: 200, exec: ex(), params: { items: '{{ $json.body.ciudades }}', batch: '2' } },
        { id: 'i3', type: 'node', name: 'Procesar ciudad', x: 560, y: 110, exec: ex('10 s'), params: code(['return { ciudad: $json.item.toUpperCase(), posicion: $json.index + 1 };']) },
        { id: 'i4', type: 'node', name: 'Resumen', x: 560, y: 290, exec: ex('10 s'), params: code(['return { procesadas: $json.total, resultados: $json.items };']) }],
      [{ id: 'ie1', from: 'i1', to: 'i2', port: 'out' }, { id: 'ie2', from: 'i2', to: 'i3', port: 'item' }, { id: 'ie3', from: 'i2', to: 'i4', port: 'done' }]);
  },

  nodoParalelo() {
    return wf('Paralelo, espera y unión', '«Dividir» lanza las dos ramas a la vez (una espera 2 s); «Unir (esperar todas)» espera a ambas y entrega { entradas: [salida de cada rama] }.',
      test({ body: { n: 12 } }),
      [hook('j1', '/nodo-paralelo'),
        { id: 'j2', type: 'parallel', name: 'Dividir', x: 300, y: 200, exec: ex(), params: { mode: 'Dividir' } },
        { id: 'j3', type: 'node', name: 'Rama A', x: 560, y: 110, exec: ex('10 s'), params: code(["return { rama: 'A', valor: $json.body.n ** 2 };"]) },
        { id: 'j4', type: 'wait', name: 'Esperar 2 s', x: 560, y: 290, exec: ex(), params: { duration: '2', unit: 'segundos' } },
        { id: 'j5', type: 'node', name: 'Rama B', x: 820, y: 290, exec: ex('10 s'), params: code(["return { rama: 'B', valor: $json.body.n / 2 };"]) },
        { id: 'j6', type: 'parallel', name: 'Unir', x: 1080, y: 200, exec: ex(), params: { mode: 'Unir (esperar todas)' } },
        { id: 'j7', type: 'node', name: 'Combinar', x: 1340, y: 200, exec: ex('10 s'), params: code(['return { ramas: $json.entradas, suma: $json.entradas.reduce((s, e) => s + e.valor, 0) };']) }],
      [{ id: 'je1', from: 'j1', to: 'j2', port: 'out' }, { id: 'je2', from: 'j2', to: 'j3', port: 'out' }, { id: 'je3', from: 'j2', to: 'j4', port: 'out' }, { id: 'je4', from: 'j4', to: 'j5', port: 'out' }, { id: 'je5', from: 'j3', to: 'j6', port: 'out' }, { id: 'je6', from: 'j5', to: 'j6', port: 'out' }, { id: 'je7', from: 'j6', to: 'j7', port: 'out' }]);
  },

  // El hijo primero: el nodo Sub-workflow lo busca por nombre
  nodoSubHijo() {
    return wf('Sub-workflow (hijo)', 'Lo invoca «Nodo · Sub-workflow»: recibe lo mismo que le llega a ese nodo y devuelve su salida final. También se puede ejecutar solo.',
      test({ body: { base: 100 } }),
      [hook('k1', '/nodo-sub-hijo'),
        { id: 'k2', type: 'node', name: 'Calcular IVA', x: 300, y: 200, exec: ex('10 s'), params: code(['const base = Number($json.body.base);', 'return { base, iva: +(base * 0.21).toFixed(2), total: +(base * 1.21).toFixed(2) };']) }],
      chain('ke', ['k1', 'k2']));
  },

  nodoSubPadre() {
    return wf('Sub-workflow', 'Invoca otro workflow por su nombre, espera su resultado y sigue con él. Útil para reutilizar piezas (ver la colección «Coding»).',
      test({ body: { base: 250 } }),
      [hook('l1', '/nodo-sub'),
        { id: 'l2', type: 'subflow', name: 'Calcular IVA (hijo)', x: 300, y: 200, exec: ex(), params: { workflow: 'Nodo · Sub-workflow (hijo)' } },
        { id: 'l3', type: 'node', name: 'Usar resultado', x: 560, y: 200, exec: ex('10 s'), params: code(['return { mensaje: `Total con IVA: ${$json.total} €`, ...$json };']) }],
      chain('le', ['l1', 'l2', 'l3']));
  },

  nodoCron() {
    return wf('Cron', 'Se ejecuta solo según su horario mientras esté activo (aquí, cada minuto; mira el panel «Programados» y Ejecuciones). El Cron solo entrega { disparado }: «Inicio» fija los datos del flujo con forma { body }, como un webhook. Desactívalo al terminar.',
      test({ disparado: '2026-01-01T08:00:00.000Z' }),
      [{ id: 'm1', type: 'cron', name: 'Cada minuto', x: 40, y: 200, params: { expr: '* * * * *', tz: 'Europe/Madrid' }, exec: ex() },
        { id: 'm2', type: 'node', name: 'Inicio', x: 300, y: 200, exec: ex('10 s'), params: code(["return { body: { tarea: 'Comprobación periódica' }, disparado: $json.disparado };"]) },
        { id: 'm3', type: 'node', name: 'Procesar', x: 560, y: 200, exec: ex('10 s'), params: code(["const hora = new Date($json.disparado).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' });", 'return { tarea: $json.body.tarea, hora };']) }],
      chain('me', ['m1', 'm2', 'm3']));
  },

  // Receptor activo para que el emisor tenga a quién avisar
  nodoEventoReceptor() {
    return wf('Evento (receptor)', `Se dispara con cada POST a /api/events/${TOPIC} (lo hace «Nodo · Evento (emisor)», u otro sistema). Recibe { topic, payload }. Tiene que estar activo para recibir eventos.`,
      test({ topic: TOPIC, payload: { nombre: 'Marta' } }),
      [{ id: 'n1', type: 'event', name: 'Saludo recibido', x: 40, y: 200, params: { topic: TOPIC }, exec: ex() },
        { id: 'n2', type: 'node', name: 'Responder', x: 300, y: 200, exec: ex('10 s'), params: code(['return { mensaje: `Hola, ${$json.payload.nombre}`, recibido: new Date().toISOString() };']) }],
      chain('ne', ['n1', 'n2']), { active: true });
  },

  nodoEventoEmisor() {
    return wf('Evento (emisor)', `Publica un evento «${TOPIC}» con un HTTP POST al propio Orquesta: lo recibe «Nodo · Evento (receptor)», que se ejecuta por su cuenta (míralo en Ejecuciones). Así un workflow puede avisar a otros sin conocerlos.`,
      test({ body: { nombre: 'Marta' } }),
      [hook('o1', '/nodo-evento'),
        { id: 'o2', type: 'http', name: 'Publicar evento', x: 300, y: 200, exec: ex('30 s'), params: { method: 'POST', url: `{{ $env.ORQ_SELF_URL }}/api/events/${TOPIC}`, headers: '', body: '{{ $json.body }}', failOnError: 'Sí' } }],
      chain('oe', ['o1', 'o2']));
  },
};
