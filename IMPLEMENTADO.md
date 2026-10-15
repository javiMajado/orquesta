# Lo implementado (14 y 15 de octubre de 2026)

Rama `feature/opencode-provider`. Para el detalle técnico de cada pieza, ver `CLAUDE.md`.

| Fecha | Qué | Commit |
|---|---|---|
| 14-10-2026 | Cambiar el modelo de un agente guardado en un nodo | `baaadc7` |
| 14-10-2026 | Ajustes de sub-workflow (ver y editar los nodos del hijo) | `baaadc7` |
| 15-10-2026 | Panel derecho más ancho y «Ver en grande» | `baaadc7` |
| 15-10-2026 | Merge de `origin/develop` (panel de ejecución, casos, conjuntos de datos) | `e78af50` |
| 15-10-2026 | Agentes más baratos sobre repositorios (caché, mapa del repo…) | `bd8c4fb` |
| 15-10-2026 | Proyectos y notas (memoria del proyecto) | **sin commit** |
| 15-10-2026 | Implementar feature: los agentes editan código y se formatea | **sin commit** |

---

## 1. Cambiar el modelo de un agente guardado (14-10)
Un nodo Agente que usa un agente de la pantalla Agentes puede usar otro proveedor o modelo **solo en ese nodo**, sin tocar el agente guardado.
- **Dónde:** en el panel del nodo, debajo de la ficha del agente, bloque «Modelo en este nodo». «Usar el del agente» quita el cambio.
- **Detalles:** si cambias de proveedor y dejas el modelo vacío, se usa el modelo por defecto de ese proveedor. Al desvincular el agente, el nodo se queda con el modelo cambiado.
- **Por dentro:** `params.overrideProvider` / `overrideModel` y `applyAgent` (`server/src/agents.js`).

## 2. Ajustes de sub-workflow (14-10)
Desde el nodo Sub-workflow puedes ver el workflow hijo y cambiar parámetros de sus nodos (por ejemplo el modelo de un agente) **solo cuando lo lanza ese nodo**. El hijo no se modifica.
- **Dónde:** en el panel del nodo Sub-workflow, caja «Contenido del sub-workflow» (minimapa) → «Ver y ajustar nodos…». Se abre un diálogo con el grafo del hijo y el formulario del nodo elegido.
- **Detalles:**
  - Los campos cambiados se marcan y tienen «Restablecer».
  - Se puede bajar a sub-workflows anidados.
  - En el lienzo, el nodo muestra «· N ajustes».
- **Límite:** solo parámetros; el worker, los reintentos y el timeout del hijo se cambian en el propio hijo.
- **Por dentro:** `params.overrides` del nodo Sub-workflow, `packages/shared/src/overrides.js` y `web/src/SubflowBox.jsx`.

## 3. Panel derecho más legible (15-10)
- **Ancho:** se arrastra el borde izquierdo del panel (se recuerda). El botón de la cabecera o el doble clic en el borde alterna entre estrecho y ancho.
- **Aprobaciones:** el comando, la URL o la consulta a aprobar salen arriba, enteros y con «Copiar».
- **«Ver en grande»** para aprobaciones (se puede aprobar desde ahí) y para salidas (tabla completa y JSON).
- **Diseño según el ancho:** en estrecho, las filas se apilan.
- **Por dentro:** `web/src/BigView.jsx`, `web/src/Approvals.jsx` y `web/src/NodePanel.jsx`.

## 4. Agentes más baratos sobre repositorios (15-10)
Objetivo: que los agentes no paguen una y otra vez por leer lo mismo, sobre todo cuando varios trabajan a la vez.
- **Caché de prompts:**
  - Lo que no cambia entre turnos (herramientas, instrucciones, mapa) se cachea y se paga a ~10 %.
  - Se configura por proveedor en **Workers → «Caché de prompts»**: Automática / Siempre / Desactivada.
  - En Automática, si el proveedor la rechaza, se desactiva sola.
- **Historial más corto:**
  - Con Anthropic, el servidor retira los resultados viejos de herramientas.
  - Con OpenAI y el simulado, se recortan por lotes.
  - Ojo: con Anthropic no se puede recortar en el cliente (da error 400).
- **Salidas de herramientas compactas:** texto en vez de JSON, `leer_fichero` con líneas numeradas, búsquedas agrupadas por fichero. Las lecturas de un mismo turno se ejecutan a la vez.
- **Mapa del repositorio:**
  - Campo nuevo **«Repositorio»** en el nodo Agente.
  - El agente recibe al principio un resumen del repo: estructura, scripts, paquetes, documentación y extracto de CLAUDE.md.
  - Se genera del último commit y se guarda en `data/cache/repos`.
- **Agentes en paralelo:** el primero precalienta la caché y los demás la reutilizan.
- **Presupuesto en tokens ponderados:** lo leído de caché cuenta al 10 %. La salida del nodo muestra «X de caché · ahorro N %».
- **Workflows de Coding:** ya pasan el repo a sus agentes; los existentes se migraron solos.
- **Medido:**
  - Con OpenCode Go (`claude-haiku-5-5`), 3 ejecuciones del Explorador antes y 3 después: **−46 % de tokens ponderados**. Las respuestas tienen la misma calidad; el tiempo es parecido.
  - Con el simulado (`node scripts/bench-tokens.mjs`): −73 % para un agente y −75 % con dos en paralelo.
