# Prism Windows 指纹 Chromium 构建包

这套脚本用于在 Windows x64 真机上编译与 macOS 内核相同版本的 Fingerprint Chromium。

实际固定值以构建包内的 `kernel-lock.json` 为唯一依据；下列内容是当前锁的可读摘要：

- Chromium：`144.0.7559.132`
- Windows 平台仓库标签：`144.0.7559.132-1.1`
- Windows 平台提交：`469861bcfd3f4c871986437502b05f3076cad15e`
- Fingerprint Chromium 标签：`144.0.7559.132`
- 指纹补丁提交：`831623f2965e34554304caabfc3a1e4e3741db1f`
- Prism 补丁：统一 `navigator.screen`、CSS device media query、桌面可用区、代理 Geolocation，以及
  Speech/字体/WebGL/OfflineAudio 的版本化渲染身份（工具包内分别固定 SHA-256）
- 架构：Windows x64

## 一、机器要求

建议使用：

- Windows 10/11 x64，建议使用较新的 Windows 11；
- 16 GB 内存为最低实用配置，建议 32 GB 或更多；
- NTFS SSD，建议至少剩余 300 GB；低于 180 GB 时检查脚本会拒绝继续；
- 构建目录使用短路径且不能包含空格，例如 `D:\prism-chromium`；
- 编译期间保持电源连接，不要拔掉构建磁盘。

不要安装或配置 `depot_tools`。本项目使用 `ungoogled-chromium-windows` 自带的下载、工具链和补丁流程。

## 二、安装依赖

1. 安装 Visual Studio 2022（17.x）或 Visual Studio 2026（18.x）Community。
2. 在 Visual Studio Installer 中选择：
   - `Desktop development with C++`；
   - C++ ATL；
   - C++ MFC；
   - Windows 11 SDK `10.0.26100.x`。
3. 给 Windows SDK 安装 `Debugging Tools for Windows`。
4. 安装 Python 3.12 x64，并创建不继承 Anaconda 包的干净 venv：

```powershell
py -3.12 -m venv C:\prism-venv
C:\prism-venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
```

不要在 Anaconda base 或包含 PyPI `build` 包的环境中运行 Chromium 构建；它会和平台仓库的 `build.py`
或相关导入产生名称冲突。构建脚本会在 `BuildRoot\python-shim` 自动创建 `python3.cmd` 并加入当前进程
PATH，兼容 `gclient.bat` 对 `python3` 命令的调用，不需要复制或修改 Python 安装目录。
5. 在 Windows 的“应用执行别名”中关闭 Microsoft Store 的 `python.exe` 和 `python3.exe` 别名。
6. 安装 Git for Windows 和 7-Zip。
7. 以管理员身份打开 PowerShell，启用长路径：

```powershell
Set-ItemProperty `
  -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
  -Name LongPathsEnabled `
  -Type DWord `
  -Value 1
```

设置后重启 Windows。

## 三、复制并检查

运行 `npm run kernel:export-kits` 后，把整个 `release\kernel-build-kits\windows-kernel`
文件夹复制到 Windows，例如：

```text
D:\windows-kernel-build-kit
```

以管理员身份打开 PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
C:\prism-venv\Scripts\Activate.ps1
cd D:\windows-kernel-build-kit
.\Check-Prerequisites.ps1 -BuildRoot D:\prism-chromium
```

所有检查都显示 `[OK]` 后再继续。

## 四、准备固定版本源码

```powershell
.\Prepare-Source.ps1 -BuildRoot D:\prism-chromium
```

这个步骤只克隆 Windows 平台脚本和指纹补丁仓库；Chromium 大型源码会在下一步下载。

## 五、开始编译

建议先使用 `-Jobs 4`，确认内存稳定后再增加并发。机械硬盘不建议提高并发。

