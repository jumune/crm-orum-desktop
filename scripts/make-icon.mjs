// Genera build/icon.png (512x512) con el símbolo ORUM, tomado de la web pública
// (orumconsulting.com/crm-desktop), para que el icono sea siempre el de la marca.
// Si no se puede descargar, crea un icono provisional para no romper la compilación.
import fs from "node:fs";
import { Resvg } from "@resvg/resvg-js";

fs.mkdirSync("build", { recursive: true });
let path = null;
try {
  const html = await (await fetch("https://orumconsulting.com/crm-desktop")).text();
  const m = html.match(/ORUM_PATH\s*=\s*"([^"]+)"/);
  if (m) path = m[1];
} catch (e) { console.log("No se pudo leer el logo de la web:", e.message); }

const symbol = path
  ? `<path d="${path}" fill="#FF7932"/><circle cx="64.61" cy="13.84" r="8.5" fill="url(#og)"/><circle cx="50" cy="50" r="10.5" fill="#233441"/>`
  : `<circle cx="50" cy="50" r="40" fill="none" stroke="#FF7932" stroke-width="10"/><circle cx="50" cy="50" r="10.5" fill="#233441"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 -6 112 112" width="512" height="512">
<defs><linearGradient id="og" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FF5F0B"/><stop offset="100%" stop-color="#FF7932"/></linearGradient></defs>
<rect x="-6" y="-6" width="112" height="112" rx="22" fill="#FAFBFC"/>${symbol}</svg>`;
fs.writeFileSync("build/icon.svg", svg);
fs.writeFileSync("build/icon.png", new Resvg(svg, { fitTo: { mode: "width", value: 512 } }).render().asPng());
console.log(path ? "Icono ORUM generado." : "Icono provisional generado (no se encontró el logo).");
