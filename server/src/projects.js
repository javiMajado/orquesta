import fs from 'node:fs';
import path from 'node:path';
import { Projects, Notes, Workflows } from './db.js';
import { grant } from './grants.js';

// Proyectos: un repositorio con el que trabajan los workflows (ajuste del workflow o body.project del
// webhook). Los nodos Agente de una ejecución con proyecto reciben su carpeta (mapa del repositorio) y
// las notas APROBADAS. Las notas son memoria del proyecto: las añade el usuario o las propone un agente
// (herramienta proponer_nota) y no se usan hasta que alguien las aprueba.

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const STATUSES = ['propuesta', 'aprobada'];
const NOTE_MAX = 1500;
// Lo que se manda a los agentes: las notas aprobadas más recientes hasta ~1 500 tokens
const NOTES_BUDGET = 6000;

function cleanFolder(p) {
  const raw = String(p ?? '').trim();
  if (!raw || !path.isAbsolute(raw)) throw bad('Indica la ruta absoluta de la carpeta del repositorio');
  let st;
  try { st = fs.statSync(raw); } catch { throw bad(`No existe la carpeta ${raw}`); }
  if (!st.isDirectory()) throw bad(`No es una carpeta: ${raw}`);
  return fs.realpathSync(raw);
}

function clean(body, cur = {}) {
  const name = String(body?.name ?? cur.name ?? '').trim();
  if (!name) throw bad('El nombre es obligatorio');
  if (name.length > 80) throw bad('El nombre es demasiado largo (máx. 80 caracteres)');
  const other = Projects.findByName(name);
  if (other && other.id !== cur.id) throw bad(`Ya existe un proyecto llamado «${name}»`, 409);
  const folder = body?.path !== undefined || !cur.path ? cleanFolder(body?.path) : cur.path;
  return { name, path: folder, description: String(body?.description ?? cur.description ?? '').trim().slice(0, 500) };
}

// Workflows que usan cada proyecto (ajuste del workflow)
function usage() {
  const out = {};
  for (const w of Workflows.list()) {
    const id = w.graph?.settings?.project;
    if (id) (out[id] ||= []).push({ id: w.id, name: w.name });
  }
  return out;
}

export function listProjects() {
  const counts = Object.fromEntries(Notes.counts().map(c => [c.id, c]));
  const used = usage();
  return Projects.list().map(p => ({ ...p, notes: { aprobadas: counts[p.id]?.aprobadas || 0, propuestas: counts[p.id]?.propuestas || 0 }, workflows: used[p.id] || [] }));
}
export const getProject = id => Projects.get(id) || null;

// Al crear (o mover) un proyecto se concede permiso de lectura en su carpeta: los agentes la exploran
export function createProject(body) {
  const v = clean(body);
  grant({ path: v.path, read: true, by: `proyecto «${v.name}»` });
  return Projects.create(v);
}
export function updateProject(id, body) {
  const cur = Projects.get(id);
  if (!cur) return null;
  const v = clean(body, cur);
  if (v.path !== cur.path) grant({ path: v.path, read: true, by: `proyecto «${v.name}»` });
  return Projects.update(id, v);
}
export const deleteProject = id => Projects.remove(id);

// Proyecto por id o por nombre (webhook: body.project)
export function resolveProject(ref) {
  if (!ref) return null;
  const r = String(ref).trim();
  return Projects.get(r) || Projects.findByName(r) || null;
}

// ── Notas
function cleanNote(body, cur = {}) {
  const text = String(body?.text ?? cur.text ?? '').trim();
  if (!text) throw bad('La nota está vacía');
  if (text.length > NOTE_MAX) throw bad(`La nota es demasiado larga (máx. ${NOTE_MAX} caracteres)`);
  const paths = (Array.isArray(body?.paths) ? body.paths : body?.paths != null ? String(body.paths).split(',') : cur.paths || [])
    .map(s => String(s).trim().replace(/\\/g, '/')).filter(Boolean).slice(0, 20);
  const status = body?.status ?? cur.status ?? 'propuesta';
  if (!STATUSES.includes(status)) throw bad('Estado de nota no válido');
  return { text, paths, status };
}

export function listNotes(projectId) {
  if (!Projects.get(projectId)) return null;
  return Notes.byProject(projectId);
}
// Las del usuario nacen aprobadas; las de un agente, propuestas
export function addNote(projectId, body, { source = 'usuario', runId = null, commitRef = null } = {}) {
  if (!Projects.get(projectId)) throw bad('El proyecto no existe', 404);
  const v = cleanNote({ status: source === 'usuario' ? 'aprobada' : 'propuesta', ...body });
  return Notes.create({ projectId, ...v, source, runId, commitRef: body?.commitRef ?? commitRef });
}
export function updateNote(id, body) {
  const cur = Notes.get(id);
  if (!cur) return null;
  return Notes.update(id, cleanNote(body, cur));
}
export const deleteNote = id => Notes.remove(id);

// Notas aprobadas para un agente (las más recientes primero, hasta el presupuesto de caracteres)
export function notesForAgent(projectId) {
  const out = [];
  let size = 0;
  for (const n of Notes.byProject(projectId, 'aprobada').reverse()) {
    if (size + n.text.length > NOTES_BUDGET) break;
    size += n.text.length;
    out.push({ text: n.text, paths: n.paths, commit: n.commitRef });
  }
  return out.reverse();
}
