// ============================================================
//  CRM Orum · App de escritorio (v0.2 · paso 5)
//  - Abre el CRM web (orumconsulting.com/crm) en su ventana
//  - "Llamar" en una oportunidad → marca con Enlace Móvil y abre la
//    ventana de llamada con transcripción en vivo (Whisper local)
//  - Al terminar, guarda la llamada en el CRM (window.__orumSaveCall)
//    → la Edge Function la analiza y borra la transcripción.
//  No se guarda audio en ningún sitio.
// ============================================================
const { app, BrowserWindow, session, ipcMain, shell, desktopCapturer, screen, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const { createWhisper } = require("./whisper");
const { ensureWhisper, isReady } = require("./setup");

const CRM_URL = process.env.ORUM_CRM_URL || "https://orumconsulting.com/crm";
const ALLOWED = "orumconsulting.com";
// App instalada: Whisper se descarga la primera vez en la carpeta de datos de la app.
// Desarrollo (sin instalar): usa el Whisper del laboratorio (..\whisper) si existe.
const DEV_WHISPER = path.join(__dirname, "..", "whisper");
const WHISPER_DIR = (!app.isPackaged && isReady(DEV_WHISPER)) ? DEV_WHISPER : path.join(app.getPath("userData"), "whisper");
const PENDING_DIR = path.join(app.getPath("userData"), "llamadas-sin-guardar");

let crmWin = null, callWin = null, callMeta = null;

let setupState = { pct: isReady(WHISPER_DIR) ? 100 : 0, label: "" };
function prepareWhisper() {
  const firstTime = !isReady(WHISPER_DIR);
  return ensureWhisper(WHISPER_DIR, (p) => {
    setupState = p;
    if (callWin && !callWin.isDestroyed()) callWin.webContents.send("live:setup", p);
  }).then((ok) => {
    if (firstTime && Notification.isSupported()) new Notification({ title: "CRM Orum", body: "La transcripción de llamadas ya está lista." }).show();
    return ok;
  });
}

const whisper = createWhisper({
  whisperDir: WHISPER_DIR,
  prepare: prepareWhisper,
  send: (ch, data) => { if (callWin && !callWin.isDestroyed()) callWin.webContents.send(ch, data); },
  log: (m) => { console.log(m); if (callWin && !callWin.isDestroyed()) callWin.webContents.send("live:log", m); },
});

function sameSite(url) { try { return new URL(url).hostname.endsWith(ALLOWED); } catch { return false; } }

function createCrmWindow() {
  crmWin = new BrowserWindow({
    width: 1320, height: 880, minWidth: 900, title: "CRM Orum", backgroundColor: "#FAFBFC",
    webPreferences: { preload: path.join(__dirname, "preload-crm.js"), contextIsolation: true, nodeIntegration: false },
  });
  crmWin.setMenuBarVisibility(false);
  crmWin.loadURL(CRM_URL);
  crmWin.webContents.on("will-navigate", (e, url) => { if (!sameSite(url)) { e.preventDefault(); shell.openExternal(url); } });
  crmWin.webContents.setWindowOpenHandler(({ url }) => {
    // Enlaces externos y audios firmados de Supabase → navegador del sistema
    shell.openExternal(url); return { action: "deny" };
  });
  crmWin.on("closed", () => { crmWin = null; if (callWin && !callWin.isDestroyed()) callWin.close(); });
}

function openCallWindow(meta) {
  callMeta = meta;
  // Ventana de llamada pegada al borde derecho, para no tapar Enlace Móvil
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 440, h = Math.min(760, wa.height);
  callWin = new BrowserWindow({
    width: w, height: h, x: wa.x + wa.width - w, y: wa.y, minWidth: 380, title: "Llamada · CRM Orum", backgroundColor: "#FAFBFC",
    webPreferences: { preload: path.join(__dirname, "preload-call.js"), contextIsolation: true, nodeIntegration: false },
  });
  callWin.setMenuBarVisibility(false);
  callWin.loadFile(path.join(__dirname, "call.html"));
  callWin.on("closed", () => { callWin = null; callMeta = null; whisper.reset(); });
}

app.whenReady().then(() => {
  // Audio del sistema (voz del cliente) por loopback, sin diálogo. Chromium exige
  // una fuente de vídeo: damos la pantalla y la página descarta el vídeo.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ["screen"] })
      .then((s) => (s.length ? callback({ video: s[0], audio: "loopback" }) : callback({})))
      .catch(() => callback({}));
  }, { useSystemPicker: false });
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(["media", "display-capture", "clipboard-sanitized-write"].includes(permission)));

  createCrmWindow();
  try { require("electron-updater").autoUpdater.checkForUpdatesAndNotify().catch(() => {}); } catch (e) {}
  // Cargamos Whisper en segundo plano para que la primera llamada no espere
  whisper.start().catch(() => {});
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => whisper.stop());

