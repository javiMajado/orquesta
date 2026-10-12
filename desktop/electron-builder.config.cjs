// Instalador de Windows (NSIS). Se empaqueta la copia preparada por scripts/stage.js.
const electron = require('../node_modules/electron/package.json');

module.exports = {
  appId: 'com.orquesta.desktop',
  productName: 'Orquesta',
  directories: { app: 'build/app', output: 'dist' },
  // Reutiliza el Electron ya descargado en node_modules en lugar de bajarlo otra vez
  electronDist: '../node_modules/electron/dist',
  electronVersion: electron.version,
  npmRebuild: false, // no hay módulos nativos
  asar: true,
  files: ['**/*'],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon.ico',
    // Sin certificado: no se firma, pero sí se aplican icono y metadatos al .exe
    signExecutable: false,
  },
  nsis: {
    oneClick: true,          // instalación en un clic, sin preguntas
    perMachine: false,       // para el usuario actual: no pide permisos de administrador
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Orquesta',
    installerIcon: 'assets/icon.ico',
    uninstallerIcon: 'assets/icon.ico',
    runAfterFinish: true,
    deleteAppDataOnUninstall: false, // desinstalar no borra tus workflows (%APPDATA%\Orquesta)
  },
  artifactName: 'Orquesta-Setup-${version}.${ext}',
};
