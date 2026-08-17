# Prism macOS 指纹 Chromium 构建包

所有版本、仓库提交和补丁摘要均来自随构建包附带的 `kernel-lock.json`，不得手工修改脚本中的版本号。

```bash
./Check-Prerequisites.sh /Volumes/disk/prism-kernel
./Prepare-Source.sh /Volumes/disk/prism-kernel
./Build-Kernel.sh /Volumes/disk/prism-kernel 4
```

首次构建会下载并展开完整 Chromium 源码。存在 `build/src/out/Default/build.ninja` 时，`Build-Kernel.sh`
只运行 Ninja 增量续编，不删除 `out/Default`。失败后直接执行同一命令即可继续。

当前版本锁中的 `020-render-identity-v1.patch` 必须排在上游 `018-timezone.patch` 之后，覆盖
Speech voice、语言相关字体、WebGL `readPixels` 和 OfflineAudio 渲染身份。准备脚本会按
`kernel-lock.json` 的插入点自动维护顺序，禁止手工把它提前到上游字体/WebGL 补丁之前。
`021-conservative-render-identity-v2.patch` 紧跟 020，只让 v2 继承语言/字体策略；WebGL 和
OfflineAudio 后处理仍仅限旧 v1，v2 保留原生读取结果。

已有完整构建目录时，可增量加入永久环境编号、窗口标题和 Dock 徽标：

```bash
./Update-Window-Identity-Patch.sh /Volumes/disk/prism-kernel
./Build-Kernel.sh /Volumes/disk/prism-kernel 4
```

022 补丁还包含 Windows 独立任务栏分组实现；macOS 构建只会编译共用标题和 Dock 部分。

已有完整构建目录时，可继续增量升级一致渲染身份 v3：

```bash
./Update-Coherent-Render-Identity-Patch.sh /Volumes/disk/prism-kernel
./Build-Kernel.sh /Volumes/disk/prism-kernel 4
```

023 补丁让模拟硬件环境的 Canvas、WebGL Pixels、OfflineAudio 和 DOMRect 统一绑定环境种子，
并让字体/Speech 继续服从语言模板。同种子必须跨页面和重启稳定，不同种子至少五个高熵字段不同；
本机硬件模板不启用这些校准。

023 构建若在固定 GPU 模板上出现 DOMRect 跨种子浮点量化碰撞，可增量应用 024：

```bash
./Update-DOMRect-Identity-Patch.sh /Volumes/disk/prism-kernel
./Build-Kernel.sh /Volumes/disk/prism-kernel 4
```

024 保持原有微小缩放范围，使用强种子混合和完整 16-bit 噪声空间，避免相邻环境种子产生相关低位输出。

若矩阵继续报告 `offscreenCanvas`、`textMetricsNativeShape` 或 `audioSampleRate` 不一致，增量应用 025：

```bash
./Update-Native-Surface-Consistency-Patch.sh /Volumes/disk/prism-kernel
./Build-Kernel.sh /Volumes/disk/prism-kernel 4
```

025 在 v3 下关闭旧 Canvas/TextMetrics/Audio 补丁的二次扰动，环境差异仍由统一种子渲染层负责。

固定 GPU 模板若仍报告 `canvasSha256` 跨种子碰撞，可增量应用 026：

```bash
./Update-Canvas-Seed-Dispersion-Patch.sh /Volumes/disk/prism-kernel
./Build-Kernel.sh /Volumes/disk/prism-kernel 4
```

026 使用两个独立盐值生成量化的 X/Y 子像素偏移，保持同种子稳定和 Renderer 固定，同时降低
Skia 栅格量化造成的跨种子 Canvas 碰撞。

为消除 Chromium 对实验 Blink 参数的警告并保持 DOMRect v3 生效，继续增量应用 027：

```bash
./Update-Direct-DOMRect-Identity-Patch.sh /Volumes/disk/prism-kernel
./Build-Kernel.sh /Volumes/disk/prism-kernel 4
```

027 让 Prism 内核直接根据 `--fingerprint-render-identity=v3` 进入确定性 ClientRects 路径，应用层不再传入
`--enable-blink-features=FingerprintingClientRectsNoise`。

Windows-only 的 031 TTS 运行时补丁也会登记到共享源码和统一补丁序列，但不触发 macOS 重编：

```bash
./Update-Windows-TTS-Runtime-Patch.sh /Volumes/disk/prism-kernel
```

随后应用 028，让 Element 与 Range 的 DOMRect 读取也使用 Prism 的直接启用状态：

```bash
./Update-Direct-DOMRect-Consumption-Patch.sh /Volumes/disk/prism-kernel
./Build-Kernel.sh /Volumes/disk/prism-kernel 4
```

最后应用 029，将新建及已有模拟硬件环境升级到原生字体/Speech 的渲染身份 v4：

```bash
./Update-Native-Locale-Surfaces-V4-Patch.sh /Volumes/disk/prism-kernel
./Build-Kernel.sh /Volumes/disk/prism-kernel 4
```

v4 不再按伪装语言隐藏字体或过滤系统 voice inventory，避免空语音列表和异常字体集合；Canvas、WebGL、
OfflineAudio 与 DOMRect 仍由环境种子稳定分离。

每次构建都会生成：

- `logs/macos-kernel-<UTC 时间>.log`；
- `logs/macos-kernel-latest.json`，状态为 `running`、`failed` 或 `completed`；
- `artifacts/<version>-macos-arm64/manifest.json`；
- `SHA256SUMS.txt`、构建锁、Chromium ZIP、Chromedriver 和 `args.gn`。

