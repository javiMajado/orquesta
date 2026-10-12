import express from 'express';

// Jira simulado para probar workflows sin crear nada: imita lo básico de la API REST de Jira bajo
// /mock/jira: crear (POST /rest/api/2/issue), consultar (GET /rest/api/2/issue/:key), asignar
// (PUT /rest/api/2/issue/:key/assignee) y buscar con JQL
// (GET /rest/api/3/search/jql y /rest/api/2/search; del JQL solo se aplican «project = CLAVE» y
// «assignee = "…"» —por accountId, email o nombre—). Los tickets
// solo viven en memoria. Para pasar al Jira real basta cambiar la URL base y la autenticación del nodo HTTP.

const issues = new Map();
// En el simulado una persona se identifica por cualquiera de estos valores (como en Jira: accountId en
// Cloud, nombre de usuario en Server, o el email)
const person = v => (v ? { accountId: String(v), emailAddress: String(v), name: String(v), displayName: String(v) } : null);
const isPerson = (a, v) => !!a && [a.accountId, a.emailAddress, a.name, a.displayName].some(x => x && String(x).toLowerCase() === String(v).toLowerCase());
let seq = 100;

const jiraError = (res, status, errors, errorMessages = []) => res.status(status).json({ errorMessages, errors });

export function mountMockJira(app) {
  const r = express.Router();

  // Como Jira: sin credenciales responde 401 (cualquier valor vale en el simulado)
  r.use('/rest', (req, res, next) => (req.get('authorization') ? next() : jiraError(res, 401, {}, ['Falta la cabecera Authorization (en el simulado vale cualquier valor, p. ej. «Basic bW9jazptb2Nr»)'])));

  r.post('/rest/api/2/issue', (req, res) => {
    const f = req.body?.fields || {};
    const errors = {};
    if (!f.project?.key) errors.project = 'Indica el proyecto: fields.project.key';
    if (!String(f.summary || '').trim()) errors.summary = 'El resumen es obligatorio';
    else if (String(f.summary).length > 255) errors.summary = 'El resumen no puede superar 255 caracteres';
    if (!f.issuetype?.name && !f.issuetype?.id) errors.issuetype = 'Indica el tipo: fields.issuetype.name';
    if (f.description != null && typeof f.description !== 'string') errors.description = 'En la API v2 la descripción es texto (wiki markup)';
    if (Object.keys(errors).length) return jiraError(res, 400, errors);

    const key = `${String(f.project.key).toUpperCase()}-${++seq}`;
    const base = `${req.protocol}://${req.get('host')}/mock/jira`;
    const issue = { id: String(10000 + seq), key, self: `${base}/rest/api/2/issue/${10000 + seq}`, fields: {
      priority: { name: 'Medium' }, reporter: { displayName: 'Usuario de prueba' }, ...f,
      assignee: person(f.assignee?.accountId || f.assignee?.emailAddress || f.assignee?.name),
      created: new Date().toISOString(), updated: new Date().toISOString(), status: { name: 'Por hacer' },
    } };
    issues.set(key, issue);
    res.status(201).json({ id: issue.id, key, self: issue.self });
  });

  r.get('/rest/api/2/issue/:key', (req, res) => {
    const issue = issues.get(req.params.key.toUpperCase()) || [...issues.values()].find(i => i.id === req.params.key);
    return issue ? res.json(issue) : jiraError(res, 404, {}, ['La incidencia no existe o no tienes permiso para verla.']);
  });

  // Asignar (como Jira: { accountId }; null = sin asignar). Actualiza «updated»
  r.put('/rest/api/2/issue/:key/assignee', (req, res) => {
    const issue = issues.get(req.params.key.toUpperCase());
    if (!issue) return jiraError(res, 404, {}, ['La incidencia no existe.']);
    issue.fields.assignee = person(req.body?.accountId || req.body?.name);
    issue.fields.updated = new Date().toISOString();
    res.status(204).end();
  });

  // Búsqueda: devuelve las incidencias del proyecto del JQL (o todas), de la más antigua a la más nueva
  const search = (req, res) => {
    const jql = String(req.query.jql || '');
    const project = jql.match(/project\s*=\s*"?([\w-]+)"?/i)?.[1]?.toUpperCase();
    const who = jql.match(/assignee\s*=\s*"([^"]+)"|assignee\s*=\s*'([^']+)'|assignee\s*=\s*([^\s"']+)/i);
    const assignee = who && (who[1] || who[2] || who[3]);
    const max = Math.min(100, Number(req.query.maxResults) || 50);
    const found = [...issues.values()].filter(i => (!project || String(i.fields.project?.key).toUpperCase() === project)
      && (!assignee || isPerson(i.fields.assignee, assignee)));
    const page = found.slice(0, max).map(({ id, key, self, fields }) => ({ id, key, self, fields }));
    res.json({ issues: page, total: found.length, maxResults: max, startAt: 0, isLast: found.length <= max });
  };
  r.get('/rest/api/3/search/jql', search);
  r.get('/rest/api/2/search', search);

  // Vista rápida de lo creado en el simulado (como /browse/<clave> en Jira; sin credenciales, para abrirla en el navegador)
  r.get('/browse/:key', (req, res) => {
    const issue = issues.get(req.params.key.toUpperCase());
    return issue ? res.json(issue) : jiraError(res, 404, {}, ['La incidencia no existe.']);
  });

  app.use('/mock/jira', r);
}
