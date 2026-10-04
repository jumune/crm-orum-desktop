# CRM Orum · App de escritorio

App de Windows de ORUM Consulting. Abre el CRM web (orumconsulting.com/crm) y añade
llamadas con Enlace Móvil y transcripción local con Whisper (sin coste por minuto).
No guarda audio: la transcripción se envía al CRM y, tras el análisis con IA, se borra.

- `main.js` — proceso principal (ventanas, Enlace Móvil, guardado en el CRM)
- `call.html` / `call.js` — ventana de llamada (captura de 2 pistas, detección de voz, anti-eco)
- `whisper.js` — servidor local de whisper.cpp (modelo small, modo rápido)
- `setup.js` — descarga de Whisper la primera vez que se abre la app
- `preload-crm.js` / `preload-call.js` — puentes seguros con las páginas
- `scripts/make-icon.mjs` — genera el icono con el símbolo ORUM

## Publicar una versión nueva
1. Subir `version` en `package.json` (p. ej. 0.3.0 → 0.3.1).
2. Ejecutar `PUBLICAR.bat` (en el PC del admin): sube los cambios y crea la etiqueta `v0.3.1`.
3. GitHub Actions compila y publica `CRM-Orum-Setup.exe` en **Releases** (~10 min).
   Las apps instaladas se actualizan solas.

Enlace de descarga permanente:
https://github.com/jumune/crm-orum-desktop/releases/latest/download/CRM-Orum-Setup.exe
