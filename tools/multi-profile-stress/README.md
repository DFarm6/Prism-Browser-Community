# Multi-profile Chromium stress audit

This audit launches multiple real Fingerprint Chromium processes with independent temporary `user-data-dir` paths. Startup work is limited to the requested concurrency, and every browser opens the same deterministic page served from `127.0.0.1`.

Short macOS smoke run:

```bash
npm run audit:stress -- \
  --browser "/path/to/Chromium.app/Contents/MacOS/Chromium" \
  --profiles 6 \
  --concurrency 3 \
  --duration-seconds 15 \
  --sample-interval-seconds 3 \
  --output "./release/multi-profile-stress-macos-smoke.json"
```

Two-hour acceptance:

```bash
npm run audit:stress -- \
  --browser "/path/to/Chromium.app/Contents/MacOS/Chromium" \
  --profiles 12 \
  --concurrency 3 \
  --duration-seconds 7200 \
  --sample-interval-seconds 30 \
  --output "./release/multi-profile-stress-macos-2h.json"
```

The default is headless. Add `--visible` for a manual real-window run. macOS defaults to CDP Pipe, while Windows defaults to CDP WebSocket.

The run fails if a profile cannot start, directories are reused, startup concurrency is exceeded, a Chromium root exits unexpectedly, aggregate RSS crosses the growth gates, per-profile RSS exceeds 1 GiB, process density exceeds 12 processes per profile, average CPU is unbounded, or any root/helper process remains after shutdown.
