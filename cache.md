# Caché del repositorio: cómo funciona

Implementado el 15-10-2026 (commit `bd8c4fb`, rama `feature/opencode-provider`).

Cuando hablamos de «caché del repo» hay dos cachés distintas que trabajan juntas:

1. **El mapa del repositorio, en el disco del worker.** Un resumen del repo que se genera una vez por commit y se reutiliza.
2. **La caché de prompts del proveedor** (Anthropic / OpenCode). Hace que el texto repetido al principio de cada petición (herramientas, mapa, instrucciones) se cobre a ~10 % en lugar de entero.

La primera existe sobre todo para que la segunda funcione: si el mapa no saliera exactamente igual byte a byte en cada agente y cada turno, el proveedor no podría reutilizarlo.

---

## 1. El problema de partida

Antes, cada agente de Coding empezaba igual: listar la raíz, leer el README, leer CLAUDE.md, buscar… y en cada turno se reenviaba **todo** el historial sin caché. Así que:
- Cada turno pagaba de nuevo todo lo anterior: el coste crece de forma cuadrática con los turnos.
- Dos agentes en paralelo sobre el mismo repo (revisión y seguridad) hacían esa exploración inicial dos veces y la pagaban dos veces.

---

## 2. De dónde sale la carpeta del repo

1. **El nodo Agente tiene un campo nuevo, «Repositorio»** (parámetro `repo`, en `web/src/nodeTypes.js`). Admite expresiones; en los workflows de Coding vale `{{ $node["Inicio"].body.repo }}`.
2. **El motor** (`server/src/engine.js`, `dispatch`) evalúa esa expresión. Si queda vacía y la ejecución tiene proyecto, la rellena con `ctx.project.path`.
3. **El parámetro viaja al worker** con la tarea, como cualquier otro.

---

## 3. En el worker: comprobar el permiso sin preguntar

En `worker/src/executors/agent.js`, antes de nada:

```js
root = await access.readable(String(params.repo).trim());
```

`readable()` es un método nuevo de `worker/src/access.js`:
- Devuelve la ruta real (`realpath`) si la carpeta existe y **ya** tiene permiso de lectura, y `null` en cualquier otro caso.
- **Nunca pide permiso.** El resto de accesos sí pueden lanzar «Permitir siempre / Solo esta vez», pero el mapa es una optimización: no tendría sentido parar la ejecución para pedirlo.
- Si no hay permiso, se escribe en el log «Mapa del repositorio: … no tiene permiso de lectura · el agente no lo recibe» y el agente sigue sin mapa.

---

## 4. Obtener el mapa: tres niveles de caché

Todo esto está en `repoMap(root)`, en `worker/src/repomap.js`:

```
repoMap(root)
 ├─ git rev-parse HEAD            → commit actual (o null si no es repo git)
 ├─ ¿está en memoria (root|commit)?            → se devuelve
 ├─ ¿existe <caché>/<hash-ruta>/map-v1-<commit>.txt?  → se lee del disco
 └─ si no: buildRepoMap(root) → se escribe en ese fichero → se guarda en memoria
```

**Nivel 1, memoria del proceso.** Un `Map` con clave `ruta|commit`. Con git la entrada vale mientras no cambie el commit. Sin git solo vale 60 s, porque no hay forma barata de saber si algo ha cambiado.

**Nivel 2, disco.** La carpeta se elige en `worker/src/cache-dir.js`, en este orden:
1. `ORQ_WORKER_CACHE_DIR`, si está definida.
2. `ORQ_BASE_DIR/data/cache/repos`. En desarrollo es `orquesta/data/cache/repos`, que git ya ignora; en la app de escritorio, `%APPDATA%\Orquesta\data\cache\repos`.
3. `~/.orquesta/cache/repos`, para un worker suelto.

Dentro hay una subcarpeta por repo con el nombre `sha1(ruta real)`, en minúsculas en Windows para que `C:\Repo` y `c:\repo` sean el mismo. El fichero se llama `map-v1-<commit completo>.txt`:
- El `v1` es la versión del formato. Si algún día cambia lo que contiene el mapa, se sube a `v2` y los mapas viejos dejan de usarse solos.
- El commit en el nombre hace que **cada commit tenga su propio mapa**. Al hacer un commit nuevo se genera otro y el anterior se queda ahí, sin borrar (son unos 6 KB).

**Nivel 3, generar.** Solo la primera vez para cada commit. En el repo de Orquesta tarda unos 150 ms.

---

## 5. Cómo se genera el mapa (`buildRepoMap`)

### Qué ficheros entran
- **Con git:** `git ls-tree -r --name-only -z HEAD`. Es la lista de ficheros **del último commit**, no de la carpeta de trabajo. Ese es el punto clave del diseño:
  - Dos agentes que arrancan a la vez ven exactamente la misma lista, aunque tengas ficheros a medio editar.
  - El mapa solo cambia cuando cambia el commit, y eso es lo que permite cachearlo por commit.
  - Se lanza con `execFile` (sin shell) y con un timeout de 30 s.
