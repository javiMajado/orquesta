import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// App de escritorio: arranca dentro el servidor de Orquesta (motor + worker embebido) en un
// puerto local libre y muestra la UI en una ventana. Los datos van a %APPDATA%\Orquesta.

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
// ORQ_DESKTOP_DATA: carpeta de datos alternativa (pruebas); ORQ_DESKTOP_SMOKE: captura de la ventana y salir
if (process.env.ORQ_DESKTOP_DATA) app.setPath('userData', path.resolve(process.env.ORQ_DESKTOP_DATA));
const DATA = app.getPath('userData');
const CONFIG = path.join(DATA, 'escritorio.json');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
// Identidad propia en Windows: barra de tareas e icono separados de otras apps de Electron
app.setAppUserModelId('com.orquesta.desktop');
const ICON = path.join(here, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
const writeConfig = c => fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2));
const splitDirs = v => String(v || '').split(';').map(s => s.trim()).filter(Boolean);
const isInside = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const portFree = port => new Promise(resolve => {
  const s = net.createServer().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

// Puerto fijo, para poder lanzar workflows desde fuera (webhooks /hooks/*, API). Se toma de
// ORQ_DESKTOP_PORT (variable de entorno o el .env de la app); por defecto 3100, para no chocar con
// «npm run dev» (3000). 0 = uno libre distinto en cada arranque.
const DEFAULT_PORT = 3100;
function wantedPort(envFile) {
  let v = process.env.ORQ_DESKTOP_PORT;
  if (v == null && envFile) {
    try { v = fs.readFileSync(envFile, 'utf8').match(/^[ \t]*ORQ_DESKTOP_PORT[ \t]*=[ \t]*["']?(\d*)["']?[ \t\r]*$/m)?.[1]; } catch {}
  }
  const n = v == null || v === '' ? DEFAULT_PORT : Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DEFAULT_PORT;
}

// Primera ejecución: copia la BD de desarrollo (data/orquesta.db) para conservar tus workflows.
// VACUUM INTO hace una copia coherente aunque el servidor de desarrollo esté en marcha.
function importDevDb(dest) {
  const dev = path.join(ROOT, 'data', 'orquesta.db');
  if (fs.existsSync(dest) || !fs.existsSync(dev)) return false;
  const src = new DatabaseSync(dev, { readOnly: true });
  try { src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); } finally { src.close(); }
  return true;
}

let base = '';
let win = null;
let grants = null; // server/src/grants.js (misma instancia que usa el servidor)
let portWarning = ''; // el puerto configurado estaba ocupado

async function startServer() {
  fs.mkdirSync(DATA, { recursive: true });
  const dbFile = path.join(DATA, 'orquesta.db');
  let imported = false;
  try { imported = importDevDb(dbFile); } catch (e) { console.warn('[escritorio] no se pudo importar la BD de desarrollo:', e.message); }
  // .env: el de la carpeta de la app si existe; si no, el del proyecto (modo desarrollo)
  let envFile = [path.join(DATA, '.env'), path.join(ROOT, '.env')].find(f => fs.existsSync(f));
  // App instalada sin configuración: se crea %APPDATA%\Orquesta\.env desde la plantilla
  const template = path.join(ROOT, 'env.example');
  if (!envFile && fs.existsSync(template)) {
    envFile = path.join(DATA, '.env');
    fs.copyFileSync(template, envFile);
  }
  const wanted = wantedPort(envFile);
  let port = wanted;
  if (!wanted || !(await portFree(wanted))) {
    port = await freePort();
    if (wanted) portWarning = `El puerto ${wanted} está ocupado (¿otra copia de Orquesta o «npm start»?), así que la app usa el ${port} en esta sesión. Los webhooks y la API estarán en http://127.0.0.1:${port} hasta que lo liberes y reinicies la app. Puedes cambiar el puerto con ORQ_DESKTOP_PORT en ${envFile || 'el .env'}.`;
  }
  Object.assign(process.env, { PORT: String(port), HOST: '127.0.0.1', DB_FILE: dbFile, ORQ_BASE_DIR: DATA, ...(envFile ? { ORQ_ENV_FILE: envFile } : {}) });
  console.log(`[escritorio] datos en ${DATA}${imported ? ' (BD importada de data/orquesta.db)' : ''} · .env: ${envFile || 'ninguno'} · http://127.0.0.1:${port}${portWarning ? ' (puerto configurado ocupado)' : ''}`);

  await import(pathToFileURL(path.join(ROOT, 'server', 'src', 'index.js')).href);
  grants = await import(pathToFileURL(path.join(ROOT, 'server', 'src', 'grants.js')).href);

  // Versiones anteriores guardaban en escritorio.json las carpetas autorizadas: pasan a Permisos
  const cfg = readConfig();
  if (cfg.filesAllow?.length) {
    for (const dir of cfg.filesAllow) { try { grants.grant({ path: dir, read: true, write: true, by: 'escritorio' }); } catch {} }
    delete cfg.filesAllow;
    writeConfig(cfg);
  }

  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('El servidor interno no arrancó');
}

// Carpetas permitidas: las fijas del .env (lectura y escritura) + las concedidas en Permisos
function allowedDirs({ write = false } = {}) {
  const granted = (grants?.listGrants().grants || []).filter(g => (write ? g.write : g.read || g.write)).map(g => g.path);
  return [...splitDirs(process.env.ORQ_FILES_ALLOW), ...granted];
}

// Si el fichero elegido está fuera de las carpetas permitidas, se pide permiso explícito y se guarda
// en Permisos (el mismo sitio que los permisos concedidos al ejecutar)
async function ensureAllowed(file, { write = false } = {}) {
  const target = fs.existsSync(file) ? fs.realpathSync(file) : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  const ok = allowedDirs({ write }).some(d => { try { return isInside(fs.realpathSync(d), target); } catch { return false; } });
  if (ok) return { allowed: true };
  const folder = path.dirname(target);
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Permitir esta carpeta', 'Cancelar'], defaultId: 0, cancelId: 1, noLink: true,
    title: 'Carpeta no permitida',
    message: `¿Permitir que los workflows ${write ? 'lean y escriban' : 'lean'} ficheros en esta carpeta?\n\n${folder}`,
    detail: 'Los nodos solo pueden acceder a carpetas permitidas. Puedes revisarlas y revocarlas en la pantalla «Permisos».',
  });
  if (response !== 0) return { allowed: false };
  grants.grant({ path: folder, read: true, write, by: 'escritorio' });
  return { allowed: true, added: folder };
}

const FILTERS = [
  { name: 'Documentos', extensions: ['pdf', 'md', 'txt', 'csv', 'json'] },
  { name: 'Todos los ficheros', extensions: ['*'] },
];

function registerIpc() {
  // Solo la UI de Orquesta puede pedir diálogos
  const fromApp = e => e.senderFrame && new URL(e.senderFrame.url).origin === base;

  ipcMain.handle('orq:pick-file', async (e, { mode = 'open', current = '', purpose = 'file' } = {}) => {
    if (!fromApp(e)) throw new Error('Origen no permitido');
    const defaultPath = current && path.isAbsolute(current) ? current : allowedDirs()[0];
    // Carpeta para la pantalla Permisos: allí mismo se concede, aquí solo se elige
    if (purpose === 'folder') {
      const r = await dialog.showOpenDialog(win, { title: 'Elegir carpeta', defaultPath, properties: ['openDirectory'] });
      return r.canceled || !r.filePaths?.[0] ? { canceled: true } : { path: r.filePaths[0] };
    }
    const r = mode === 'save'
      ? await dialog.showSaveDialog(win, { title: 'Guardar resultado en…', defaultPath, filters: FILTERS })
      : await dialog.showOpenDialog(win, { title: 'Elegir fichero', defaultPath, properties: ['openFile'], filters: purpose === 'db' ? [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] }, { name: 'Todos los ficheros', extensions: ['*'] }] : FILTERS });
    const file = mode === 'save' ? r.filePath : r.filePaths?.[0];
    if (r.canceled || !file) return { canceled: true };
    // Fichero de una conexión SQLite: no pasa por las carpetas del nodo Fichero
    if (purpose === 'db') return { path: file };
    const a = await ensureAllowed(file, { write: mode === 'save' });
    return a.allowed ? { path: file, added: a.added || null } : { canceled: true, reason: 'Carpeta no permitida' };
  });

  ipcMain.handle('orq:allowed-folders', e => (fromApp(e) ? allowedDirs() : []));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 640, title: 'Orquesta', icon: ICON, backgroundColor: '#14141a', show: false,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  // La ventana solo muestra Orquesta; los enlaces externos se abren en el navegador
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url) && !url.startsWith(base)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(base)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (_e, i) => { if (i.type === 'keyDown' && i.key === 'F12') win.webContents.toggleDevTools(); });
  win.loadURL(base);
  if (process.env.ORQ_DESKTOP_SMOKE) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const bridge = await win.webContents.executeJavaScript('typeof window.orquestaDesktop?.pickFile + " / node: " + typeof require');
      console.log(`[escritorio] humo · ${base} · puente: ${bridge}`);
      fs.writeFileSync(process.env.ORQ_DESKTOP_SMOKE, (await win.webContents.capturePage()).toPNG());
      app.quit();
    }, 2500));
  }
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)); // cámara, micro, notificaciones…: no
  try {
    await startServer();
  } catch (e) {
    dialog.showErrorBox('Orquesta no pudo arrancar', String(e?.stack || e));
    app.quit();
    return;
  }
  if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
    dialog.showErrorBox('Falta la interfaz', 'No existe web/dist. Ejecuta «npm run desktop» (compila la UI antes de abrir la app).');
    app.quit();
    return;
  }
  registerIpc();
  createWindow();
  if (portWarning) dialog.showMessageBox(win, { type: 'warning', title: 'Puerto ocupado', message: portWarning, noLink: true });
});