function phoneLinkRunning() {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq PhoneExperienceHost.exe"', (err, out) => resolve(!err && /PhoneExperienceHost\.exe/i.test(out || "")));
  });
}
async function dial(numero) {
  const n = String(numero || "").replace(/[^\d+]/g, "");
  if (!n) return false;
  try { await shell.openExternal("tel:" + n); return true; } catch (e) { return false; }
}

// ---------- API para el CRM (window.orumDesktop) ----------
ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("phonelink:check", () => phoneLinkRunning());
ipcMain.handle("call:start", async (_e, { numero, meta }) => {
  if (callWin && !callWin.isDestroyed()) { callWin.focus(); return { ok: false, error: "Ya hay una llamada en curso." }; }
  const pl = await phoneLinkRunning();
  if (pl) await dial(numero);
  // Tomamos el logo ORUM tal cual lo pinta el CRM (misma marca en la ventana de llamada)
  let logo = "";
  try { logo = await crmWin.webContents.executeJavaScript("(document.querySelector('.orum-logo svg')||{}).outerHTML||''"); } catch (e) {}
  openCallWindow({ ...(meta || {}), phone: numero, phoneLink: pl, logo });
  return { ok: true, phoneLink: pl };
});
ipcMain.handle("call:stop", () => { if (callWin && !callWin.isDestroyed()) callWin.webContents.send("call:stop-request"); return { ok: true }; });

// ---------- API para la ventana de llamada ----------
ipcMain.handle("call:meta", () => callMeta);
ipcMain.handle("setup:state", () => setupState);
ipcMain.handle("call:redial", () => (callMeta ? dial(callMeta.phone) : false));
ipcMain.handle("whisper:start", () => whisper.start());
ipcMain.handle("whisper:chunk", (_e, job) => { whisper.push(job); return true; });
ipcMain.handle("whisper:pending", () => whisper.pending());
ipcMain.handle("call:save", async (_e, payload) => {
  const full = { ...payload, deal_id: callMeta && callMeta.deal_id, client_id: callMeta && callMeta.client_id, phone: callMeta && callMeta.phone };
  try {
    if (!crmWin || crmWin.isDestroyed()) throw new Error("La ventana del CRM está cerrada.");
    const has = await crmWin.webContents.executeJavaScript("typeof window.__orumSaveCall === 'function'");
    if (!has) throw new Error("El CRM no está listo (¿has iniciado sesión?).");
    await crmWin.webContents.executeJavaScript("window.__orumSaveCall(" + JSON.stringify(full) + ")");
    return { ok: true };
  } catch (e) {
    // Copia de seguridad local para no perder la llamada
    try { fs.mkdirSync(PENDING_DIR, { recursive: true }); fs.writeFileSync(path.join(PENDING_DIR, Date.now() + ".json"), JSON.stringify(full, null, 2), "utf8"); } catch (x) {}
    return { ok: false, error: String(e.message || e) };
  }
});
ipcMain.handle("call:close", () => { if (callWin && !callWin.isDestroyed()) callWin.close(); });
