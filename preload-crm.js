// Puente seguro CRM web <-> app. Expone window.orumDesktop (lo usa crm.html).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orumDesktop", {
  version: () => ipcRenderer.invoke("app:version"),
  isPhoneLinkRunning: () => ipcRenderer.invoke("phonelink:check"),
  // meta = { deal_id, client_id, name, comercial_id }
  startCall: (numero, meta) => ipcRenderer.invoke("call:start", { numero, meta }),
  stopCall: () => ipcRenderer.invoke("call:stop"),
  onState: () => () => {},
});
