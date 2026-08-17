# Prism application E2E acceptance

This tool drives the real Prism renderer through its context-isolated preload API, so every operation crosses the same Renderer → Preload → Main boundary as the UI. It uses a dedicated temporary Prism user-data directory and a local test page.

Development runtime:

```bash
npm run build
npm run audit:app-e2e -- \
  --browser "/path/to/Chromium.app/Contents/MacOS/Chromium" \
  --output "./release/app-e2e-macos.json"
```

Packaged macOS executable:

```bash
npm run audit:app-e2e -- \
  --app "/path/to/Prism Browser.app/Contents/MacOS/Prism Browser" \
  --packaged \
  --browser "/path/to/Chromium.app/Contents/MacOS/Chromium" \
  --output "./release/app-e2e-macos-packaged.json"
```

The audit creates and edits two profiles, duplicates a profile, starts two real browser processes, closes all browsers, moves the duplicate to the recycle bin, cleanly restarts Prism, and verifies metadata, seed and owner-marker persistence.

`PRISM_E2E` capabilities are inactive during normal application runs. The temporary data directory is deleted unless `--keep-data` is specified.
