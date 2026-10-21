// ============================================================
//  CRM Orum · App de escritorio (v0.2 · paso 5)
//  - Abre el CRM web (orumconsulting.com/crm) en su ventana
//  - "Llamar" en una oportunidad → marca con Enlace Móvil y abre la
//    ventana de llamada con transcripción en vivo (Whisper local)
//  - Al terminar, guarda la llamada en el CRM (window.__orumSaveCall)
//    → la Edge Function la analiza y borra la transcripción.
//  v0.4: el audio de las llamadas de 30 s o más se sube a Supabase
//  (almacén privado «grabaciones», solo lo escucha el admin).
//  En el PC del ADMIN, la app descarga cada hora esos audios a
//  Documentos\orum-desktop\grabaciones (se borran de ahí a los 90 días);
//  Supabase borra cada audio en cuanto se descarga, o a los 16 días si no se pudo.
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

// ---------- Subida del audio a Supabase (solo producción) ----------
// La clave anon es pública por diseño (la misma que lleva crm.html); la seguridad la ponen
// las políticas del almacén: cada comercial solo puede SUBIR a su carpeta y solo el admin escucha.
const PROD_REF = "badmyjshxmulpztozohl";
const PROD_URL = "https://" + PROD_REF + ".supabase.co";
const PROD_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhZG15anNoeG11bHB6dG96b2hsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1NzQzMTQsImV4cCI6MjEwNTE1MDMxNH0.Y3L-rYHiBYJuewGFT8hFVXqXOcNsjAFJeUhsJI__7rk";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sesión del CRM abierta en la ventana principal (la refresca el propio CRM)
async function crmSession() {
  const js = "(function(){try{if(localStorage.getItem('orum_env')==='demo')return{demo:true};" +
    "var s=JSON.parse(localStorage.getItem('sb-" + PROD_REF + "-auth-token')||'null');" +
    "return s&&s.access_token?{t:s.access_token,u:s.user&&s.user.id,exp:s.expires_at||0}:null;}catch(e){return null}})()";
  for (let i = 0; i < 40; i++) {
    if (!crmWin || crmWin.isDestroyed()) return null;
    const s = await crmWin.webContents.executeJavaScript(js).catch(() => null);
    if (!s || s.demo) return s;
    if (s.exp * 1000 > Date.now() + 30000) return s;
    await sleep(1000);                               // a punto de caducar: el CRM la renueva solo
  }
  return null;
}

async function uploadRecording(full, audio) {
  const s = await crmSession();
  if (s && s.demo) return "demo";                    // en el entorno de prueba no se guarda audio
  if (!s || !s.u) throw new Error("sin sesión del CRM");
  if (!full.client_id) throw new Error("llamada sin cliente");
  const ms = new Date(full.started_at).getTime();
  if (!ms) throw new Error("llamada sin hora de inicio");
  // El nombre lleva comercial + hora de inicio: así Supabase la une sola a la llamada que se guarda después
  const objPath = full.client_id + "/llamadas/" + s.u + "_" + ms + ".webm";
  let last = "";
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(PROD_URL + "/storage/v1/object/grabaciones/" + objPath, {
        method: "POST",
        headers: { Authorization: "Bearer " + s.t, apikey: PROD_ANON, "Content-Type": "audio/webm", "x-upsert": "false" },
        body: Buffer.from(audio),
      });
      if (r.ok) return "ok";
      last = "HTTP " + r.status + " " + (await r.text()).slice(0, 200);
      if (r.status < 500) break;
    } catch (e) { last = String(e.message || e); }
    await sleep(2000);
  }
  throw new Error(last || "fallo desconocido");
}