```powershell
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

脚本将依次完成：

1. 下载 Chromium 源码和经过摘要校验的工具链；
2. 应用上游通用/指纹补丁、Prism 屏幕/代理 Geolocation 补丁和 Windows 平台补丁；
3. 执行域名替换、GN 生成和 bindgen 构建；
4. 编译 `chrome`、`chromedriver` 和 `mini_installer`；
5. 生成 ZIP、安装程序、SHA-256 清单和构建 manifest。

脚本会阻止 Windows 在编译期间自动睡眠，但不能阻止手工关机、系统更新重启或磁盘断开。

## 六、中断后续编

如果日志中已经出现 Ninja 编译步骤，重新运行同一命令即可：

```powershell
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

脚本检测到 `build\src\out\Default\build.ninja` 后会直接增量续编，不会重新下载或再次打补丁。

如果失败发生在生成 `build.ninja` 之前，不要自行删除整个目录。保留：

```text
D:\prism-chromium\logs
D:\prism-chromium\ungoogled-chromium-windows\build\download_cache
```

把最新日志发回 macOS 开发任务，由这边判断是继续还是只重建源码目录。

### 已开始旧工具包编译时补屏幕补丁

如果全量编译开始后才收到新版工具包，先让当前编译正常结束，不要中断。关闭正在运行的 Chromium/Ninja 构建后，
把新版工具包覆盖到原工具包目录，然后执行：