升级 Chromium 前，应先对候选源码运行 `kernel-maintenance/run.mjs check-patches`。任何补丁显示
`conflict` 时都不能开始长时间编译。
### WebGPU 模板身份

032 将 WebGPU adapter vendor/architecture 与 v4 WebGL 模板的 GPU 世代对齐，同时保留宿主原生
features、limits 与 Metal feature-family。已有 Ninja 图可直接增量应用：

```bash
./Update-WebGPU-Template-Identity-Patch.sh "/Volumes/disk/prism-kernel"
./Build-Kernel.sh "/Volumes/disk/prism-kernel" 4
```

该步骤只重编 Blink WebGPU 相关对象和最终链接，不重新下载 Chromium。

### WebGL 序列化与 Speech locale 一致性

033 让 WebGL `toDataURL()` 与 `readPixels()` 共享同一套完整种子身份，并让 v4 只暴露与环境主语言
匹配的真实本机 Speech voice。已有 Ninja 图可直接增量应用：

```bash
./Update-WebGL-Snapshot-Speech-Coherence-Patch.sh "/Volumes/disk/prism-kernel"
./Build-Kernel.sh "/Volumes/disk/prism-kernel" 4
```

严格矩阵要求两条 WebGL 链路同时同种子稳定、异种子分离；Speech 无匹配本机语言时允许一致为空，
但不得暴露冲突语言。

### CreepJS Canvas 与即时 Speech 目录

034/035 进一步消除小范围文字偏移造成的 Canvas 种子碰撞，并让 v4 在第一次
`speechSynthesis.getVoices()` 调用时就返回 3 个与环境语言一致的稳定本地语音身份。系统语音异步
加载后只更新内部朗读映射，不改变网页已看到的目录：

```bash
./Update-Canvas-Speech-Identity-Patches.sh "/Volumes/disk/prism-kernel"
./Build-Kernel.sh "/Volumes/disk/prism-kernel" 4
```

从 035 开始，严格矩阵不再接受空 Speech 目录。

### Canvas 跨 API 一致性

036 取消 034 的 `toDataURL()` 序列化专用改写，并把 Canvas 文字绘制的确定性种子槽位扩大到 6 bit。
差异直接进入 backing store，因此 `getImageData()`、`toBlob()`、`toDataURL()` 与
`OffscreenCanvas.convertToBlob()` 会自然返回一致像素；偏移仍不超过 1 个像素。

```bash
./Update-Coherent-Canvas-Readback-Patch.sh "/Volumes/disk/prism-kernel"
./Build-Kernel.sh "/Volumes/disk/prism-kernel" 4
```

严格矩阵会同时校验 Canvas 与 WebGL 的跨 API 像素一致性。

### CreepJS seed 槽位扩散

037 继续限制 Canvas 文字偏移不超过 1 像素，但从雪崩哈希的高 6 位选择槽位，避免两个 seed 因低位
相邻而栅格化成完全相同的 CreepJS 组合画布：

```bash
./Update-Canvas-Seed-Slot-Dispersion-Patch.sh "/Volumes/disk/prism-kernel"
./Build-Kernel.sh "/Volumes/disk/prism-kernel" 4
```

### WebGL 校准真实性

038 为 WebGL 完整性校准保留原生输出：纯色参考缓冲区不再注入环境低位签名，而高熵着色器结果仍保持
种子隔离。已有源码执行：

```bash
./Update-WebGL-Calibration-Authenticity-Patch.sh /Volumes/disk/prism-kernel
./Build-Kernel.sh /Volumes/disk/prism-kernel 6
```

严格矩阵 schema 11 会复刻 Pixelscan 的 Canvas/WebGL 校准以及 CreepJS DOMRect 真实性探针。

### 本机字体集合真实性

039 取消 v4 在目标平台与本机相同时按种子随机隐藏 2% 字体的旧策略，避免 Pixelscan 将随机缺字的目录
判定为不属于真实 OS。其他高熵渲染表面仍保持环境隔离：

```bash
./Update-Native-Font-Inventory-Authenticity-Patch.sh /Volumes/disk/prism-kernel
./Build-Kernel.sh /Volumes/disk/prism-kernel 6
```

### DOMRect 校准真实性

040 只对轴对齐的普通 DOMRect 保留环境级稳定差异，旋转、倾斜和 3D 变换后的几何保持 Chromium 原生
结果。该策略保留普通矩形的种子隔离，同时满足 CreepJS 对固定旋转、零尺寸、等元素和严格数学关系的
真实性校准：

```bash
./Update-DOMRect-Calibration-Authenticity-Patch.sh /Volumes/disk/prism-kernel
./Build-Kernel.sh /Volumes/disk/prism-kernel 4
```

### macOS Intl 语言一致性

041 在 macOS Renderer 创建首个 V8 isolate 前，将环境的 `--fingerprint-language` 同步到 ICU 默认
locale。这样 `Intl.DateTimeFormat().resolvedOptions().locale` 会与 `navigator.language`、请求头、Speech
及代理国家语言保持一致；Windows 代码路径由编译条件完全隔离。

```bash
./Update-MacOS-Intl-Locale-Patch.sh /Volumes/disk/prism-kernel
./Build-Kernel.sh /Volumes/disk/prism-kernel 4
```
