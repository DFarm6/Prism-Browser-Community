# Chromium 内核维护

`tools/kernel-lock.json` 是 macOS 与 Windows 唯一的版本合同，固定 Chromium、平台仓库、指纹补丁仓库、
提交、Prism 补丁顺序和 SHA-256。

常用命令：

```bash
# 验证锁文件、全部规范补丁和 Windows 镜像副本
npm run kernel:verify-lock

# 检查已经准备好的 macOS 源码
node tools/kernel-maintenance/run.mjs verify-source \
  --platform macos-arm64 \
  --platform-root /path/to/ungoogled-chromium-macos \
  --fingerprint-root /path/to/ungoogled-chromium-macos/ungoogled-chromium \
  --chromium-source /path/to/ungoogled-chromium-macos/build/src \
  --output release/kernel-source-macos.json

# 在升级候选的干净 Chromium 源码上预检所有 Prism 补丁
node tools/kernel-maintenance/run.mjs check-patches \
  --chromium-source /path/to/new/chromium/src \
  --output release/kernel-patch-upgrade-check.json

# 查询三个上游仓库的新标签，只生成报告，不修改版本锁或源码
npm run kernel:probe-upstream

# 导出包含锁文件和规范补丁的平台构建包
node tools/kernel-maintenance/run.mjs export-kits \
  --kits-output release/kernel-build-kits
```

补丁检查把每个补丁标记为：

- `ready`：可以干净应用到升级候选；
- `already-applied`：源码已经完整包含补丁；
- `conflict`：不能应用或只应用了一部分，必须停止升级并人工适配。

发现新标签后不要直接改锁。先在独立源码目录运行 `check-patches`，修正冲突并完成
`native`、`fixed-template` 两种指纹审计，再更新 `kernel-lock.json` 中的版本、提交和补丁摘要。

晚于上游同类补丁才能应用的 Prism 补丁使用 `insertAfterSeriesPath` 固定插入点。
`020-render-identity-v1.patch` 必须位于上游 `018-timezone.patch` 之后，避免上游字体、GPU 或 WebGL
补丁覆盖它。
`021-conservative-render-identity-v2.patch` 必须紧跟 020，明确保留原生 WebGL/Audio 读取结果。
`023-coherent-render-identity-v3.patch` 必须位于 022 之后，为模拟硬件模板提供同种子稳定、异种子
可区分的 Canvas/WebGL/Audio/DOMRect 渲染身份；v2 仅保留用于旧报告兼容。
`024-domrect-seed-mixing.patch` 必须紧跟 023，用强混合和量化安全槽位修复 ClientRects 的跨种子
浮点碰撞，同时保持几何算术关系和原有噪声幅度。
`027-direct-domrect-identity.patch` 必须位于 026 之后，让 v3 直接启用确定性 ClientRects，应用层不得再传入
`--enable-blink-features=FingerprintingClientRectsNoise` 这类会触发 Chromium 警告条的实验参数。
`028-direct-domrect-consumption.patch` 必须位于 027 之后，让 Element 与 Range 的 ClientRects 读取路径
使用 Prism 的直接启用状态，而不是继续依赖实验性 Blink feature gate。
`029-native-locale-surfaces-v4.patch` 必须位于 028 之后，让 v4 保留宿主原生字体和 Speech voice inventory，
同时把 Canvas、WebGL、OfflineAudio、TextMetrics 和 DOMRect 的一致种子路径扩展到 v4。
`030-windows-native-tts-voices.patch` 必须位于 029 之后；当 Windows OneCore 枚举调用成功但返回空 token 时，
它回退到桌面 SAPI 类别，确保 Web Speech API 暴露真实且可朗读的本机 voice inventory。
`031-windows-tts-runtime.patch` 必须位于 030 之后；它将 SAPI 放到显式 COM MTA 专用线程，使用明确的
token category/description 转换，并在类别枚举失败时回退到 `ISpVoice` 的真实默认 token。失败时会输出
`[PrismTTS]` HRESULT 诊断，验收仍要求系统原生 voice inventory 非空。
`032-webgpu-template-identity.patch` 将 WebGPU adapter 的 GPU 世代与 WebGL 模板对齐。
`033-webgl-snapshot-speech-coherence.patch` 必须位于 032 之后；它让 WebGL `toDataURL()` 与
`readPixels()` 使用相同的完整种子混合，并阻止 v4 环境暴露与配置语言冲突的宿主 Speech voices。
`034-canvas-serialization-identity.patch` 必须位于 033 之后；它在 Canvas 2D 的序列化副本中编码完整
32 位环境种子，避免 CreepJS 组合画布因亚像素槽位相同而碰撞。
`035-locale-speech-catalog.patch` 必须位于 034 之后；它同步建立 ja/fr/en/zh 语言目录，再异步绑定真实
平台 voice，使检测站点的短等待窗口内也能获得非空、单一默认且语言一致的语音身份。
`036-coherent-canvas-readback.patch` 必须位于 035 之后；它撤销 Canvas 序列化副本的单路径改写，把种子
身份放入实际绘制 backing store，使 `getImageData`、`toBlob`、`toDataURL` 与 OffscreenCanvas 读回一致。
`037-canvas-seed-slot-dispersion.patch` 必须位于 036 之后；它使用雪崩哈希高 6 位分散 Canvas 偏移槽，
在维持最大 1 像素偏移和跨 API 一致性的同时，消除固定 RTX 4060 seed 的 CreepJS 栅格碰撞。