```powershell
.\Update-Screen-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

第二次只进行 Ninja 增量编译和重新打包，不会重新下载 Chromium，也不会重做完整编译。

### 已用旧工具包完成编译后补代理 Geolocation

如果已经看到 `LINK mini_installer.exe` 和 `Windows fingerprint Chromium build completed`，保留整个
`D:\prism-chromium`，不要清理源码、`out\Default` 或下载缓存。先把最新版 `windows-kernel` 工具包完整覆盖到
原工具包目录，确认其中存在 `Update-Network-Patch.ps1` 和 `patches\019-proxy-geolocation.patch`，然后执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd D:\windows-kernel-build-kit
.\Check-Prerequisites.ps1 -BuildRoot D:\prism-chromium
.\Update-Network-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

更新脚本会先验证固定提交和补丁 SHA-256，再幂等更新补丁仓库与已经生成的 Chromium 源码。`Build-Kernel.ps1`
会复用现有 Ninja 图，只重编受影响的 Blink 对象及其链接目标，然后重新生成 ZIP、安装程序和摘要清单。
主 DLL 与安装器链接仍可能耗时较长，但不应再次出现 56027 个全量编译任务。重复执行更新脚本是安全的。

### native 审计发现 Screen 与 CSS Media Queries 不一致

如果 Windows native 审计中只有 `screenMedia` 和 `desktopWorkArea` 失败，说明旧 004 补丁只覆盖了
`window.screen`，尚未让 CSS `device-width/device-height` 和任务栏可用区使用相同身份。保留完整
`D:\prism-chromium`，覆盖最新版小工具包后执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd D:\windows-kernel-build-kit
.\Check-Prerequisites.ps1 -BuildRoot D:\prism-chromium
.\Update-Screen-Consistency-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

005 补丁只影响 Blink 的 `screen.cc` 和 `media_values.cc`，Ninja 会增量重编相关对象并重新链接、打包；
不重新下载源码，也不重新执行 56027 项全量编译。新 manifest 必须包含
`prismScreenConsistencyPatchSha256`。

### 已完成旧内核后加入 Render Identity v1

如果现有 Windows 内核已经编译完成，保留 `D:\prism-chromium` 的源码和 `out\Default`，覆盖最新版
`windows-kernel` 工具包后执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd D:\windows-kernel-build-kit
.\Update-Render-Identity-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

该补丁增加 `--fingerprint-render-identity=v1` 合约，按环境语言过滤明显冲突的系统字体和 Speech voice，
并对 WebGL `readPixels` 与 OfflineAudio 输出做同种子稳定、异种子可区分的校准。它会触发少量 Blink
对象重编和最终链接，不会重新下载或执行完整的 56027 项编译。新 manifest 必须包含
`prismRenderIdentityPatchSha256`。

### 已完成 v1 内核后切换到保守原生 Render Identity v2

v2 保留种子固定 GPU Renderer 和语言策略，但不再修改 WebGL `readPixels` 或 OfflineAudio 渲染结果，
避免读取结果与底层原生管线不一致。保留现有构建目录并执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd D:\windows-kernel-build-kit
.\Update-Conservative-Render-Identity-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

这是少量 Blink 对象的增量编译。新 manifest 必须包含
`prismConservativeRenderIdentityPatchSha256`。

### 为每个环境增加独立任务栏编号

022 补丁为每个环境设置永久编号：原生窗口标题和 Alt-Tab 始终带 `[编号]` 前缀，Windows
任务栏使用独立 AppUserModelID 分组，并在 Chromium 图标右下角叠加编号。保留现有构建目录，
覆盖最新版 `windows-kernel` 工具包后执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd D:\windows-kernel-build-kit
.\Update-Window-Identity-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

这是三个浏览器 UI 源文件的增量编译及最终链接，不重新下载 Chromium。新 manifest 必须包含
`prismProfileWindowIdentityPatchSha256`。

### 将模拟硬件环境升级到一致渲染身份 v3

023 补丁修正 v2 中 Canvas、WebGL Pixels、OfflineAudio 和 DOMRect 在不同环境间仍然相同的问题。
这些表面现在都由同一个环境种子确定：同一环境跨页面、跨重启保持稳定，不同环境至少在五个高熵字段上
产生差异；字体和 Speech voice 继续服从操作系统及环境语言，本机硬件模板仍保持完全原生。

保留已有源码和 Ninja 输出，覆盖最新版 `windows-kernel` 工具包后执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd D:\windows-kernel-build-kit
.\Update-Coherent-Render-Identity-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

这只会增量重编少量 Blink 对象并重新链接。新 manifest 必须包含
`prismCoherentRenderIdentityPatchSha256`，随后必须重新打包应用并运行完整 fingerprint matrix。

### 修复 DOMRect 种子浮点量化碰撞

024 补丁将 DOMRect 的简单低位 xorshift 改成强混合，并保留完整 16-bit 噪声空间。它保持 023 的微小几何缩放范围与
矩形算术一致性，但避免不同环境种子在浮点几何量化后落到同一个 ClientRects 结果。已有 023 构建可直接
增量升级：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd D:\windows-kernel-build-kit
.\Update-DOMRect-Identity-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

新 manifest 必须包含 `prismDomRectSeedMixingPatchSha256`。

### 修复 Canvas、TextMetrics 与 Audio 原生 API 一致性

025 补丁清理 v3 渲染身份与旧指纹补丁之间的重复扰动：Canvas 像素不再因 Window/Worker
执行路径不同而出现两个哈希，`measureText()` 保持浏览器原生数值形态，OfflineAudio 的整数
sampleRate 不再被改成 44099.99/44100.01；同时 Canvas 与 WebGL Pixels 使用完整环境种子，
避免固定 GPU 模板把像素身份错误地压缩到同一个硬件桶。环境差异仍由统一种子渲染层产生。

在 024 已应用的构建目录中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd D:\windows-kernel-build-kit
.\Update-Native-Surface-Consistency-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

这是三个 Blink 对象的增量重编及最终链接，不重新下载源码。新 manifest 必须包含
`prismNativeSurfaceConsistencyPatchSha256`。

### 修复固定 GPU 模板的 Canvas 种子碰撞

026 补丁把单轴连续偏移改为由完整种子和两个独立盐值生成的 X/Y 量化微偏移。它不改变固定 GPU
Renderer，同一环境仍保持稳定，但避免不同环境在 Skia 子像素量化后落入同一个 Canvas 哈希。

在 025 已应用的构建目录中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd D:\windows-kernel-build-kit
.\Update-Canvas-Seed-Dispersion-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

这是单个 Blink Canvas 对象的增量重编及最终链接。新 manifest 必须包含
`prismCanvasSeedDispersionPatchSha256`。

### 移除不受支持的 Blink 启动参数

027 补丁让 v3 DOMRect 身份直接由 Prism 内核的 `--fingerprint-render-identity=v3` 启用，不再需要
`--enable-blink-features=FingerprintingClientRectsNoise`。这会保留确定性 ClientRects 差异，同时消除每个
浏览器窗口顶部的“不受支持的命令行标志”警告，并避免该实验开关影响 CreepJS 页面初始化。

在 026 已应用的构建目录中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd D:\windows-kernel-build-kit
.\Update-Direct-DOMRect-Identity-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

这是单个 Blink Document 对象的增量重编及最终链接。新 manifest 必须包含
`prismDirectDomRectIdentityPatchSha256`。

随后应用 028，使 Element 与 Range 的 ClientRects 读取路径真正消费 027 设置的直接启用状态：

```powershell
.\Update-Direct-DOMRect-Consumption-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

