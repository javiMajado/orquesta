import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountMockJira } from '../src/mock-jira.js';

const app = express();
app.use(express.json());
mountMockJira(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/mock/jira`;
const call = (p, { method = 'GET', body, auth = 'Basic bW9jazptb2Nr' } = {}) =>
  fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: body && JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() }));

test('Jira simulado: crea y devuelve el ticket; valida como Jira; exige Authorization', async () => {
  const ok = await call('/rest/api/2/issue', { method: 'POST', body: { fields: { project: { key: 'demo' }, summary: 'Exportar CSV', issuetype: { name: 'Story' }, description: 'h3. Hola' } } });
  assert.equal(ok.status, 201);
  assert.match(ok.body.key, /^DEMO-\d+$/);
  const got = await call(`/rest/api/2/issue/${ok.body.key}`);
  assert.equal(got.body.fields.summary, 'Exportar CSV');

  const bad = await call('/rest/api/2/issue', { method: 'POST', body: { fields: { summary: '', description: { type: 'doc' } } } });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.body.errors).sort(), ['description', 'issuetype', 'project', 'summary']);

  assert.equal((await call('/rest/api/2/issue/DEMO-1', { auth: '' })).status, 401);
  assert.equal((await call('/rest/api/2/issue/NO-1')).status, 404);
  server.close();
});
