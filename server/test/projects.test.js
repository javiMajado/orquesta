import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolateEnv, FakeRegistry, node, edge } from './helpers.js';

isolateEnv();
const { Workflows } = await import('../src/db.js');
const { Engine } = await import('../src/engine.js');
const P = await import('../src/projects.js');
const { listGrants } = await import('../src/grants.js');

const folder = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orq-proj-')));
const wf = (nodes, edges, settings) => Workflows.create({ name: `t-${Math.random()}`, graph: { nodes, edges, ...(settings ? { settings } : {}) } });

test('proyectos: validación, permiso de lectura en la carpeta y nombre único', () => {
  const dir = folder();
  const p = P.createProject({ name: 'Tienda', path: dir, description: 'demo' });
  assert.equal(p.path, dir);
  assert.ok(listGrants().grants.some(g => g.path === dir && g.read), 'concede lectura');
  assert.throws(() => P.createProject({ name: 'Tienda', path: dir }), /Ya existe/);
  assert.throws(() => P.createProject({ name: 'Otro', path: 'relativa' }), /ruta absoluta/);
  assert.throws(() => P.createProject({ name: 'Otro', path: path.join(dir, 'no-existe') }), /No existe/);
  assert.equal(P.resolveProject('Tienda').id, p.id);
  assert.equal(P.resolveProject(p.id).name, 'Tienda');
  assert.equal(P.updateProject(p.id, { description: 'nueva' }).path, dir, 'editar sin ruta conserva la carpeta');
});

test('notas: las del usuario nacen aprobadas; a los agentes solo les llegan las aprobadas', () => {
  const p = P.createProject({ name: 'Notas', path: folder() });
  P.addNote(p.id, { text: 'Usa ESM', paths: 'src/a.js, src/b.js' });
  const prop = P.addNote(p.id, { text: 'Propuesta de un agente' }, { source: 'agente «Revisor»' });
  assert.equal(prop.status, 'propuesta');
  assert.deepEqual(P.notesForAgent(p.id).map(n => [n.text, n.paths]), [['Usa ESM', ['src/a.js', 'src/b.js']]]);
  P.updateNote(prop.id, { status: 'aprobada' });
  assert.equal(P.notesForAgent(p.id).length, 2);
  assert.throws(() => P.addNote(p.id, { text: 'x'.repeat(2000) }), /demasiado larga/);
  assert.equal(P.listProjects().find(x => x.id === p.id).notes.aprobadas, 2);
});

test('motor: el proyecto del workflow da carpeta, notas aprobadas, $project y afinidad a los agentes', async () => {
  const p = P.createProject({ name: 'Motor', path: folder() });
  P.addNote(p.id, { text: 'Aprobada' });
  P.addNote(p.id, { text: 'Pendiente' }, { source: 'agente «X»' });
  const reg = new FakeRegistry(job => ({ output: job.params }));
  const t = node('webhook'), a = node('agent', { provider: 'mock', input: 'Proyecto {{ $project.name }}' }), b = node('agent', { provider: 'mock', repo: 'C:/otro' });
  const w = wf([t, a, b], [edge(t, a), edge(a, b)], { project: p.id });
  const out = await new Engine(reg).start(w.id, { input: {} }).done;
  const first = reg.calls[0].params;
  assert.equal(first.repo, p.path);
  assert.equal(first.input, 'Proyecto Motor');
  assert.deepEqual(first.projectNotes.map(n => n.text), ['Aprobada']);
  assert.equal(first.projectId, p.id);
  assert.equal(reg.calls[0].affKey, `project:${p.id}`);
  assert.equal(out.repo, 'C:/otro', 'un repo puesto en el nodo manda');
});

test('motor: body.project elige otro proyecto, uno inexistente falla, y los sub-workflows lo heredan', async () => {
  const p1 = P.createProject({ name: 'Uno', path: folder() }), p2 = P.createProject({ name: 'Dos', path: folder() });
  const reg = new FakeRegistry(job => ({ output: job.params.projectName }));
  const ct = node('webhook'), ca = node('agent', { provider: 'mock' });
  const child = wf([ct, ca], [edge(ct, ca)]);
  const t = node('webhook'), s = node('subflow', { workflow: child.id });
  const parent = wf([t, s], [edge(t, s)], { project: p1.id });
  assert.equal(await new Engine(reg).start(parent.id, { input: {} }).done, 'Uno', 'el hijo hereda el proyecto');
  assert.equal(await new Engine(reg).start(parent.id, { input: { body: { project: 'Dos' } } }).done, 'Dos');
  assert.throws(() => new Engine(reg).start(parent.id, { input: { body: { project: 'Nadie' } } }), /no existe/);
  void p2;
});

test('motor: las notas que propone un agente quedan pendientes de aprobar', async () => {
  const p = P.createProject({ name: 'Propuestas', path: folder() });
  const reg = new FakeRegistry(() => ({ output: 'ok', meta: { usage: { total: 1 }, notas: [{ texto: 'Los tests van en test/', ficheros: ['test/'], commit: 'abc1234' }, { texto: '' }] } }));
  const t = node('webhook'), a = node('agent', { provider: 'mock' }, {}, 'Revisor');
  const engine = new Engine(reg);
  const events = [];
  engine.on('event', e => events.push(e));
  const { done, runId } = engine.start(wf([t, a], [edge(t, a)], { project: p.id }).id, { input: {} });
  await done;
  const notes = P.listNotes(p.id);
  assert.equal(notes.length, 1, 'la vacía se descarta');
  assert.deepEqual([notes[0].status, notes[0].source, notes[0].runId, notes[0].commitRef, notes[0].paths], ['propuesta', 'agente «Revisor»', runId, 'abc1234', ['test/']]);
  assert.ok(events.some(e => e.type === 'notes' && e.projectId === p.id));
});