新 manifest 必须同时包含 `prismDirectDomRectConsumptionPatchSha256`。

### 升级到原生字体与 Speech 的渲染身份 v4

029 补丁保留宿主系统的原生字体和 Speech voice inventory，不再按伪装语言隐藏字体或把语音列表过滤为空；
Canvas、WebGL、OfflineAudio、TextMetrics 和 DOMRect 的确定性种子路径同时扩展到 v4。

在 028 已应用的构建目录中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd D:\windows-kernel-build-kit
.\Update-Native-Locale-Surfaces-V4-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

这是 Blink 字体、Speech 与渲染表面的增量重编，不重新下载源码。新 manifest 必须包含
`prismNativeLocaleSurfacesV4PatchSha256`。

### 修复 Windows 原生 TTS 空语音列表

030 修复 Windows SAPI 的空枚举回退：当 OneCore 类别返回成功但实际没有 voice token 时，继续读取桌面
SAPI 类别。显示给 `speechSynthesis.getVoices()` 的语音和实际朗读使用同一枚举路径，不伪造语音条目。

在 029 已应用的 v15 构建目录中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd D:\windows-kernel-build-kit
.\Update-Windows-Native-TTS-Voices-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

这是 Windows-only 的增量重编，不需要重新下载 Chromium。新 manifest 必须包含
`prismWindowsNativeTtsVoicesPatchSha256`。

### 修复 Windows TTS COM 与 token 运行时链路

031 修复 030 已进入二进制但 `speechSynthesis.getVoices()` 仍为空的情况：SAPI 初始化和 token 消费改为
显式 COM MTA 专用线程，token description 失败时使用稳定 token ID，属性缺失时保留真实语音，并以
`ISpVoice::GetVoice()` 作为最后的真实默认语音回退。日志中的 `[PrismTTS]` 会保留 HRESULT 诊断。

在已应用 030 的 v16 构建目录中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
cd D:\windows-kernel-build-kit
.\Update-Windows-TTS-Runtime-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

这是 Windows-only 的增量重编，不重新下载 Chromium。新 manifest 必须包含
`prismWindowsTtsRuntimePatchSha256`。

### 对齐 WebGPU 与 WebGL GPU 世代

032 修复模板环境仍泄露宿主 WebGPU adapter 的问题。Windows RTX 30、40、50 系列分别暴露与
WebGL 模板一致的 Ampere、Ada、Blackwell 架构；固定 GPU 模板跨种子保持稳定，宿主硬件模式仍保持
原生 adapter、features 与 limits，不通过随意修改能力上限制造差异。

在已应用 031 的 v17 构建目录中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
cd D:\windows-kernel-build-kit
.\Update-WebGPU-Template-Identity-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

这是单个 Blink WebGPU 对象的增量重编及最终链接，不重新下载 Chromium。新 manifest 必须包含
`prismWebGpuTemplateIdentityPatchSha256`。

### 统一 WebGL 序列化与像素身份

033 修复检测站点通过 `canvas.toDataURL()` 与 `readPixels()` 观察到不同身份的问题：两条链路现在使用
同一套完整 32 位环境种子混合。同时，v4 仅暴露与环境主语言匹配的真实本机 Speech voice；本机缺少
目标语言时返回一致的空列表，不再泄露冲突语言的宿主语音。

