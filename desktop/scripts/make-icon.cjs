// Genera assets/icon.ico (16–256 px) e icon.png (512 px) a partir de assets/icon.svg.
// Se ejecuta con Electron (renderiza el SVG en una ventana oculta): npm run icon -w desktop
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ASSETS = path.join(__dirname, '..', 'assets');
const svg = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// Se renderiza una vez a 512 px y se reduce a cada tamaño (capturar ventanas diminutas falla)
async function render(win) {
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', '<svg width="512" height="512" ')}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise(r => setTimeout(r, 400));
  return win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
}

// ICO con imágenes PNG embebidas (formato admitido desde Windows Vista)
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(([size, png], i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...pngs.map(([, p]) => p)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, backgroundColor: '#00000000', useContentSize: true, webPreferences: { offscreen: true } });
  const big = await render(win);
  const pngs = SIZES.map(s => [s, big.resize({ width: s, height: s, quality: 'best' }).toPNG()]);
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico(pngs));
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), big.toPNG());
  console.log(`[icono] ${path.join(ASSETS, 'icon.ico')} (${SIZES.join(', ')} px) e icon.png (512 px)`);
  app.quit();
});
