# Cambios: panel de ejecución, casos y conjuntos de datos

Hechos sobre `main` @ 6a777a7 (12-10-2026). **No se han ejecutado**: lo primero es `npm install && npm test` y `npm run dev`. Solo la lógica compartida (`packages/shared/src/inputs.js`) se probó aparte.

## Qué hay de nuevo
- **Campos de entrada** en los disparadores. Están en una pestaña nueva del panel del nodo: tipo, obligatorio, ruta, valor por defecto, ayuda, opciones y orden arrastrando. Incluye sugerencias de campos detectados, «Inferir de un JSON» y «Validar llamadas reales», que hace que el webhook responda 400.
- **Panel de ejecución**: el botón Ejecutar lo abre y, con el panel abierto, ejecuta (también con Ctrl + Enter; Esc lo cierra). Tiene tres pestañas:
  - Formulario: generado a partir de los campos de entrada.
  - JSON: con resaltado y sincronizado con el formulario.
  - Casos.
- **Conjuntos de datos y casos**:
  - Cada conjunto tiene valores comunes que heredan sus casos; cada caso guarda solo lo que cambia o lo que quita.
  - Cada caso puede llevar un resultado esperado y la opción «debe fallar».
  - Se pueden ejecutar todos los casos de un conjunto a la vez (hasta 4 en paralelo), ver el resultado en vivo y repetir solo los fallidos.
  - Selector con Ctrl + K, duplicar, renombrar, eliminar e importar desde CSV o JSON.
- **Detección de campos no declarados**: aviso en el nodo del lienzo, en su panel y en el formulario, con el campo marcado como «nuevo». Los casos a los que les faltan obligatorios aparecen como incompletos y se pueden completar con IA o con un valor por defecto. Además, antes de ejecutar se avisa si falta algún campo obligatorio.
- **Datos reales**:
  - «Escuchar webhook» durante 5 minutos: la siguiente llamada se guarda en el conjunto «Capturados de producción» y el workflow responde aunque esté inactivo.
  - «Guardar como caso» en el detalle de una ejecución.
- **IA**: «Generar casos» y «Completar con IA» usan un worker `llm` con un esquema JSON. Con el proveedor simulado devuelven datos de ejemplo, sin LLM ni coste.
- **Migración automática**: al arrancar, `graph.settings.testInput` se convierte en campos de entrada más un conjunto «Por defecto» con el caso «Datos de prueba». Se aplica a los workflows existentes, a los seeds y a los que se importan.
- **DataPicker y «Ejecutar hasta aquí»** usan ahora el caso activo.

## Ficheros
- Nuevos:
  - `packages/shared/src/inputs.js`
  - `packages/shared/test/inputs.test.js`
  - `server/src/datasets.js`
  - `server/test/datasets.test.js`
  - `web/src/RunPanel.jsx`
  - `web/src/InputFields.jsx`
  - `web/src/runData.js`
- Modificados:
  - `packages/shared/package.json`: export `./inputs`.
  - `server/src/db.js`: tablas `datasets`, `cases` (columna `vals`) y `batches`; columnas `runs.case_id` y `runs.batch_id`; `Workflows.setGraph`.
  - `server/src/engine.js`: `start` acepta `caseId` y `batchId`.
  - `server/src/index.js`: rutas nuevas y migración.
  - `server/src/triggers.js`: validación de webhooks y modo escucha.
  - `web/src/Editor.jsx`, `web/src/NodePanel.jsx`, `web/src/DataPicker.jsx`, `web/src/screens/RunDetail.jsx`, `web/src/app.css`.
- No se ha incluido `CLAUDE.md`, así que el tuyo no se toca. Añádele lo de la sección de abajo.

## Diferencias con el diseño
- **Editor JSON**: es un `textarea` con resaltado superpuesto y números de línea, no CodeMirror. Así no hay que añadir dependencias ni regenerar `package-lock.json`. No tiene autocompletado (Ctrl + Espacio), y el texto de ayuda lo omite.
- **Fila de uso dinámico**: el diseño mostraba «Declarar», pero el editor no puede saber qué clave usar, así que ofrece «Ver nodo».
- **Campos de tipo lista o archivo**: se guardan como una lista de textos, por ejemplo nombres de fichero. No se suben ficheros.

## Para añadir a CLAUDE.md
```
- Datos de prueba: `packages/shared/src/inputs.js` (analyzeInputs: qué rutas de la entrada usa el grafo y cuáles no están
  declaradas; validateInput; buildTriggerInput / valuesFromInput; checkExpectations). Campos en `trigger.params.inputFields`
  (+ `ignoredInputs`, `validateInput`). `server/src/datasets.js`: conjuntos (`datasets`, valores `common`), casos (`cases.vals` =
  solo lo que difiere; `removed`; `expect`; `expect_error`), lotes (`batches`, 4 en paralelo), modo escucha del webhook,
  importar CSV/JSON y generar con IA (worker llm; con mock usa datos de ejemplo). UI: `web/src/RunPanel.jsx` (sideTab 'run'),
  `InputFields.jsx` (pestaña del disparador), `runData.js`. `graph.settings.testInput` ya no se usa: se migra al arrancar.
```

## Comprobar a mano
1. Abre «Ejemplos de nodos», confirma que los datos de prueba se han migrado y ejecuta un workflow desde el panel.
2. Declara campos en un webhook, crea un conjunto con 3 casos (uno de ellos «debe fallar») y ejecuta el conjunto.
3. Añade un nodo que use `$node["<disparador>"].body.algo` y comprueba los avisos en el lienzo, en el formulario y en los casos.
4. Pulsa «Escuchar webhook», lanza un `curl` y confirma que aparece el caso capturado.
5. Ejecuta `npm run desktop`.