- **Sin git:** recorre la carpeta con `walkFiles` de `worker/src/workspace.js`, con el mismo límite de 20 000 ficheros que el resto de herramientas.
- **En los dos casos se excluye** lo mismo que en las herramientas de lectura, con las constantes `IGNORE` y `SECRET_FILE` exportadas de `workspace.js`:
  - carpetas como `node_modules`, `.git`, `dist`, `build`, `.venv`…;
  - ficheros con secretos: `.env*` (salvo `.env.example`), `*.pem`, `*.key`, `id_rsa`, `.npmrc`, `credentials.json`…

  Ni siquiera aparecen sus nombres en el mapa.

### Qué contiene, en este orden
1. **Cabecera:** nombre, raíz, commit corto, número de ficheros, y un aviso de que es una foto del último commit.
2. **Lenguajes** por número de ficheros (los 6 principales, con %).
3. **Ficheros de la raíz** (hasta 40).
4. **Árbol de carpetas** con cuántos ficheros tiene cada una. Hasta 3 niveles; si no cabe, baja a 2 o a 1. Cada carpeta muestra como mucho 25 subcarpetas (las más grandes) y «… N carpetas más».
5. **`package.json` de la raíz:** name, workspaces, main/bin/exports y scripts con su comando.
6. **Paquetes:** cada `package.json` hasta 3 niveles de profundidad, con su nombre y los nombres de sus scripts.
7. **Otros manifiestos** si existen: `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`…
8. **Puntos de entrada probables:** `index|main|server|app|cli` con extensión de código.
9. **Índice de la documentación:** los títulos `#` y `##` de README.md, CLAUDE.md, AGENTS.md y `docs/*.md`, sin contar lo que hay dentro de bloques de código.
10. **Extracto de CLAUDE.md** (o de AGENTS.md si no hay), con el espacio que quede, hasta 4 000 caracteres.

### Tamaño
- Límite de `ORQ_REPO_MAP_CHARS` caracteres, 12 000 por defecto (unos 3 000 tokens).
- El árbol se ajusta al hueco que dejan las demás secciones y el extracto rellena lo que sobra.
- El mapa de Orquesta ocupa unos 6 200 caracteres.

### Determinista
No lleva fechas ni nada aleatorio. Para el mismo commit genera siempre los mismos bytes; hay un test que lo comprueba. Además, una vez escrito en disco, todos los agentes leen ese mismo fichero.

Hay una salvedad consciente: el README y CLAUDE.md se leen de la carpeta de trabajo, no del commit. Si los tienes modificados sin confirmar, el mapa refleja la versión que hubiera la primera vez que se generó para ese commit, y no cambia hasta el siguiente commit.

---

## 6. Dónde va el mapa dentro de la petición

En `agent.js` el system se construye por secciones:

```js
const shared = [map?.text, notasDelProyecto].filter(Boolean).join('\n\n');
const system = shared ? [shared, instrucciones] : instrucciones;
```

- **Primera sección: el mapa y, si hay proyecto, sus notas.** Es lo común a todos los agentes del mismo repo. Va **antes** que las instrucciones de cada agente (revisor, seguridad…) porque la caché del proveedor funciona por prefijo: solo se reutiliza lo que coincide desde el principio. Si las instrucciones fueran primero, revisión y seguridad no compartirían nada.
- **Segunda sección: las instrucciones** propias de ese agente.

Las notas van en la misma sección que el mapa para no gastar un marcador de caché más (el límite es 4); cambian poco, así que casi nunca invalidan el mapa.

---

## 7. La caché del proveedor: los marcadores

En `worker/src/llm/clients.js`, cliente Anthropic (que es como se usa OpenCode Go), cada petición lleva estos marcadores `cache_control: { type: 'ephemeral' }`:

| Marcador | Dónde | Qué cachea |
|---|---|---|
| 1 | Última herramienta | Las definiciones de las herramientas |
| 2 | Sección del mapa | Herramientas + mapa (compartido entre agentes del mismo repo) |
| 3 | Sección de instrucciones | + las instrucciones de ese agente |
| 4 | Último bloque del último mensaje | + toda la conversación hasta ese turno |