在已应用 032 的构建目录中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
cd D:\windows-kernel-build-kit
.\Update-WebGL-Snapshot-Speech-Coherence-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

这是 Blink WebGL 与 Speech 对象的增量重编及最终链接，不重新下载 Chromium。新 manifest 必须包含
`prismWebGlSnapshotSpeechCoherencePatchSha256`。

### 修复 CreepJS Canvas 碰撞与即时语音目录

034 曾把完整 32 位环境种子写入 Canvas 2D 的序列化副本；035 在
`speechSynthesis.getVoices()` 首次读取时立即提供与环境语言一致的 3 个稳定本地语音身份，并在系统
语音枚举完成后把这些身份绑定到真实平台 voice。它们取代 033 的“无匹配语言则返回空列表”策略。

在已通过 v19 验收的源码目录中只需执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
cd D:\windows-kernel-build-kit
.\Update-Canvas-Speech-Identity-Patches.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

这是增量重编，不重新下载 Chromium。新 manifest 必须包含
`prismCanvasSerializationIdentityPatchSha256` 与 `prismLocaleSpeechCatalogPatchSha256`。

### 修复 Canvas 跨 API 不一致

036 取消 034 的 `toDataURL()` 序列化专用改写，把完整种子差异放回 Canvas 文字绘制阶段。这样
`getImageData()`、`toBlob()`、`toDataURL()` 和 `OffscreenCanvas.convertToBlob()` 读取同一份 backing
store，避免检测站点通过交叉读取发现 masking；偏移仍限制在 1 个像素以内。

在已通过 v20 验收的源码目录中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
cd D:\windows-kernel-build-kit
.\Update-Coherent-Canvas-Readback-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

这是增量重编，不重新下载 Chromium。新 manifest 必须包含
`prismCoherentCanvasReadbackPatchSha256`，指纹验收报告版本为 schema 10。

### 修复 CreepJS 相邻 seed 栅格碰撞

037 保持 036 的 backing-store 一致性和不超过 1 像素的偏移范围，但改用雪崩混合结果的高 6 位选择
Canvas 文字偏移槽。这样相邻低位不会再落入几乎相同的亚像素位置，RTX 4060 验收 seed
`100007 / 199985` 会得到充分分离的绘制结果。

在已通过 v21 编译的源码目录中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
cd D:\windows-kernel-build-kit
.\Update-Canvas-Seed-Slot-Dispersion-Patch.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

该步骤只重编一个 Blink Canvas 对象及最终链接，不重新下载 Chromium。新 manifest 必须包含
`prismCanvasSeedSlotDispersionPatchSha256`。

### 038 WebGL 校准真实性

Pixelscan 的公开指纹脚本会渲染固定纯红 WebGL 参考图，并要求 `readPixels()` 返回官方原生哈希。
038 在保留高熵 WebGL 场景环境身份的同时，不再修改只有单一可见 RGB 颜色的校准缓冲区，避免把完整性
探针本身当作指纹表面处理。已有源码只需执行：

```powershell
.\Update-WebGL-Calibration-Authenticity-Patch.ps1 -BuildRoot E:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot E:\prism-chromium -Jobs 4
```

构建锁会记录 `prismWebGlCalibrationAuthenticityPatchSha256`。

### 039 本机字体集合真实性

Pixelscan 会把浏览器检测到的字体集合交给 OS 一致性接口。旧策略即使在 Windows 模拟 Windows 时也会
按种子随机隐藏 2% 字体，容易形成不属于任何真实系统的集合。039 让 v4 在目标平台与本机相同时保留
完整本机字体目录；Canvas、WebGL、Audio、DOMRect 等环境身份仍按种子隔离：

```powershell
.\Update-Native-Font-Inventory-Authenticity-Patch.ps1 -BuildRoot E:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot E:\prism-chromium -Jobs 4
```

