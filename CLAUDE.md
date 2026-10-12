# Orquesta — contexto para Claude Code

Plataforma de workflows (estilo n8n) donde un orquestador reparte nodos entre workers distribuidos (agentes IA con Claude, scripts Node.js, HTTP, BD, email). Monorepo npm workspaces, Node ≥ 20, ESM, JavaScript (sin TypeScript). UI en español.

## Estructura
- `server/src/engine.js` — motor: recorre el grafo, nodos de control en el orquestador, acciones vía `registry.dispatch`. Corazón del sistema.
- `server/src/registry.js` — workers por WebSocket (`/ws/worker`), asignación (carga / rr / afinidad), cola, timeouts, cancelación.
- `server/src/triggers.js` — webhooks `/hooks/*`, cron (node-cron), eventos `POST /api/events/:topic`. `server/src/schedules.js` + `GET /api/schedules`: Cron activos con próxima ejecución (calculada con el conversor interno de node-cron) y última; horario en palabras en `@orquesta/shared/cron`.
- `server/src/db.js` — SQLite integrado de Node (`node:sqlite`, sin módulos nativos): workflows, runs, steps, logs, settings.
- `server/src/index.js` — Express, API REST, WS `/ws/ui` (eventos en vivo), worker embebido.
- `worker/src/` — cliente WS + `executors/` (agent, script, http, db, email) + `llm/` (proveedores anthropic/openai/mock, origen y huella de claves, protección SSRF de `http_request`).
- `server/src/agents.js` — agentes personalizados (tabla `agents`, `/api/agents`, pantalla `web/src/screens/Agents.jsx`). Un nodo Agente con `params.agentId` toma del agente proveedor, modelo, instrucciones, formato, herramientas, temperatura, tokens y respuesta simulada (`applyAgent` en `Engine.dispatch`); el nodo aporta `input` y `extraPrompt`.
- Permisos de carpetas y comandos: los concede el usuario en runtime (`server/src/grants.js`, pantalla `Permissions.jsx`, o «Permitir siempre / Solo esta vez» cuando un nodo los pide) y viajan al worker con cada tarea; `worker/src/access.js` los comprueba y, si falta uno, lo pide (`requestApproval` → WS `approval` → `Registry.approval`, que pausa el timeout → `Engine.toolApproval`). `ORQ_FILES_ALLOW`/`ORQ_COMMANDS_ALLOW` quedan como permisos fijos opcionales; workers externos solo aplican los del orquestador con `WORKER_ACCEPT_GRANTS=true`. `worker/src/workspace.js`: herramientas de solo lectura `listar_ficheros`, `buscar_ficheros` (glob), `buscar_en_ficheros` (como grep: `ruta:línea: texto`, regex, filtros, contexto) y `leer_fichero` por rangos (nunca `node_modules`/`.git`, `.env`/claves ni binarios); las instrucciones `EXPLORAR` de `seed-coding.js` enseñan a los agentes a buscar antes de leer; `ejecutar_comando` (aprobación por llamada salvo `approveTools=No`) y nodo `command` (sin variables con secretos). El proveedor `mock` acepta `mockTools` para probar herramientas sin LLM.
- Agentes con salida JSON: `params.schema` (JSON Schema opcional). Se añade a las instrucciones y `worker/src/llm/json-schema.js` valida la respuesta; si no lo cumple, `chat.pushCorrection` le devuelve los errores al modelo (hasta 2 veces) antes de fallar. Independiente del proveedor: no usa `output_config.format` nativo porque los gateways pueden no aceptarlo.
- `server/src/security.js` — Host/Origin/cross-site para HTTP y WS. `server/src/llm.js` — qué proveedor/modelo usa un nodo Agente.
- `packages/shared/` — capacidades por tipo de nodo, `parseDuration`, expresiones `{{ }}` (node:vm).
- `desktop/` — app Electron: arranca el servidor dentro (`src/main.js`) en `127.0.0.1:ORQ_DESKTOP_PORT` (3100 por defecto; si está ocupado, uno libre y avisa), datos en %APPDATA%Orquesta, diálogo nativo de ficheros vía `preload.cjs` (`window.orquestaDesktop`).
- `server/src/mock-jira.js` — Jira simulado en `/mock/jira` (crear/consultar incidencias y buscar con JQL —solo `project =`—, en memoria) para probar sin crear nada. El servidor expone su propia URL como `$env.ORQ_SELF_URL`.
- `server/src/seed.js` + `seed-nodos.js` + `seed-coding.js` — ejemplos que se crean una vez (clave en settings `seeded`; si se borran no vuelven): colección «Ejemplos de nodos» (un workflow por tipo de nodo) y «Coding» (sub-workflows reutilizables de tests, revisión, seguridad y QA que componen el pipeline de calidad, construir feature y revisar último commit; los agentes solo leen el repo). `ensureAgent` (agents.js) reutiliza agentes por nombre. `workflows.collection` agrupa la lista.
- Datos entre nodos: `web/src/DataPicker.jsx` («Datos disponibles»: salida real de la última ejecución o estimada por tipo; clic = inserta la expresión en el campo con el cursor) y «Ejecutar hasta aquí» (`stopAt` en `Engine.start`: solo el nodo y sus anteriores; bucles, solo el primer elemento). Campos automáticos si se dejan vacíos: agente `input`, fichero `content`, email `body`.
- Traza: `steps.port` (salida tomada si no es la normal: true/false/done) y `steps.child_run_id` (ejecución hija de un sub-workflow); `GET /api/runs/:id/trace` devuelve los pasos con las hijas anidadas. `web/src/Trace.jsx` los pinta en vertical (pestaña «Traza» del editor, salida del nodo Sub-workflow y detalle de la ejecución) y se refresca mientras algo sigue en marcha. Aprobaciones en sub-workflows: `Engine.markWaiting` sube la espera por la cadena de padres (ejecución padre y su nodo Sub-workflow en «waiting»); la traza incluye `pending` por ejecución y permite decidir en cualquier nivel (`web/src/Approvals.jsx`), y la barra de ejecución del editor lista las del árbol entero.
- `web/` — React + Vite. `Editor.jsx` (lienzo), `NodePanel.jsx`, `nodeTypes.js` (catálogo de nodos y campos), `screens/`.
- Estilo: design system Nocturne (`web/src/nocturne.css`, tokens `var(--color-*)`); estilos propios en `web/src/app.css`. Iconos Phosphor.