Detalles importantes:
- **El orden en que el proveedor lee la petición** es herramientas → system → mensajes. Por eso las herramientas se ordenan siempre igual (el orden del objeto `TOOLS`), no como estén escritas en el campo del nodo: «leer, buscar» y «buscar, leer» darían prefijos distintos. `ejecutar_comando` va la última porque su descripción cambia con los comandos permitidos.
- **El marcador del mensaje se mueve.** En el historial guardado no hay marcadores; antes de cada envío se hace una copia y se marca el último bloque (`markLast`). Así, en el turno N el proveedor encuentra en caché lo que se marcó en el turno N−1 y solo cobra entero lo nuevo.
- **Modo por proveedor:** se elige en Workers (Automática / Siempre / Desactivada), el servidor lo envía con cada tarea como `params.promptCache`, y `ORQ_LLM_PROMPT_CACHE=off` lo apaga en todo el worker. En Automática, si un gateway responde 400 mencionando `cache_control`, se reintenta sin caché y se recuerda en `noCache`, igual que ya se hacía con `temperature`.
- **Sin caché**, el system se manda como texto plano, como antes, por compatibilidad con gateways más limitados.
- **OpenAI** cachea solo los prefijos repetidos; ahí basta con que herramientas y system no cambien, y se lee `prompt_tokens_details.cached_tokens` para contabilizarlo.

---

## 8. Varios agentes a la vez: el precalentamiento

**El problema:** una entrada de la caché del proveedor solo se puede leer cuando la primera respuesta que la escribió ya ha empezado a llegar. Si revisión y seguridad arrancan en el mismo instante, ninguno encuentra nada y los dos pagan el mapa entero.

**La solución** (`sharedPrefix` en `agent.js`):
1. Se calcula una clave: `sha1(proveedor + modelo + herramientas + mapa)`.
2. **El primer agente** con esa clave hace una petición de precalentamiento: la misma petición con `max_tokens: 0`. El proveedor procesa la entrada y la escribe en caché, pero no genera nada.
3. **Los demás** que lleguen con la misma clave esperan a que termine (log: «Otro agente… se espera para reutilizarla») y después arrancan leyendo de caché.
4. La entrada dura 4 minutos, por debajo de los 5 de la caché del proveedor.
5. **Si falla** (el proveedor no admite `max_tokens: 0`, o pasan 30 s), se borra la entrada para que nadie más espere y se escribe el motivo en el log.

Esto funciona dentro del **mismo worker**, que es lo normal con el worker embebido. Por eso, con proyecto, el motor usa afinidad `project:<id>`: todos los agentes del proyecto van al mismo worker.

En la medición real apareció un fallo: el Explorador lleva `temperature: 0`, que `claude-haiku-5-5` rechaza. El turno normal reintentaba sin ella, pero el precalentamiento no, así que fallaba en silencio. Ahora el precalentamiento usa la misma función de envío con los mismos reintentos (`send`), y hay un test para ello.

---

## 9. Cuándo se invalida

| Qué cambia | Qué pasa |
|---|---|
| Haces un commit | Commit nuevo → mapa nuevo (fichero nuevo) → el prefijo cambia → la primera petición escribe caché y las siguientes la leen |
| Editas ficheros sin hacer commit | El mapa no cambia (a propósito). Los agentes leen el código actual con sus herramientas |
| Cambias una nota del proyecto | Cambia la primera sección → se rehace la caché de ese prefijo una vez |
| Pasan más de 5 min sin peticiones | El proveedor descarta su caché; el mapa del disco sigue valiendo |
| Cambia el formato del mapa (código) | Se sube `VERSION` → `map-v2-…` y se ignoran los antiguos |

---

## 10. Cómo se comprobó

- **Tests sin LLM** (proveedor simulado, que ahora imita la caché del proveedor):
  - `worker/test/repomap.test.js`: contenido del mapa, sin `.env` ni `node_modules`, mismos bytes en cada llamada, fichero en disco por commit, límite de tamaño y funcionamiento sin git.
  - `worker/test/anthropic-cache.test.js`, contra un servidor HTTP local con el SDK real: posición de los 4 marcadores, que el marcador se mueve sin cambiar los mensajes anteriores, reintento sin caché ante un 400, precalentamiento con `max_tokens: 0`.
  - `worker/test/token-bench.test.js`: umbrales de ahorro y que en paralelo solo precalienta uno.
- **Medición real** con OpenCode Go (`claude-haiku-5-5`), 3 ejecuciones del Explorador antes y 3 después: **−46 % de tokens ponderados**. Después, entre el 70 y el 80 % de la entrada se servía desde la caché.

---

## 11. Límites que conviene recordar

- **El mapa es del último commit:** un fichero nuevo sin confirmar no aparece (los agentes lo encuentran igual con `buscar_ficheros`).
- **Los mapas antiguos no se borran.** Ocupan muy poco, pero no hay limpieza automática.
- **La caché compartida en paralelo solo funciona dentro de un mismo worker.**
- **El mapa no se ve desde la interfaz** (no hay botón «Ver mapa»): lo genera el worker, que es quien ve el disco. Se puede abrir el fichero en `data/cache/repos/<hash>/` o mirar en el log de la ejecución la línea «Mapa del repositorio: N caracteres · commit …».
