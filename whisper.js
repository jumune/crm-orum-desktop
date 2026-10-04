// ============================================================
//  CRM Orum · Whisper local (whisper.cpp) para la app de escritorio
//  - Arranca whisper-server una vez (modelo small, modo rápido)
//  - Cola de tramos de voz → texto
// ============================================================
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

const THREADS = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));
const PORT = 8765;
const TMP = path.join(os.tmpdir(), "orum-whisper");
const JUNK = [/amara\.org/i, /subt[ií]tulos/i, /gracias por ver/i, /suscr[ií]bete/i];

function findFile(dir, name) {
  if (!dir || !fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (e.name.toLowerCase() === name.toLowerCase()) return p;
  }
  return null;
}

function clean(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  t = t.replace(/\[[^\]]*\]/g, "").replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  if (!t || /^[.,¿?¡!\s-]*$/.test(t) || JUNK.some((re) => re.test(t))) return "";
  return t;
}

function createWhisper({ whisperDir, send, log, prepare }) {
  const MODEL = path.join(whisperDir, "models", "ggml-small.bin");
  const CPU_DIR = path.join(whisperDir, "bin", "cpu");
  let server = null, ready = false, mode = null;
  let queue = [], busy = false;

  async function ping() {
    try { const r = await fetch("http://127.0.0.1:" + PORT + "/", { signal: AbortSignal.timeout(1500) }); return r.status < 500; }
    catch (e) { return false; }
  }

  async function start() { const r = await startInner(); if (r.ok) setTimeout(pump, 0); return r; }
  async function startInner() {
    if (ready) return { ok: true, mode };
    if (prepare) {
      try { await prepare(); }
      catch (e) { return { ok: false, error: "No se pudo preparar la transcripción: " + (e.message || e) + ". Revisa tu conexión a internet y vuelve a intentarlo." }; }
    }
    if (!fs.existsSync(MODEL)) return { ok: false, error: "No encuentro el modelo de Whisper (" + MODEL + ")." };
    fs.mkdirSync(TMP, { recursive: true });
    // Si quedó un servidor de una sesión anterior en el puerto, lo reutilizamos
    if (await ping()) { ready = true; mode = "server"; return { ok: true, mode }; }
    const srv = findFile(CPU_DIR, "whisper-server.exe");
    if (srv) {
      log("Arrancando Whisper (small, " + THREADS + " hilos, modo rápido)…");
      server = spawn(srv, ["-m", MODEL, "-l", "es", "-t", String(THREADS), "--host", "127.0.0.1", "--port", String(PORT), "-ac", "768"],
        { cwd: path.dirname(srv), windowsHide: true });
      let errTail = "";
      server.stderr.on("data", (d) => { errTail = (errTail + d.toString()).slice(-2000); });
      server.stdout.on("data", () => {});
      const me = server;
      server.on("exit", () => { if (server === me) { ready = false; server = null; } });
      const t0 = Date.now();
      while (Date.now() - t0 < 40000) {
        if (await ping()) { ready = true; mode = "server"; log("Whisper listo en " + ((Date.now() - t0) / 1000).toFixed(1) + " s"); return { ok: true, mode }; }
        if (server && server.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      log("El servidor de Whisper no arrancó; uso el modo por archivos. " + errTail.split("\n").slice(-2).join(" "));
      try { if (server) server.kill(); } catch (e) {}
    }
    if (!findFile(CPU_DIR, "whisper-cli.exe")) return { ok: false, error: "No encuentro whisper.cpp en " + CPU_DIR };
    ready = true; mode = "cli";
    return { ok: true, mode };
  }

  async function transcribe(wavBuf) {
    if (mode === "server") {
      const fd = new FormData();
      fd.append("file", new Blob([wavBuf], { type: "audio/wav" }), "chunk.wav");
      fd.append("temperature", "0.0");
      fd.append("response_format", "json");
      const r = await fetch("http://127.0.0.1:" + PORT + "/inference", { method: "POST", body: fd });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return (await r.json()).text || "";
    }
    const cli = findFile(CPU_DIR, "whisper-cli.exe");
    const base = path.join(TMP, "c" + Date.now() + Math.random().toString(36).slice(2, 6));
    fs.writeFileSync(base + ".wav", Buffer.from(wavBuf));
    await new Promise((resolve) => {
      const p = spawn(cli, ["-m", MODEL, "-f", base + ".wav", "-l", "es", "-t", String(THREADS), "-nt", "-np", "-otxt", "-of", base, "-ac", "768"],
        { cwd: path.dirname(cli), windowsHide: true });
      p.on("close", resolve); p.on("error", resolve);
    });
    let txt = "";
    try { txt = fs.readFileSync(base + ".txt", "utf8"); } catch (e) {}
    try { fs.unlinkSync(base + ".wav"); fs.unlinkSync(base + ".txt"); } catch (e) {}
    return txt;
  }

  async function pump() {
    if (busy || !ready) return;   // los tramos esperan en cola hasta que Whisper esté listo
    busy = true;
    while (queue.length) {
      const job = queue.shift();
      const t0 = Date.now();
      let raw = "", error = null;
      try { raw = await transcribe(job.wav); } catch (e) { error = String(e.message || e); }
      send("live:result", { id: job.id, track: job.track, startMs: job.startMs, endMs: job.endMs, text: clean(raw), error, procMs: Date.now() - t0 });
    }
    busy = false;
  }

  return {
    start,
    push(job) { queue.push(job); pump(); },
    pending() { return queue.length + (busy ? 1 : 0); },
    reset() { queue = []; },
    stop() { try { if (server) server.kill(); } catch (e) {} server = null; ready = false; },
    paths: { MODEL, CPU_DIR },
  };
}

module.exports = { createWhisper };
