# Profile data isolation audit

This local audit launches two temporary Chromium user-data directories and verifies that the following data is both persistent across browser restarts and isolated between profiles:

- persistent cookies
- Local Storage
- IndexedDB
- Cache Storage
- Service Worker registrations
- Origin Private File System (OPFS)

No external website is used. The audit starts a temporary HTTP server bound to `127.0.0.1`.

```bash
npm run audit:profile-data -- \
  --browser "/path/to/Chromium.app/Contents/MacOS/Chromium" \
  --output "./release/profile-data-audit-macos.json"
```

Use `--keep-data` only for debugging. The report will include the retained temporary directory path. `--allow-no-sandbox` is intended only for constrained CI environments.

The default debugging transport is CDP Pipe on macOS and WebSocket on Windows. It can be overridden with `--debug-transport pipe|websocket`.