// ---------- Descarga de las grabaciones al PC del admin ----------
const ARCHIVE_DIR = path.join(app.getPath("documents"), "orum-desktop", "grabaciones");
let archiving = false, archiveOff = false, localKeepDays = 90;
const safeName = (x) => String(x || "").normalize("NFC").replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "sin-nombre";
function madridParts(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { day: p.year + "-" + p.month + "-" + p.day, ym: p.year + "-" + p.month, hm: p.hour + "." + p.minute };
}
async function rest(s, method, url, body) {
  const r = await fetch(PROD_URL + url, { method, headers: { Authorization: "Bearer " + s.t, apikey: PROD_ANON, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + " " + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : null;
}
function archiveLog(line) {
  try { fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    fs.appendFileSync(path.join(ARCHIVE_DIR, "_registro.txt"), new Date().toISOString().slice(0, 16).replace("T", " ") + "  " + line + "\r\n", "utf8"); } catch (e) {}
}
// Borra del PC los audios con más de N días (la fecha del archivo es la de la llamada)
function cleanLocal(days) {
  const limit = Date.now() - days * 864e5; let n = 0;
  const walk = (dir) => {
    let items = []; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const it of items) {
      const f = path.join(dir, it.name);
      if (it.isDirectory()) { walk(f); try { if (!fs.readdirSync(f).length) fs.rmdirSync(f); } catch (e) {} }
      else if (/\.webm$/i.test(it.name)) { try { if (fs.statSync(f).mtimeMs < limit) { fs.unlinkSync(f); n++; } } catch (e) {} }
    }
  };
  walk(ARCHIVE_DIR);
  return n;
}
async function archiveRecordings() {
  if (archiving || archiveOff) return;
  archiving = true;
  try {
    const s = await crmSession();
    if (!s || s.demo || !s.u) return;                       // sin sesión o en la demo: nada
    let rows;
    try { rows = await rest(s, "POST", "/rest/v1/rpc/grab_pending_downloads", { p_limit: 50 }); }
    catch (e) { if (/Solo el administrador/.test(String(e.message))) archiveOff = true; return; }   // comerciales: nunca
    try { const c = await rest(s, "GET", "/rest/v1/grab_config?select=local_keep_days&id=eq.1"); if (c && c[0] && c[0].local_keep_days > 0) localKeepDays = c[0].local_keep_days; } catch (e) {}
    let ok = 0; const errs = [];
    for (const r of rows || []) {
      try {
        const when = madridParts(r.started_at || r.created_at);
        const rel = path.join(safeName(r.client_name), when.ym,
          when.day + "_" + when.hm + "_" + safeName(r.comercial_name) + "_" + safeName(r.contact) + "_" + String(r.call_id).slice(0, 8) + ".webm");
        const full = path.join(ARCHIVE_DIR, rel);
        const res = await fetch(PROD_URL + "/storage/v1/object/authenticated/grabaciones/" + r.path, { headers: { Authorization: "Bearer " + s.t, apikey: PROD_ANON } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length || (Number(r.bytes) > 0 && buf.length !== Number(r.bytes))) throw new Error("descarga incompleta");
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full + ".part", buf);
        fs.renameSync(full + ".part", full);
        const t = new Date(r.started_at || r.created_at); fs.utimesSync(full, t, t);
        if (fs.statSync(full).size !== buf.length) throw new Error("no se pudo escribir en el disco");
        await rest(s, "POST", "/rest/v1/rpc/grab_mark_downloaded", { p_path: r.path, p_local: rel });   // Supabase lo borrará en la hora siguiente
        ok++;
      } catch (e) { errs.push(String(r.path).split("/").pop() + ": " + String(e.message || e)); }
    }
    const del = cleanLocal(localKeepDays);
    if (ok || errs.length || del) archiveLog("descargadas " + ok + (del ? " · borradas del PC (más de " + localKeepDays + " días) " + del : "") + (errs.length ? " · errores: " + errs.slice(0, 5).join(" | ") : ""));
  } catch (e) { archiveLog("error: " + String(e.message || e)); }
  finally { archiving = false; }
}

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
  // Descarga de grabaciones al PC (solo hace algo si el usuario es admin): a los 2 min y cada hora
  setTimeout(() => archiveRecordings(), 2 * 60e3);
  setInterval(() => archiveRecordings(), 60 * 60e3);
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
ipcMain.handle("call:save", async (_e, payload, audio) => {
  const full = { ...payload, deal_id: callMeta && callMeta.deal_id, client_id: callMeta && callMeta.client_id, phone: callMeta && callMeta.phone };
  // 1) Audio primero (antes de guardar la llamada, para que Supabase la una sola)
  let audioRes = "no";
  if (audio && audio.byteLength > 0) {
    try { audioRes = await uploadRecording(full, audio); }
    catch (e) {
      audioRes = "error: " + String(e.message || e);
      console.log("Audio no subido:", audioRes);
      try { fs.mkdirSync(PENDING_DIR, { recursive: true }); fs.writeFileSync(path.join(PENDING_DIR, Date.now() + ".webm"), Buffer.from(audio)); } catch (x) {}
    }
  }
  try {
    if (!crmWin || crmWin.isDestroyed()) throw new Error("La ventana del CRM está cerrada.");
    const has = await crmWin.webContents.executeJavaScript("typeof window.__orumSaveCall === 'function'");
    if (!has) throw new Error("El CRM no está listo (¿has iniciado sesión?).");
    await crmWin.webContents.executeJavaScript("window.__orumSaveCall(" + JSON.stringify(full) + ")");
    return { ok: true, audio: audioRes };
  } catch (e) {
    // Copia de seguridad local para no perder la llamada
    try { fs.mkdirSync(PENDING_DIR, { recursive: true }); fs.writeFileSync(path.join(PENDING_DIR, Date.now() + ".json"), JSON.stringify(full, null, 2), "utf8"); } catch (x) {}
    return { ok: false, error: String(e.message || e), audio: audioRes };
  }
});
ipcMain.handle("call:close", () => { if (callWin && !callWin.isDestroyed()) callWin.close(); });
