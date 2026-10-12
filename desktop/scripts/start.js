// Lanza la app de escritorio. Quita ELECTRON_RUN_AS_NODE (lo heredan terminales lanzadas desde
// algunas extensiones de VS Code): con ella Electron arranca como Node y no abre ventana.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
const dir = fileURLToPath(new URL('..', import.meta.url));
const child = spawn(electron, [dir, ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: false });
child.on('exit', code => process.exit(code ?? 0));
