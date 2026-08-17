# Windows TTS probe

Run this probe against the already packaged V17 Chromium before compiling a new kernel.
It waits up to seven seconds for asynchronous native SAPI initialization and records all
three samples, Chromium stderr, and the resulting Web Speech voice inventory.

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
cd E:\Prism-V17-TTS-Probe
.\Run-Windows-TTS-Probe.ps1 `
  -Browser "E:\Prism-Windows-v17-Test-Kit\Prism-Beta-Release-Kit-0.2.0-beta.1\release\win-unpacked\resources\kernels\current\chrome.exe" `
  -Output ".\tts-probe-v17.json"
```

Return `tts-probe-v17.json` even when the fingerprint gate reports FAIL.
