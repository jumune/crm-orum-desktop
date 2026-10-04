// Puente seguro de la ventana de llamada
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("call", {
  meta: () => ipcRenderer.invoke("call:meta"),
  setupState: () => ipcRenderer.invoke("setup:state"),
  redial: () => ipcRenderer.invoke("call:redial"),
  whisperStart: () => ipcRenderer.invoke("whisper:start"),
  sendChunk: (job) => ipcRenderer.invoke("whisper:chunk", job),
  pending: () => ipcRenderer.invoke("whisper:pending"),
  save: (payload) => ipcRenderer.invoke("call:save", payload),
  close: () => ipcRenderer.invoke("call:close"),
  on: (ch, cb) => {
    if (!/^(live:|call:stop-request)/.test(ch)) return () => {};
    const h = (_e, d) => cb(d);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  },
});
