# 指纹内核回归审计

该工具通过 Chromium DevTools Pipe 分别启动两个相同 seed 的独立数据目录和一个不同 seed 的数据目录，采集并比较：

- UA、UA-CH 完整内核版本、平台、CPU、语言、时区、屏幕和 `navigator.webdriver`；
- 字体探针、SpeechSynthesis voices、Canvas、WebGL/WebGPU、Audio 和 ClientRects；
- Window、同源 Iframe、Dedicated Worker、SharedWorker 和 Service Worker 的身份一致性；
- 各执行上下文的 UA、UA-CH、语言、时区、CPU、内存和请求身份头；
- OffscreenCanvas 2D/WebGL 以及 AudioWorklet 的跨上下文一致性；
- Geolocation 的代理城市级坐标、精度以及 WebRTC 直连 IP 候选泄漏；
- 同 seed 的跨目录稳定性，以及不同 seed 的噪声隔离。

macOS 示例：

```bash
npm run audit:fingerprint -- \
  --browser "/path/to/Chromium.app/Contents/MacOS/Chromium" \
  --platform macos \
  --platform-version 26.0.0 \
  --version 144.0.7559.132 \
  --surface-mode native \
  --output artifacts/fingerprint-audit-mac.json
```

Windows 示例：

```powershell
npm run audit:fingerprint -- --browser "D:\path\chrome.exe" --platform windows --platform-version 10.0.0 --version 144.0.7559.132 --surface-mode native --output artifacts\fingerprint-audit-win.json
```

Windows 默认使用仅绑定 `127.0.0.1` 的随机 DevTools WebSocket 端口，避免 Node 子进程在 Windows 上继承
Chromium 固定 FD 3/4 调试管道时提前断开。macOS 默认继续使用 pipe；需要单独回归传输层时可显式传入
`--debug-transport pipe` 或 `--debug-transport websocket`。临时调试端口随独立审计数据目录和 Chromium
进程一起关闭，不监听局域网地址。

`--surface-mode native` 验收本机一致策略：不同 seed 不应改变 Canvas、Audio、ClientRects、字体和 GPU。
`--surface-mode fixed-template` 验收固定 GPU 产品模板：两个 seed 必须预先对齐到相同 GPU 桶；
搭配 v3 时 GPU 型号保持模板值，其余种子渲染面应稳定分离。`--surface-mode template` 验收种子选择
GPU 的产品模板，不同 GPU 桶及其渲染包均应改变。

传入 `--render-identity v2` 时，审计启用保守渲染身份门禁：不同 seed 应改变声明的 WebGL Renderer，
但 WebGL Pixels 与 Audio 必须保持原生稳定，Speech 语言必须与环境语言匹配。v2 不再对 WebGL
`readPixels` 或 OfflineAudio 数据做 seed 后处理，以降低检测站点将其识别为 masking 的风险。报告中的
`result.renderIdentityReadiness` 会记录模式、稳定性和风险字段；该门禁会直接参与审计成败。

传入 `--render-identity v3` 时，Canvas、WebGL Renderer、WebGL Pixels、OfflineAudio 和 DOMRect
必须随 seed 改变，同一 seed 重复采样与所有执行上下文必须稳定；六个高熵字段中至少五个不同，
Speech voice 必须与环境语言匹配。字体集合允许在同系统/同语言模板下相同，但不能暴露冲突的区域字体。

传入 `--render-identity v4` 时，Canvas、WebGL、OfflineAudio 和 DOMRect 继续使用确定性种子身份；
WebGL `toDataURL()` 与 `readPixels()` 必须同时随种子变化。字体清单保留宿主系统能力，Speech voices
只暴露与环境主语言匹配的真实本机语音；宿主没有相应语言时允许一致地返回空列表，不能泄露冲突语言。

WebGPU adapter info、features 与关键 limits 会写入报告。v4 模板要求 WebGPU vendor/architecture 与
WebGL 模板的 GPU 世代一致：Windows RTX 30/40/50 分别对应 Ampere/Ada/Blackwell；固定模板还必须跨
seed 保持稳定。宿主硬件模式继续保留原生 adapter、features 与 limits。该策略不通过伪造能力上限制造差异。

`--render-identity v1`、v2 和 v3 只用于旧报告兼容。新建环境和已存储的模拟硬件环境统一升级到 v4，
产品矩阵中的 seeded 与 fixed-template 模板都以 v4 作为发布合同。

CPU 核数、屏幕、语言、时区、位置、seed、禁用的注入表面与期望 GPU 均可通过命令行传入。产品模板的
固定组合由 `tools/fingerprint-matrix/run.mjs` 统一管理，日常验收应优先运行矩阵命令。

传入成对的 `--proxy-server` 与 `--expected-public-ip` 后，审计还会让三个独立浏览器数据目录通过代理
访问公网 IP 服务，并要求每次看到的 IP 都等于启动前确认的代理出口。该能力由
`tools/network-audit/run.mjs` 管理；真实代理凭据不会直接传给 Chromium。

Worker 发起的请求在 Chromium 中通常不携带 `Sec-CH-UA*`。审计要求 `User-Agent` 与
`Accept-Language` 始终一致；可选 Client Hints 一旦出现，值必须与 Window 请求完全一致。

本地 macOS 构建应先用 `tools/macos-kernel/Sign-Local-Build.sh` 分层签名，使 Renderer/GPU Helper 带有正确的
开发 entitlements。`--allow-no-sandbox` 只用于定位签名故障，不属于正常开发或发布参数。
发布候选包必须使用 Developer ID 签名、公证并在不带此参数时通过启动和审计；JSON 报告中的
`auditMode.sandboxDisabled` 必须为 `false`。

审计默认传入洛杉矶坐标 `34.0522,-118.2437` 和 25 km 精度，并通过 CDP 仅为本地审计源授予位置权限；
这不会绕过真实网站的 Chromium 原生位置权限提示。报告 `schemaVersion: 14` 还会记录 CreepJS 风格
Canvas 序列化、WebGL 序列化、像素读取、即时 Speech locale 目录与 WebGPU/WebGL 世代一致性，方便定位
“测试参数”和“浏览器实际值”之间的差异。Audio 检查还会复刻 CreepJS 的 AudioBuffer trap，要求
渲染缓冲区前 100 个原生静音样本不被环境噪声污染。