构建锁会记录 `prismNativeFontInventoryAuthenticityPatchSha256`。

### 040 DOMRect 校准真实性

040 仅对轴对齐的普通矩形保留按环境种子生成的稳定几何身份；旋转、倾斜和 3D 变换后的非轴对齐四边形
保持 Chromium 原生几何。这样不同环境的常规 DOMRect 仍可区分，同时 CreepJS 的固定旋转校准、严格数学
关系、零尺寸与等元素检查不会再被指纹噪声破坏。

```powershell
.\Update-DOMRect-Calibration-Authenticity-Patch.ps1 -BuildRoot E:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot E:\prism-chromium -Jobs 4
```

### 42. 修复 CreepJS Canvas / Audio 原生校准

```powershell
.\Update-Native-Canvas-Audio-Calibration-Patch.ps1 -BuildRoot E:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot E:\prism-chromium -Jobs 4
```

该补丁只规范 v4 的 2×2 低信息 Canvas 校准图，并将 Audio 身份改为保值重排：样本序列随环境种子变化，
但 CreepJS 使用的末尾样本统计值、采样率和原生分析器结果保持一致。

### 43. 修复 CreepJS AudioBuffer noise trap

```powershell
.\Update-Audio-Noise-Trap-Authenticity-Patch.ps1 -BuildRoot E:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot E:\prism-chromium -Jobs 4
```

043 保留离线音频前 100 个原生静音样本，只在索引 100–4095 内进行保值重排。这样环境间仍有不同的
高熵音频序列，同时 CreepJS 的 `trap` 保持为正常的页面随机值，不再显示注入噪声。

构建锁会记录 `prismAudioNoiseTrapAuthenticityPatchSha256`。

## 增量应用 Windows 任务栏编号就绪修复（044）

已有 144 源码和 Ninja 图时，不需要重新下载 Chromium。以普通权限 PowerShell 执行：

```powershell
.\Update-Windows-Taskbar-Badge-Readiness-Patch.ps1 -BuildRoot E:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot E:\prism-chromium -Jobs 4
```

044 不修改任何网页指纹面。它只在 Windows 任务栏按钮完成异步注册后，分阶段重试设置环境编号叠加图标，
解决浏览器窗口标题已有编号但任务栏图标偶发不显示编号的问题。构建锁会记录
`prismWindowsTaskbarBadgeReadinessPatchSha256`。

## 七、成功产物

成功后文件位于：

```text
D:\prism-chromium\artifacts\144.0.7559.132-windows-x64
```

主要文件包括：

- `ungoogled-chromium_144.0.7559.132-1.1_windows_x64.zip`
- `ungoogled-chromium_144.0.7559.132-1.1_installer_x64.exe`
- `chromedriver.exe`
- `args.gn`
- `prism-build-lock.json`
- `manifest.json`
- `SHA256SUMS.txt`

编译结束后，把整个产物目录和最后一份日志复制回项目机器。Prism 集成时优先使用 ZIP，安装程序只用于独立内核验收。
新版 `prism-build-lock.json` 和 `manifest.json` 必须包含 `prismGeolocationPatchSha256`。

## 八、注意事项

- 当前产物没有 Prism 的商业代码签名，Windows SmartScreen 可能提示未知发布者；
- 第一次完整编译可能持续数小时到一天以上，取决于 CPU、内存、磁盘和网络；
- 不要把源码放在 exFAT、FAT32、网络盘、OneDrive 同步目录或路径包含空格的位置；
- 不要用 `Remove-Item -Recurse -Force` 清理不确定的路径；
- Windows 编译与 macOS 后续开发可以同时进行，互不阻塞。

## 上游依据

- Windows 平台构建仓库：<https://github.com/ungoogled-software/ungoogled-chromium-windows>
- Fingerprint Chromium：<https://github.com/adryfish/fingerprint-chromium/tree/144.0.7559.132>
- Chromium 144 Windows 构建要求：<https://github.com/chromium/chromium/blob/144.0.7559.132/docs/windows_build_instructions.md>
