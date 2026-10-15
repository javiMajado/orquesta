// Puente mínimo entre la UI y la app de escritorio: solo estas funciones, sin acceso a Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orquestaDesktop', {
  // mode: 'open' (elegir fichero existente) | 'save' (elegir dónde guardar)
  pickFile: opts => ipcRenderer.invoke('orq:pick-file', opts),
  allowedFolders: () => ipcRenderer.invoke('orq:allowed-folders'),
  // Configuración de entorno
  readEnv: () => ipcRenderer.invoke('orq:read-env'),
  saveEnv: content => ipcRenderer.invoke('orq:save-env', content),
  llmProviders: () => ipcRenderer.invoke('orq:llm-providers'),
  needsSetup: () => ipcRenderer.invoke('orq:needs-setup'),
});
