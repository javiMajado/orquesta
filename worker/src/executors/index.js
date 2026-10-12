// Carga perezosa: cada dependencia solo se importa si el worker ejecuta ese tipo de nodo.
const lazy = file => (...args) => import(file).then(m => m.default(...args));

export const executors = {
  agent: lazy('./agent.js'),
  node: lazy('./script.js'),
  http: lazy('./http.js'),
  db: lazy('./db.js'),
  email: lazy('./email.js'),
  file: lazy('./file.js'),
  command: lazy('./command.js'),
};
