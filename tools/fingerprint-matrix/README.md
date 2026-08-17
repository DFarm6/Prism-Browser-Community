# 指纹模板矩阵审计

矩阵审计会在真实目标系统上依次验收一个“本机硬件”模板、一个种子 GPU 模板和三个固定硬件模板。每个模板都会运行完整的
Window、Iframe、Dedicated Worker、Shared Worker、Service Worker、UA-CH、请求头、屏幕、WebGL/WebGPU、
Canvas、Audio、字体、Speech voices、ClientRects、Geolocation 和 WebRTC 审计。

固定模板只固定 CPU、系统版本、屏幕与 GPU 型号；字体、Canvas、Audio 和 ClientRects 使用机器原生渲染。
两个不同 seed 会被对齐到同一 GPU 桶，因此同一个固定硬件模板不能因为 seed 改变而漂移。矩阵最后还会
确认三个模拟模板的 GPU 型号互不相同。

Windows 种子模板只从 `src/shared/windows-gpu-catalog.json` 的桌面 GPU 池分配，不使用 Laptop GPU。
环境会持久化分配后的内核 bucket，软件升级不会重新计算已使用环境的 GPU；复制、从模板创建或主动重新生成
种子时才会分配新 bucket。

macOS：

```bash
npm run audit:fingerprint-matrix -- \
  --browser "/path/to/Chromium.app/Contents/MacOS/Chromium" \
  --platform macos \
  --version 144.0.7559.132 \
  --output-dir release/fingerprint-matrix/macos
```

Windows PowerShell：

```powershell
npm run audit:fingerprint-matrix -- --browser ".\release\win-unpacked\resources\kernels\current\chrome.exe" --platform windows --version 144.0.7559.132 --debug-transport websocket --output-dir ".\release\fingerprint-matrix\windows"
```

输出包含每个模板的完整 `schemaVersion: 14` 报告以及一个平台汇总报告。只有五个模板全部通过、固定 GPU
模板互不混淆、所有报告均为同一新版结构时，平台汇总才会通过。

汇总中的 `renderBundleReadiness` 同时列出跨 seed 的表面碰撞、v4 原生 Speech inventory 和 WebGPU
覆盖状态。`requiredForCurrentInternalBeta` 为 `true`；所有 v4 模板必须通过 WebGPU/WebGL GPU 世代
一致性门禁，固定模板还必须保持 adapter 摘要稳定，否则 `webgpuTemplateIdentityReady` 失败并阻断验收。
