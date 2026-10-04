// ============================================================
//  CRM Orum · Ventana de llamada (transcripción en vivo)
//  Pista "comercial" = micrófono · pista "cliente" = audio del sistema.
//  Cada pista se pasa a 16 kHz, se detectan tramos de voz y cada tramo
//  se transcribe con Whisper local. No se guarda audio.
// ============================================================
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var SR = 16000, FRAME = 480;                                   // 30 ms
  var PREROLL = 15, SHORT_SIL = 20, LONG_SIL = 50, KEEP_TAIL = 10, MIN_VOICED = 10, MIN_SEG = SR * 4, MAX_SEG = SR * 14, START_FRAMES = 3;
  var WHO = { mic: "COMERCIAL", sys: "CLIENTE" };

  var meta = {}, ctx = null, micStream = null, sysStream = null, T = {};
  var live = false, t0 = 0, timer = null, seq = 0, msgs = {}, finishing = false, sysHeard = false;
  // Anti-eco: la voz del cliente que se cuela por el micro (auriculares) no debe contar como del comercial
  var sysV = [], sysD = [], bleedDropped = 0;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function db(v) { return v > 0 ? 20 * Math.log10(v) : -120; }
  function mmss(ms) { var s = Math.max(0, Math.floor(ms / 1000)); return (s < 600 ? "0" : "") + Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function pill(text, cls) { $("wh").textContent = text; $("wh").className = "pill" + (cls ? " " + cls : ""); }
  function note(t) { $("note").textContent = t || ""; }
  function manual() { return $("mode").value === "manual"; }

  window.call.on("live:result", onResult);
  window.call.on("live:log", function (m) { console.log(m); });
  window.call.on("live:setup", function (p) {
    if (p.pct < 100) { pill("Preparando transcripción " + p.pct + "%", "warn"); note(p.label + " Solo ocurre la primera vez; la llamada ya se está grabando y se transcribirá al terminar la descarga."); }
  });
  window.call.on("call:stop-request", function () { finish(); });

  // ---------- Captura ----------
  function newTrack(key, stream) {
    var src = ctx.createMediaStreamSource(stream);
    var an = ctx.createAnalyser(); an.fftSize = 2048;
    var proc = ctx.createScriptProcessor(4096, 1, 1);
    var mute = ctx.createGain(); mute.gain.value = 0;               // nunca se reproduce (sin eco)
    src.connect(an); src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    // Reloj común: si la pista se crea a mitad de llamada, empieza en el instante actual
    var pos0 = live ? Math.round((Date.now() - t0) / 1000 * SR / FRAME) * FRAME : 0;
    var t = { key: key, src: src, proc: proc, an: an, left: new Float32Array(0), fbuf: [], pos: pos0, noise: -60, segD: [],
      state: "idle", count: 0, sil: 0, voiced: 0, seg: [], segStart: 0, pre: [] };
    proc.onaudioprocess = function (e) { if (live && T[key] === t) feed(t, e.inputBuffer.getChannelData(0)); };
    return t;
  }
  function dropTrack(key) {
    var t = T[key]; if (!t) return;
    if (t.state === "speech") close(t);
    try { t.src.disconnect(); t.proc.disconnect(); } catch (e) {}
    delete T[key];
  }
  function getMic(id) {
    var c = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (id) c.deviceId = { exact: id };
    return navigator.mediaDevices.getUserMedia({ audio: c }).catch(function () {
      return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    });
  }
  async function startMic() {
    micStream = await getMic(lsGet("orum_mic"));
    var devs = await navigator.mediaDevices.enumerateDevices();
    var cur = micStream.getAudioTracks()[0].getSettings().deviceId;
    $("mic").innerHTML = devs.filter(function (d) { return d.kind === "audioinput"; }).map(function (d) {
      return '<option value="' + esc(d.deviceId) + '"' + (d.deviceId === cur ? " selected" : "") + ">" + esc(d.label || "Micrófono") + "</option>";
    }).join("");
    T.mic = newTrack("mic", micStream);
  }
  async function startSys() {
    sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    sysStream.getVideoTracks().forEach(function (v) { v.enabled = false; });
    var a = sysStream.getAudioTracks();
    if (!a.length) throw new Error("Windows no ha entregado el audio del sistema");
    T.sys = newTrack("sys", new MediaStream(a));
  }
  function stopSys() { dropTrack("sys"); if (sysStream) { sysStream.getTracks().forEach(function (t) { t.stop(); }); sysStream = null; } }

  async function changeMic() {
    try {
      dropTrack("mic"); if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); });
      micStream = await getMic($("mic").value);
      T.mic = newTrack("mic", micStream);
      lsSet("orum_mic", $("mic").value);
    } catch (e) { note("No se pudo cambiar el micrófono: " + e.message); }
  }
  async function changeMode() {
    if (manual()) { stopSys(); $("sys-lbl").style.opacity = ".35"; note("Modo manual: pon el móvil en altavoz cerca del micrófono. Se grabarán las dos voces juntas."); }
    else {
      try { await startSys(); $("sys-lbl").style.opacity = "1"; note(""); }
      catch (e) { $("mode").value = "manual"; changeMode(); note("No se pudo capturar el audio del sistema; sigue en modo manual."); }
    }
  }

  var abuf = new Float32Array(2048);
  function draw() {
    ["mic", "sys"].forEach(function (k) {
      var t = T[k], bar = $(k + "-bar");
      if (!t) { bar.style.width = "0"; return; }
      t.an.getFloatTimeDomainData(abuf);
      var s = 0; for (var i = 0; i < abuf.length; i++) s += abuf[i] * abuf[i];
      bar.style.width = Math.max(0, Math.min(100, (db(Math.sqrt(s / abuf.length)) + 60) / 60 * 100)) + "%";
    });
    requestAnimationFrame(draw);
  }

  // ---------- 16 kHz + detección de voz ----------
  function feed(t, block) {
    var ratio = ctx.sampleRate / SR;
    var acc = new Float32Array(t.left.length + block.length);
    acc.set(t.left, 0); acc.set(block, t.left.length);
    var n = Math.floor(acc.length / ratio), out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var a = Math.floor(i * ratio), b = Math.floor((i + 1) * ratio), s = 0;
      for (var j = a; j < b; j++) s += acc[j];
      out[i] = s / Math.max(1, b - a);
    }
    t.left = acc.slice(Math.floor(n * ratio));
    for (var k = 0; k < out.length; k++) {
      t.fbuf.push(out[k]);
      if (t.fbuf.length === FRAME) { frame(t, new Float32Array(t.fbuf)); t.fbuf = []; }
    }
  }
  function frame(t, f) {
    var at = t.pos; t.pos += FRAME;
    var s = 0; for (var i = 0; i < f.length; i++) s += f[i] * f[i];
    var d = db(Math.sqrt(s / f.length));
    t.noise = d < t.noise ? d : t.noise + 0.01;
    var voiced = d > Math.max(-48, t.noise + 10);
    if (voiced && t.key === "sys" && !sysHeard) { sysHeard = true; note("Llamada en curso ✓ — se oye al cliente."); }
    var idx = at / FRAME;
    if (t.key === "sys") { sysV[idx] = voiced; sysD[idx] = d; }
    if (t.state === "idle") {
      t.pre.push({ f: f, at: at, d: d }); if (t.pre.length > PREROLL) t.pre.shift();
      t.count = voiced ? t.count + 1 : 0;
      if (t.count >= START_FRAMES) {
        t.state = "speech"; t.sil = 0; t.voiced = t.count;
        t.seg = t.pre.map(function (p) { return p.f; }); t.segD = t.pre.map(function (p) { return p.d; }); t.segStart = t.pre[0].at; t.pre = []; t.count = 0;
        var o = T[t.key === "mic" ? "sys" : "mic"];
        if (o && o.state === "speech" && o.sil >= SHORT_SIL) close(o);        // cambio de turno
      }
      return;
    }
    t.seg.push(f); t.segD.push(d);
    if (voiced) { t.sil = 0; t.voiced++; } else t.sil++;
    var len = t.seg.length * FRAME;
    if (t.sil >= LONG_SIL || (t.sil >= SHORT_SIL && len >= MIN_SEG)) close(t);
    else if (len >= MAX_SEG) { emit(t, 0); t.seg = []; t.segD = []; t.segStart = t.pos; t.voiced = 0; }
  }
  function close(t) { emit(t, Math.max(0, t.sil - KEEP_TAIL)); t.state = "idle"; t.sil = 0; }
  function corr(a, b) {
    var n = a.length, ma = 0, mb = 0, i; for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
    var sab = 0, saa = 0, sbb = 0; for (i = 0; i < n; i++) { var x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
  }
  // ¿Este tramo del micro es la voz del cliente colándose por los auriculares?
  // Si el volumen del micro "sigue" al del cliente (correlación alta) mientras el cliente habla, es eco.
  function isBleed(t, dl) {
    if (t.key !== "mic" || !T.sys) return false;
    var start = t.segStart / FRAME, best = 0, sysOn = 0;
    for (var j = 0; j < dl.length; j++) if (sysV[start + j]) sysOn++;
    if (sysOn / Math.max(1, dl.length) <= 0.5) return false;
    for (var lag = 0; lag <= 3; lag++) {
      var a = [], b = [];
      for (var k = 0; k < dl.length; k++) { var sd = sysD[start + k - lag]; if (sd !== undefined) { a.push(dl[k]); b.push(sd); } }
      if (a.length > 10) best = Math.max(best, corr(a, b));
    }
    return best > 0.6;
  }
  function emit(t, drop) {
    var keep = Math.max(0, t.seg.length - drop);
    var frames = t.seg.slice(0, keep), dl = (t.segD || []).slice(0, keep), voiced = t.voiced;
    t.seg = []; t.segD = []; t.voiced = 0;
    if (voiced < MIN_VOICED || !frames.length) return;
    if (isBleed(t, dl)) { bleedDropped++; console.log("Tramo del micro descartado por eco del cliente (" + bleedDropped + ")"); return; }
    var pcm = new Float32Array(frames.length * FRAME);
    frames.forEach(function (fr, i) { pcm.set(fr, i * FRAME); });
    var peak = 0; for (var i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    var g = peak > 0 ? Math.min(8, 0.9 / peak) : 1;
    for (var j = 0; j < pcm.length; j++) pcm[j] *= g;
    var id = "c" + (++seq);
    var track = manual() ? "mix" : t.key;
    var startMs = Math.round(t.segStart / SR * 1000), endMs = Math.round((t.segStart + pcm.length) / SR * 1000);
    msgs[id] = { track: track, startMs: startMs, endMs: endMs, text: "", pending: true };
    render();
    window.call.sendChunk({ id: id, track: track, startMs: startMs, endMs: endMs, wav: toWav(pcm) });
  }
  function toWav(x) {
    var buf = new ArrayBuffer(44 + x.length * 2), v = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, "RIFF"); v.setUint32(4, 36 + x.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, SR, true);
    v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, x.length * 2, true);
    for (var i = 0; i < x.length; i++) { var s = Math.max(-1, Math.min(1, x[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return buf;
  }

  // ---------- Texto ----------
  function onResult(r) {
    var m = msgs[r.id]; if (!m) return;
    m.pending = false; m.text = r.text || "";
    render();
  }
  function sortedIds() { return Object.keys(msgs).sort(function (a, b) { return msgs[a].startMs - msgs[b].startMs; }); }
  function render() {
    var html = sortedIds().filter(function (id) { return msgs[id].pending || msgs[id].text; }).map(function (id) {
      var m = msgs[id], cls = m.track === "mic" ? "com" : "", who = m.track === "mic" ? "Tú" : (m.track === "sys" ? "Cliente" : "Conversación");
      return '<div class="msg ' + cls + (m.pending ? " pend" : "") + '"><div class="w">' + who + " · " + mmss(m.startMs) + "</div>" + (m.pending ? "transcribiendo…" : esc(m.text)) + "</div>";
    }).join("");
    var box = $("tx"), bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = html || '<div class="empty">La transcripción aparecerá aquí mientras habláis.</div>';
    if (bottom) box.scrollTop = box.scrollHeight;
  }

  // ---------- Inicio ----------
  function startLive() {
    live = true; t0 = Date.now();
    $("dot").className = "dot on"; $("finish").disabled = false;
    timer = setInterval(function () { $("time").textContent = mmss(Date.now() - t0); }, 500);
  }

  async function init() {
    meta = (await window.call.meta()) || {};
    if (meta.logo) $("logo").innerHTML = meta.logo; else $("logo").innerHTML = '<span class="wm">ORUM</span>';
    $("deal").textContent = meta.name || "Llamada";
    $("phone").textContent = meta.phone || "";
    if (!meta.phoneLink) { $("mode").value = "manual"; }
    var wp = window.call.whisperStart();
    try {
      ctx = new AudioContext();
      await startMic();
      if (!manual()) { try { await startSys(); } catch (e) { $("mode").value = "manual"; } }
      if (manual()) {
        $("sys-lbl").style.opacity = ".35";
        note(meta.phoneLink ? "Modo manual: pon el móvil en altavoz cerca del micrófono." :
          "Enlace Móvil no está abierto: marca desde tu móvil, ponlo en altavoz cerca del micrófono y habla con normalidad.");
      } else note("En Enlace Móvil pulsa el botón verde «Llamar» para iniciar la llamada. La grabación ya está activa: solo se transcribe cuando alguien habla.");
      requestAnimationFrame(draw);
    } catch (e) { pill("Sin micrófono", "err"); note("No se pudo acceder al micrófono: " + e.message); return; }
    // Grabamos ya: si Whisper aún se está preparando, los tramos esperan en cola
    startLive();
    var w = await wp;
    if (!w.ok) { pill("Transcripción: error", "err"); note(w.error); return; }
    pill("Transcribiendo en vivo", "ok");
  }

  // ---------- Terminar ----------
  async function finish() {
    if (finishing || !live) return;
    finishing = true; live = false; clearInterval(timer);
    ["mic", "sys"].forEach(function (k) { var t = T[k]; if (t && t.state === "speech") close(t); });
    $("dot").className = "dot"; $("finish").disabled = true; $("discard").disabled = true;
    $("done").className = "done show"; $("done-t").textContent = "Terminando la transcripción…"; $("done-s").textContent = "";
    var waitStart = Date.now();
    while (((await window.call.pending()) > 0 || Object.keys(msgs).some(function (id) { return msgs[id].pending; })) && Date.now() - waitStart < 120000) {
      await new Promise(function (r) { setTimeout(r, 300); });
    }
    var ids = sortedIds().filter(function (id) { return msgs[id].text; });
    var first = ids.length ? msgs[ids[0]].startMs : 0;
    var last = ids.length ? Math.max.apply(null, ids.map(function (id) { return msgs[id].endMs; })) : 0;
    var isManual = ids.some(function (id) { return msgs[id].track === "mix"; });
    var lines = ids.map(function (id) { var m = msgs[id]; return "[" + mmss(m.startMs - first) + "] " + (m.track === "mix" ? "" : WHO[m.track] + ": ") + m.text; });
    if (isManual) lines.unshift("(Modo manual: una sola pista con las dos voces; deduce quién habla por el contexto.)");
    var payload = {
      started_at: new Date(t0 + first).toISOString(),
      ended_at: new Date(t0 + last).toISOString(),
      duration_s: Math.round((last - first) / 1000),
      transcript: ids.map(function (id) { var m = msgs[id]; return { who: m.track === "mic" ? "comercial" : (m.track === "sys" ? "cliente" : "mezcla"), start_ms: m.startMs - first, end_ms: m.endMs - first, text: m.text }; }),
      transcript_text: lines.join("\n"),
    };
    stopSys(); if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); });
    $("done-t").textContent = "Guardando en el CRM…";
    var r = await window.call.save(payload);
    if (r.ok) {
      $("done-t").textContent = "Llamada guardada ✓";
      $("done-s").innerHTML = (payload.duration_s >= 60 ? "Se analizará en unos segundos y verás el resumen en la oportunidad." : "Es una llamada corta (menos de 1 min): no se analiza.") +
        "<br><br><b>Recuerda colgar en Enlace Móvil o en el móvil.</b>";
      setTimeout(function () { window.call.close(); }, 6000);
    } else {
      $("done-t").textContent = "No se pudo guardar en el CRM";
      $("done-s").textContent = r.error + " Se ha guardado una copia en tu ordenador para no perderla.";
    }
    $("done-close").style.display = "";
  }

  var discardArmed = false;
  $("discard").addEventListener("click", function () {
    if (!discardArmed) { discardArmed = true; this.textContent = "¿Seguro? Pulsa otra vez"; var b = this; setTimeout(function () { discardArmed = false; b.textContent = "Descartar"; }, 3000); return; }
    live = false; window.call.close();
  });
  $("finish").addEventListener("click", finish);
  $("done-close").addEventListener("click", function () { window.call.close(); });
  $("redial").addEventListener("click", function () { window.call.redial(); });
  $("mic").addEventListener("change", changeMic);
  $("mode").addEventListener("change", changeMode);
  init();
})();
