import { Workflows, Settings } from './db.js';
import { NODOS } from './seed-nodos.js';
import { CODING } from './seed-coding.js';

// Ejemplos: colecciones «Ejemplos de nodos» y «Coding». Cada uno se crea una sola vez (su clave queda en
// settings «seeded»): si se borra, no vuelve a crearse. Los agentes que usan se crean al crearlos.
export function seedIfEmpty() {
  const done = new Set(Settings.get('seeded', []));
  for (const [key, make] of Object.entries({ ...NODOS, ...CODING })) {
    if (done.has(key)) continue;
    Workflows.create(make());
    done.add(key);
  }
  Settings.set('seeded', [...done]);
}
