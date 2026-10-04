// ============================================================
//  CRM Orum · Preparación de Whisper la primera vez (app instalada)
//  Descarga whisper.cpp (Windows, CPU) y el modelo "small" (~465 MB)
//  a la carpeta de datos de la app. Solo ocurre una vez.
// ============================================================
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
const UA = { "User-Agent": "crm-orum-desktop" };

function findFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (e.name.toLowerCase() === name.toLowerCase()) return p;
  }
  return null;
}

function isReady(dir) {
  const m = path.join(dir, "models", "ggml-small.bin");
  return fs.existsSync(m) && fs.statSync(m).size > 400e6 && !!findFile(path.join(dir, "bin", "cpu"), "whisper-cli.exe");
}

async function download(url, dest, onBytes) {
  const res = await fetch(url, { redirect: "follow", headers: UA });
  if (!res.ok) throw new Error("HTTP " + res.status + " al descargar " + path.basename(dest));
  const total = Number(res.headers.get("content-length")) || 0;
  const tmp = dest + ".part";
  const src = Readable.fromWeb(res.body);
  let got = 0;
  src.on("data", (c) => { got += c.length; onBytes(got, total); });
  await pipeline(src, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

async function whisperZipUrl() {
  const r = await fetch("https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=10", { headers: UA });
  if (!r.ok) throw new Error("No se pudo consultar whisper.cpp (HTTP " + r.status + ")");
  for (const rel of await r.json()) {
    const a = (rel.assets || []).find((x) => /^whisper-bin-x64\.zip$/i.test(x.name));
    if (a) return a.browser_download_url;
  }
  throw new Error("No se encontró el paquete de whisper.cpp para Windows");
}

let running = null;
// onProgress({ pct, label })
function ensureWhisper(dir, onProgress) {
  if (isReady(dir)) return Promise.resolve(true);
  if (running) return running;
  running = (async () => {
    fs.mkdirSync(path.join(dir, "models"), { recursive: true });
    const binDir = path.join(dir, "bin", "cpu");
    if (!findFile(binDir, "whisper-cli.exe")) {
      onProgress({ pct: 1, label: "Descargando el motor de transcripción…" });
      const zip = path.join(dir, "whisper-bin-x64.zip");
      await download(await whisperZipUrl(), zip, () => {});
      fs.mkdirSync(binDir, { recursive: true });
      await new Promise((resolve, reject) => execFile("tar", ["-xf", zip, "-C", binDir], (e) => (e ? reject(e) : resolve())));
      try { fs.unlinkSync(zip); } catch (e) {}
    }
    const model = path.join(dir, "models", "ggml-small.bin");
    if (!(fs.existsSync(model) && fs.statSync(model).size > 400e6)) {
      let last = -1;
      await download(MODEL_URL, model, (got, total) => {
        const pct = total ? Math.floor(3 + (got / total) * 97) : 50;
        if (pct !== last) { last = pct; onProgress({ pct, label: "Descargando el modelo de voz (" + Math.round(got / 1048576) + " MB)…" }); }
      });
    }
    onProgress({ pct: 100, label: "Transcripción lista" });
    return true;
  })().finally(() => { running = null; });
  return running;
}

module.exports = { ensureWhisper, isReady };
