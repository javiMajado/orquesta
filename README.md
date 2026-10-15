# Orquesta

Plataforma de workflows para agentes IA y procesos Node.js. Diseñas el flujo en un editor visual y un **orquestador** reparte cada paso entre **workers distribuidos** según su capacidad (`llm`, `node`, `db`) y su carga.

## Arquitectura

```
┌──────────────┐   REST + WebSocket    ┌─────────────────────────────┐   WebSocket   ┌──────────────┐
│  web (React) │ ────────────────────▶ │ server                      │ ◀──────────── │ worker (llm) │
│  editor, runs│ ◀──── eventos vivo ── │  · API  · motor de ejecución│               └──────────────┘
└──────────────┘                       │  · registro de workers      │ ◀──────────── ┌──────────────┐
                 webhooks / cron  ───▶ │  · triggers (webhook, cron) │               │ worker (node)│
                                       │  · SQLite                   │               └──────────────┘
                                       └─────────────────────────────┘
```

- **server/**: API REST, motor que recorre el grafo, triggers, persistencia (SQLite) y registro de workers.
- **worker/**: proceso que se conecta por WebSocket, declara capacidades y ejecuta nodos de acción. Levanta tantos como quieras, en las máquinas que quieras.
- **web/**: editor visual (React + Vite) con el estilo Nocturne.
- **packages/shared/**: tipos, capacidades y evaluación de expresiones.

Los nodos de control (condición, bucle, paralelo, espera, sub-workflow) se ejecutan en el orquestador; los de acción (agente, Node.js, HTTP, base de datos, email) en workers; las aprobaciones esperan una decisión humana.

## Puesta en marcha

Requisitos: Node.js 20 o superior.

```bash
cp .env.example .env        # configura aquí los proveedores LLM (ver «Agentes IA»)
npm install
npm run dev                 # servidor en :3000 + editor en http://localhost:5173
```

El servidor arranca un **worker embebido** (capacidades `node,db,llm`), así que funciona sin más procesos. Sin configurar nada, los agentes usan el **proveedor simulado**: sin coste, sin red y sin tocar ninguna clave. En el primer arranque se crean los ejemplos **«Soporte · Tickets entrantes»** y **«Documento → JIRAs»**, ambos con respuestas simuladas para que funcionen de principio a fin.

Pruébalo:

```bash
curl -X POST http://localhost:3000/hooks/tickets \
  -H 'content-type: application/json' \
  -d '{"email":"marta@acme.io","asunto":"No puedo exportar facturas","mensaje":"Error 500 desde ayer, es urgente"}'
```

Ábrelo en el editor y verás la ejecución en vivo. Si el analista marca prioridad alta, la ejecución se pausa hasta que alguien pulse **Aprobar**; y el nodo Email tiene activada **«Requiere aprobación humana»**, así que antes de enviar se para y enseña destinatario, asunto y cuerpo finales. Sin `SMTP_URL`, el email se simula y aparece en la salida del nodo.

```bash
curl -X POST http://localhost:3000/hooks/documento-jiras   -H 'content-type: application/json'   -d '{"proyecto":"PORTAL","texto":"1. Descargar facturas en PDF
2. El SSO falla en Safari"}'
```

## Agentes IA: proveedores y claves

Los nodos Agente pueden usar Claude, GPT o Gemini. Cada worker declara sus proveedores en `ORQ_LLM_PROVIDERS` (ver `.env.example`):

| Tipo | Para |
| --- | --- |
| `anthropic` | API de Anthropic o un gateway compatible con la Messages API |
| `openai` | `/v1/chat/completions`: OpenAI, **LiteLLM** (Claude, GPT y Gemini por el mismo gateway) o Gemini en modo OpenAI |
| `mock` | Simulado, siempre disponible. Devuelve la «Respuesta simulada» del nodo (admite `{{ }}`) o un eco |

**De dónde sale la clave, siempre visible.** Cada proveedor indica `keyEnv`, el *nombre* de la variable con la clave. Orquesta distingue si esa variable venía del **shell** o del **`.env` de Orquesta** (cuenta de servicio):

- Una clave heredada del shell está **desactivada** salvo `ORQ_LLM_ALLOW_SHELL=true`. Si se activa, la barra lateral muestra un aviso permanente «Shell».
- El panel del nodo Agente muestra «Esta ejecución usará: proveedor · modelo · variable · origen · huella».
- Cada paso de agente registra en el log el proveedor, el modelo, el origen y la huella de la clave, y los tokens consumidos.
- Las claves **no salen nunca del worker**: al servidor y a la UI solo llega una huella (sha256, 8 caracteres).

Proveedor y modelo por defecto: `ORQ_LLM_DEFAULT=proveedor:modelo`. Si está vacío, se usa el simulado; nunca se usa una clave real sin configurarlo. Para pruebas baratas: `claude-haiku-4-5-20251001`.

**Coste y documentos largos**: `ORQ_LLM_MAX_INPUT_CHARS` (400 000 por defecto; se rechaza con un error claro en lugar de truncar), `ORQ_LLM_MAX_TOKENS_PER_RUN` (presupuesto por ejecución) y «Máx. tokens de salida» por nodo. Los errores 4xx, como un modelo inexistente, no se reintentan.

## Conexiones a bases de datos

Pantalla **Conexiones**: alta, edición, «Probar conexión» y borrado de conexiones PostgreSQL o SQLite.

- **Solo lectura** está activado por defecto. SQLite abre el fichero en modo lectura; PostgreSQL ejecuta una única sentencia dentro de una transacción `READ ONLY`. Para una garantía total, usa además un usuario de BD sin permisos de escritura.
- Las contraseñas se guardan cifradas (AES-256-GCM, clave en `secret.key` junto a la BD) y nunca se devuelven a la UI ni aparecen en revisiones, pasos o logs. Esto protege la BD copiada, no frente a alguien con acceso a tu usuario de Windows.
- Las de `DB_CONNECTIONS` del `.env` aparecen como «desde .env» y no se editan desde la UI.

## Seguridad

Pensado para uso local por una persona de confianza:

- **Solo local**: el servidor escucha en `127.0.0.1` (`HOST`). Rechaza cabeceras `Host` ajenas (DNS rebinding) y peticiones de navegador de otros orígenes, así que una web abierta no puede disparar webhooks, crear workflows ni leer eventos.
- **Workers con token**: sin `WORKER_TOKEN` se genera uno temporal y solo se conecta el worker embebido.
- **Agentes sin herramientas por defecto**. `http_request` solo accede a dominios de `ORQ_AGENT_HTTP_ALLOW` y nunca a IPs internas, también tras resolver DNS o seguir redirecciones. Así un texto manipulado (*prompt injection*) no puede hacer que el agente llame a la API local. La salida de un agente es dato: sus `{{ }}` nunca se evalúan.
- **Requiere aprobación humana** (por nodo, sección Ejecución): el nodo se para, muestra los parámetros finales y no se ejecuta hasta aprobarlo. Viene activado por defecto en Email, HTTP y Base de datos.
- `$env` y los scripts no reciben variables con `KEY`, `TOKEN`, `SECRET`, `PASS` o `CRED` en el nombre.
- Los nodos **Proceso Node.js no están aislados** (`node:vm` no es un sandbox): ejecuta solo código propio.

### App de escritorio (Electron)

```bash
npm run desktop       # compila la UI y abre Orquesta en una ventana
```

- Arranca dentro el servidor y el worker embebido en `http://127.0.0.1:3100` (`ORQ_DESKTOP_PORT` en el `.env`; si está ocupado usa otro libre y avisa); no hace falta `npm run dev`. Los webhooks y la API quedan en ese puerto.
- Datos en `%APPDATA%\Orquesta\orquesta.db` (workflows, agentes, permisos, ejecuciones). La primera vez copia la BD de desarrollo (`data/orquesta.db`) para conservar tus workflows.
- Configuración: usa `%APPDATA%\Orquesta\.env` si existe; si no, el `.env` del proyecto. Ojo: si existe el de `%APPDATA%`, los cambios en el `.env` del repo no afectan a la app de escritorio.
- Nodo Fichero: **«Examinar…»** abre el diálogo de Windows. Si eliges un fichero de una carpeta sin permiso, la app lo pide y lo guarda en la pantalla **Permisos**.
- Seguridad de la ventana: sin acceso a Node desde la página (`contextIsolation`, `sandbox`); solo se exponen las funciones de elegir fichero. Los enlaces externos se abren en el navegador.
- F12 abre las herramientas de desarrollo.
- Icono: `desktop/assets/icon.svg` es el original; `npm run icon -w desktop` regenera `icon.ico` e `icon.png`. La app tiene su propio AppUserModelID, así que Windows no la agrupa con otras apps de Electron en la barra de tareas.

Para probar cambios no hace falta el instalador: `npm run desktop` ya ejecuta el código actual del repositorio.

### Generar y distribuir una versión nueva del instalador

**1. Generar el instalador**

```bash
npm install              # solo la primera vez o si han cambiado dependencias
npm run desktop:release
```

`desktop:release` hace, en orden, y se detiene si algo falla:

1. `npm test`: si algún test falla, no se genera nada.
2. Sube la versión *patch* en `desktop/package.json` (0.1.0 → 0.1.1).
3. Compila la web y empaqueta la app: `desktop/dist/Orquesta-Setup-<versión>.exe`.

Para un salto mayor, sube la versión a mano y genera el instalador sin volver a subirla:

```bash
npm version minor -w desktop --no-git-tag-version   # 0.1.x → 0.2.0  (major → 1.0.0)
npm run desktop:installer
```

`npm run desktop:installer` a secas genera el instalador **sin** tests ni cambio de versión (sobrescribe el `.exe` de la versión actual): útil para pruebas rápidas. Si usas git, haz commit de `desktop/package.json` para que la versión quede registrada.

**2. Probar el instalador antes de repartirlo**

Prueba el instalado, no `desktop/dist/win-unpacked` (dentro del repo, Node encuentra módulos del `node_modules` raíz y oculta los que falten en el paquete). Con una carpeta de datos aparte para no tocar los tuyos:

```powershell
.\desktop\dist\Orquesta-Setup-0.1.1.exe /S          # instalación silenciosa
$env:ORQ_DESKTOP_DATA = "$env:TEMP\orquesta-prueba"
& "$env:LOCALAPPDATA\Programs\orquesta-desktop\Orquesta.exe"
```

Comprueba que abre, que aparecen los workflows de ejemplo y que alguno sencillo (p. ej. «Prueba · Proceso Node.js») se ejecuta. Cierra la app y borra `%TEMP%\orquesta-prueba`. Si tenías Orquesta abierta, la de prueba avisará de que el puerto 3100 está ocupado y usará otro: es normal.

**3. Distribuir**

- Comparte solo `desktop/dist/Orquesta-Setup-<versión>.exe` (el `.blockmap` y `win-unpacked` no hacen falta).
- El instalador **no incluye tu `.env`, tus claves ni tus datos**: lleva el código, la plantilla `env.example` y los workflows y agentes de ejemplo, que se crean en el primer arranque.

**4. Qué ve quien lo instala**

- Se instala para su usuario, sin permisos de administrador, con accesos directos en el escritorio y en el menú Inicio, y se abre al terminar.
- El `.exe` no está firmado: Windows SmartScreen avisará. Hay que pulsar **«Más información» → «Ejecutar de todas formas»**.
- En el primer arranque se crea `%APPDATA%\Orquesta\.env` desde la plantilla: agentes con el **proveedor simulado** (sin coste) y sin carpetas ni comandos permitidos (se piden al usarlos). Para usar un LLM real hay que editar ese `.env` (`ORQ_LLM_PROVIDERS`, `ORQ_LLM_DEFAULT` y la variable de la clave; ver «Agentes IA: proveedores y claves») y reiniciar la app.
- La app escucha en `http://127.0.0.1:3100`, solo accesible desde ese equipo.

**5. Actualizar**

Basta con ejecutar el instalador de la versión nueva encima de la anterior. Se conservan los datos de `%APPDATA%\Orquesta` (workflows, agentes, permisos, ejecuciones y `.env`). Los ejemplos nuevos se añaden en el siguiente arranque, sin tocar los que ya existen. Desinstalar (Configuración → Aplicaciones) tampoco borra `%APPDATA%\Orquesta`.

### Producción

```bash
npm run build && npm start          # sirve API + UI en :3000
# o con Docker (servidor + worker LLM + worker Node):
docker compose up -d --build
docker compose up -d --scale worker-llm=3
```

Define `API_TOKEN` y `WORKER_TOKEN` en `.env` antes de exponerlo.

### Workers adicionales

```bash
ORQ_URL=ws://servidor:3000/ws/worker WORKER_ID=agente-02 WORKER_CAPS=llm WORKER_MAX=4 npm run worker
```

Estrategias del orquestador (pantalla Workers): **menor carga** (por defecto), **round-robin** y **afinidad** (repite el worker que ejecutó ese nodo la última vez). Un nodo puede fijarse a un worker concreto desde su panel. Si todos los compatibles están ocupados, la tarea espera en cola hasta su timeout.

## Nodos

| Nodo | Dónde corre | Qué hace |
| --- | --- | --- |
| Webhook | orquestador | `METHOD /hooks/<ruta>`. Auth: ninguna, `x-api-key` o HMAC (`x-signature: sha256=…`). Responde 202 o espera al final. |
| Cron | orquestador | Expresión cron con zona horaria. Solo en workflows activos. |
| Evento | orquestador | `POST /api/events/<tópico>` con el payload. |
| Agente IA | worker `llm` | Claude, GPT o Gemini (según proveedor) con instrucciones, entrada, salida texto/JSON y herramientas opcionales `fecha_actual`, `http_request`. |
| Proceso Node.js | worker `node` | Cuerpo de función async con `$json`, `fetch`, `env`, `console`. |
| HTTP request | worker `node` | Petición con cabeceras/cuerpo; devuelve `{ status, headers, body }`. |
| Fichero | worker `node` | Lee (texto o JSON) o escribe un fichero, solo dentro de las carpetas de `ORQ_FILES_ALLOW`. Por defecto no sobrescribe. |
| Base de datos | worker `db` | Postgres o SQLite. La conexión se elige en un desplegable; se dan de alta en la pantalla **Conexiones** (o en `DB_CONNECTIONS` del `.env`). |
| Email | worker `node` | SMTP vía nodemailer (`SMTP_URL`). |
| Condición | orquestador | Expresión JS → salida «sí» / «no». |
| Bucle | orquestador | Ejecuta la rama «cada» por elemento (`{ item, index }`), luego «fin» con `{ items }`. |
| Paralelo / merge | orquestador | «Dividir» lanza todas las salidas a la vez; «Unir» espera todas o la primera. |
| Esperar | orquestador | Pausa N segundos, minutos u horas. |
| Sub-workflow | orquestador | Ejecuta otro workflow y devuelve su salida. |
| Aprobación humana | cola humana | Pausa hasta aprobar/rechazar en el panel; notifica por Slack o Email si se configura. |

**Expresiones**: cualquier campo acepta `{{ … }}` con JavaScript. Disponibles: `$json` (salida del nodo anterior), `$node["Nombre del nodo"]` (salida de cualquier nodo previo), `$env` (variables `ORQ_*`), `$run`. Si el campo es solo una expresión, se pasa el valor tal cual (objeto, array…).

Cada nodo de acción tiene **reintentos** (con backoff exponencial) y **timeout**.

## API

| Método | Ruta | |
| --- | --- | --- |
| GET/POST | `/api/workflows` | Listar / crear |
| GET/PUT/DELETE | `/api/workflows/:id` | Leer / guardar (`name`, `description`, `active`, `graph`) / borrar |
| POST | `/api/workflows/:id/run` | Ejecutar con `{ input }` |
| GET | `/api/runs?workflowId=&status=` | Historial |
| GET | `/api/runs/export.csv?workflowId=&status=` | Exportación CSV (`;`, UTF-8 con BOM): mismos filtros que el historial, hasta 10 000 filas, sin `input`/`output` |
| GET | `/api/runs/:id` | Detalle con pasos, logs y aprobaciones pendientes |
| POST | `/api/runs/:id/cancel` | Cancelar |
| POST | `/api/runs/:id/approvals/:nodeId` | `{ approved, by, comment }` |
| GET/PATCH | `/api/workers[/:id]` | Listar / activar-desactivar `{ enabled }` |
| GET | `/api/llm` · `/api/llm/models?provider=` | Proveedores LLM (origen y huella de la clave) · modelos de un proveedor |
| GET/PUT | `/api/settings` | Estrategia del orquestador `{ strategy }` |
| POST | `/api/events/:topic` | Disparar nodos Evento |
| WS | `/ws/ui` · `/ws/worker` | Eventos en vivo · canal de workers |

Formato del grafo: `{ nodes: [{ id, type, name, x, y, params, exec: { worker, retries, timeout, humanReview } }], edges: [{ id, from, to, port }], settings }`. Los workflows se exportan e importan como JSON desde la lista.

## Limitaciones conocidas y siguientes pasos

- **Seguridad del código**: los nodos Node.js y las expresiones usan `node:vm`, que **no es un sandbox**. Para código de terceros, ejecuta los workers `node` en contenedores aislados o migra a `isolated-vm`.
- **MCP**: aún no; los agentes solo tienen las dos herramientas integradas.
- **Aprobaciones en bucles paralelos**: las aprobaciones se identifican por nodo, así que un nodo con revisión humana dentro de un Bucle con «Elementos en paralelo» > 1 no funciona bien. Usa lotes de 1.
- **Durabilidad**: si el servidor se reinicia, las ejecuciones en curso (incluidas esperas y aprobaciones pendientes) se marcan como *interrumpidas*. Para reanudarlas, persiste el estado por paso y usa una cola durable (BullMQ/Redis o Postgres).
- **Usuarios**: hay un único token de API; faltan cuentas, roles y auditoría de quién aprueba.
- **Secretos/credenciales**: se leen del entorno de cada worker; falta un almacén de credenciales cifrado gestionable desde la UI.
- **Escala**: SQLite y un solo orquestador sirven para miles de ejecuciones al día; para alta disponibilidad, pasa a Postgres y a varios orquestadores con cola compartida.