- **Variables nuevas** (todas opcionales; ver `.env.example`): `ORQ_LLM_PROMPT_CACHE`, `ORQ_LLM_CONTEXT_EDIT`, `ORQ_LLM_COMPACT_AT`, `ORQ_TOOL_OUTPUT`, `ORQ_REPO_MAP_CHARS`, `ORQ_WORKER_CACHE_DIR`.
- **Por dentro:** `worker/src/llm/clients.js`, `worker/src/executors/agent.js`, `worker/src/repomap.js` y `worker/src/cache-dir.js`.

## 5. Proyectos y notas (15-10, sin commit)
- **Proyectos (pantalla nueva en el menú):** un repositorio con nombre. Al crearlo se concede permiso de lectura en su carpeta.
- **Cómo lo usa un workflow:**
  - Se elige en el panel **«Workflow»** del editor, o el webhook manda `body.project`. Los sub-workflows heredan el del padre.
  - Sus agentes trabajan sobre la carpeta del proyecto (si su «Repositorio» está vacío) y reciben el mapa y las **notas aprobadas**.
  - En expresiones: `$project.name`, `$project.path`.
- **Notas = memoria del proyecto:**
  - Las tuyas cuentan desde que las añades.
  - Las propone un agente con la herramienta `proponer_nota` y quedan **«Pendientes de revisar»** hasta que las apruebas. El menú muestra cuántas hay.
  - Los agentes las reciben como datos, no como instrucciones. Si una nota cita ficheros que han cambiado desde su commit, se les avisa de que puede estar desactualizada.
- **Límite:** no hay botón «Ver mapa» en el proyecto (el mapa lo genera el worker).
- **Por dentro:** `server/src/projects.js`, tablas `projects` y `project_notes`, `web/src/screens/Projects.jsx`.

## 6. Implementar feature: edición de código y formateo (15-10, sin commit)
Workflow nuevo **«Coding · Implementar feature»**. El de antes, «Construir feature», sigue igual para cuando solo quieras la propuesta.
- **Flujo:**
  1. Comprueba que el repo no tiene cambios sin confirmar; si los tiene, se para.
  2. El **Arquitecto** planifica y propone el nombre de la rama.
  3. Se crea la rama con `git switch -c`. Si lanzas con `body.rama`, manda la tuya. El nombre se limpia siempre (minúsculas, guiones, prefijo `feature/`) porque va a la línea de comandos.
  4. El **Implementador** edita el código y pasa los tests, corrigiendo hasta 3 veces.
  5. **Formatear** con el formateador del proyecto.
  6. Tests finales, `git diff`, revisión del diff real e informe en `~/orquesta-poc/implementacion-feature.md`.
  7. Aprobación. **Los cambios quedan en la rama, sin commit.**
- **Herramientas nuevas de los agentes:**
  - `editar_fichero`: sustituye un trozo exacto, que debe aparecer una sola vez. Respeta CRLF/LF y el BOM.
  - `crear_fichero`: crea el fichero y las carpetas que falten; si ya existe, falla.

  Necesitan permiso de escritura en el repo (se pide la primera vez) y nunca escriben en `node_modules`, `.git` ni `.env`.
- **Nodo nuevo «Formatear código»:** se aplica solo a lo cambiado (`git diff` + ficheros nuevos).
  - Detecta, por orden: script `format` de package.json, Biome, Prettier, ruff, black, gofmt.
  - Se le puede poner un formateador propio.
  - El permiso es del comando base (por ejemplo `npx prettier --write`); los ficheros se añaden como argumentos.
- **Permisos que pedirá la primera vez:** escritura en el repo y los comandos `git status --porcelain`, `git diff`, el de tests y el del formateador. Además, **cada rama nueva** pide permiso, porque los comandos se permiten por texto exacto. Sirve de confirmación de «voy a crear esta rama».
- **Probado de extremo a extremo** con el simulado: crea la rama, edita, crea, formatea, pasa los tests, revisa, escribe el informe y espera aprobación. Con el repo sucio se para.
- **Por dentro:** `worker/src/workspace.js` (`editText`, `createText`), `worker/src/executors/format.js`, `server/src/seed-coding.js` (`codingImplement`, agente «Coding · Implementador»).

---

## Pendiente
1. **Hacer el commit de la Fase 4** (Proyectos y notas).
2. **Fase 5, índice del repositorio:** índice SQLite por repo en el worker, incremental con git y activado desde la pantalla del proyecto. Hace las búsquedas rápidas en repos de 5 000 a 50 000 ficheros y añade la herramienta `buscar_simbolo`.
3. **Medir con el LLM real varios agentes en paralelo** (Pipeline de calidad), que es donde más debería ahorrar.
4. **Fase 6, opcional:** «explorar una vez y repartir» a los agentes paralelos, solo si la medición demuestra que siguen duplicando trabajo.
5. **Backlog:** conectar servidores MCP a los agentes (empezar por HTTP, con lista de herramientas permitidas y aprobación por llamada).

## Cómo comprobar que todo sigue bien
- `npm test` desde **PowerShell** (el Node de Git Bash es el 16 y no tiene `node:sqlite`). Son 145 tests; deben pasar todos sin llamar a ningún LLM.
- `node scripts/bench-tokens.mjs` → tabla de ahorro de tokens con el simulado (sin coste).
- `npm run build -w web` → la web compila.