## Comandos
- `npm install` · `npm run dev` (server :3000 + web :5173) · `npm test` · `npm run build && npm start`
- Worker externo: `WORKER_CAPS=llm npm run worker`
- App de escritorio: `npm run desktop` · instalador: `npm run desktop:installer` (→ desktop/dist/Orquesta-Setup-<versión>.exe, misma versión) · nueva versión: `npm run desktop:release` (tests + sube el patch de desktop/package.json + instalador)

## Añadir un tipo de nodo
1. `packages/shared/src/types.js` → `CAPS` (capacidad requerida).
2. `web/src/nodeTypes.js` → `TYPES`, `DEF`, `FIELDS`.
3. Acción: `worker/src/executors/<tipo>.js` + registrar en `executors/index.js` y en `ACTION_TYPES`. Control: `case` en `Engine.execute`.

## Estado
Fase 1 (local, un usuario de confianza). Funciona de extremo a extremo; `npm test` cubre motor, seguridad y proveedores sin llamar a ningún LLM.
- Pruebas: usar el proveedor `mock` y los tests. **No** lanzar agentes con la `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` del shell salvo que el usuario lo pida (para tests, arrancar con esas variables quitadas del entorno).
- Sin módulos nativos: no volver a añadir better-sqlite3 (rompería Electron o npm run dev, que comparten node_modules).
- Electron no arranca si el entorno tiene ELECTRON_RUN_AS_NODE (lo hereda esta sesión desde VS Code): usar `npm run desktop`, que la quita.
- Probar el empaquetado **instalado** (Orquesta-Setup.exe /S → %LOCALAPPDATA%Programsorquesta-desktop), no desktop/dist/win-unpacked: dentro del repo Node resuelve módulos del node_modules raíz y oculta dependencias que faltan en el asar. Usar ORQ_DESKTOP_DATA para no tocar los datos reales.

## Backlog priorizado
1. MCP en agentes: herramientas con allowlist y aprobación por llamada (hecho para herramientas propias —ficheros y comandos—; falta conectar servidores MCP).
2. Aprobaciones con clave por nodo + iteración (hoy por nodo: falla en bucles paralelos).
3. Durabilidad: persistir estado por paso y reanudar ejecuciones tras reinicio (hoy se marcan `interrupted`). Valorar BullMQ/Redis o Postgres como cola.
4. Aislamiento: `node:vm` no es sandbox → `isolated-vm` o workers `node` en contenedores.
5. Credenciales cifradas gestionables desde la UI (hoy en el .env del worker; fase 2: cuenta de servicio en la nube).
6. Usuarios, roles y auditoría de aprobaciones (hoy solo `API_TOKEN`).
7. Editor: deshacer/rehacer, copiar/pegar, multiselección, validación del grafo antes de ejecutar.
8. Postgres como BD principal para alta disponibilidad.
