# Prism Browser Community

[简体中文](README.md) | [English](README.en.md)

作者：[DFarm](https://x.com/DFarm_club)

Prism Browser 是一个基于定制 Chromium 的本地指纹浏览器环境管理器。每个环境拥有独立的 Cookie、缓存、扩展数据、代理设置和指纹配置，适合管理多个相互隔离的浏览器身份。

浏览器环境、Cookie、代理凭据和浏览历史默认只保存在用户自己的设备上。Community 版本可以免费使用，不限制本地环境数量。

## 快速下载和使用

### 1. 下载应用

前往项目的 [Releases](../../releases) 页面，下载适合自己系统的最新版本：

- macOS：下载 DMG 安装包或 ZIP 版本；
- Windows：下载安装版，或者无需安装的 Portable 版本。

发布包已经包含可直接使用的 Chromium 144 指纹内核，普通用户不需要自行编译 Chromium。

如果未签名版本被系统拦截：

- macOS：在“系统设置 → 隐私与安全性”中确认打开；
- Windows：在 SmartScreen 提示中选择“更多信息 → 仍要运行”。

请只从本项目 Releases 页面下载文件，并在下载页面核对发布者提供的 SHA-256。

### 2. 创建第一个环境

1. 打开 Prism Browser，点击“新建环境”；
2. 填写环境名称，根据需要选择系统、语言、时区、屏幕和硬件身份；
3. 不使用代理时保持直连；使用代理时填写协议、主机、端口以及认证信息并先检测连接；
4. 保存环境，点击“打开”；
5. 关闭窗口后，Cookie、缓存、书签和扩展数据会继续保存在这个环境中。

不同环境使用独立的用户数据目录。复制环境时会保留配置，并自动生成新的环境身份和种子。

## 主要功能

- 创建和同时运行多个独立浏览器环境
- 每个环境独立保存 Cookie、缓存、书签和扩展数据
- HTTP、HTTPS、SOCKS5 代理及 WebRTC 防泄漏
- User-Agent、语言、时区、屏幕、CPU、内存和 GPU 身份配置
- Canvas、WebGL、Audio、DOMRect、字体、Speech 与 WebGPU 一致性处理
- 环境复制、分组、标签、收藏、批量操作和回收站
- Cookie、完整环境以及全部工作区的本地迁移
- macOS 环境 Dock 编号及 Windows 任务栏环境编号

## 已进行的检测

当前内核持续使用以下页面和本地审计工具进行交叉验证：

| 检测 | 重点检查内容 |
| --- | --- |
| Pixelscan | 浏览器、系统、位置、自动化和指纹一致性 |
| CreepJS | Window、Worker、Intl、Canvas、WebGL、Audio、DOMRect、字体和 Speech |
| BrowserLeaks | Canvas、WebGL、字体、Audio、WebRTC、客户端提示和屏幕信息 |
| IPhey | 浏览器、位置、IP、硬件、软件和机器人信号；RDP 会话可能被单独提示 |
| Prism fingerprint matrix | 同种子重启稳定、不同种子分离、跨 iframe/Worker 身份一致 |
| Prism profile-data audit | Cookie、存储数据持久化及环境间隔离 |

检测网站会持续更新，任何版本都不承诺永久通过所有第三方检测。代理质量、IP 信誉、远程桌面、系统字体和真实硬件环境也会影响结果。

## 面向开发者

### 编译桌面应用

需要 Node.js 22 或更新版本、npm，以及对应平台的基础构建工具。

```bash
npm ci
npm run typecheck
npm run build
```

开发运行：

```bash
npm run dev
```

生成不内置指纹内核的应用包：

```bash
# macOS
npm run dist:mac

# Windows
npm run dist:win
```

打包完成后，可以在应用的“浏览器内核”页面导入本地编译的 Chromium。

### 编译 Chromium 144 指纹内核

Chromium 首次编译需要下载完整源码和工具链。建议准备 32 GB 内存和约 300 GB 可用 SSD 空间；构建目录应使用系统原生文件系统、短路径并避免空格。

版本、上游提交、补丁顺序和 SHA-256 统一记录在 `tools/kernel-lock.json`。公共补丁位于 `tools/kernel-patches`，平台脚本位于：

- macOS arm64：`tools/macos-kernel`
- Windows x64：`tools/windows-kernel`

脚本会准备锁定版本源码、校验并应用补丁、生成 GN 构建配置、调用 Ninja 编译，最后输出 Chromium、Chromedriver、安装产物、构建清单和 SHA-256。

#### macOS arm64

需要 Xcode、Git、Python 3、Ninja 和 APFS 构建磁盘。接受 Xcode 许可证后，在仓库根目录执行：

```bash
cd tools/macos-kernel
./Check-Prerequisites.sh /Volumes/disk/prism-kernel
./Prepare-Source.sh /Volumes/disk/prism-kernel
./Build-Kernel.sh /Volumes/disk/prism-kernel 4
```

将 `/Volumes/disk/prism-kernel` 换成自己的构建目录，最后一个数字是 Ninja 并发任务数。

#### Windows x64

需要 Windows 10/11 x64、Visual Studio 的 C++ 桌面开发组件、Windows SDK、Git、Python 3 和 NTFS 构建磁盘。建议使用干净的 Python venv，避免 Anaconda 中的同名包干扰 Chromium 构建。

在普通权限 PowerShell 中进入仓库后执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd tools\windows-kernel
.\Check-Prerequisites.ps1 -BuildRoot D:\prism-chromium
.\Prepare-Source.ps1 -BuildRoot D:\prism-chromium
.\Build-Kernel.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

将 `D:\prism-chromium` 换成自己的短路径 NTFS 构建目录。首次检查如果提示必须启用 Windows 长路径，请按提示设置并重启系统后继续。

#### 中断续编与输出

如果已经生成 Ninja 构建图，停电或编译中断后重新执行对应平台的 `Build-Kernel` 命令即可增量续编，不需要重新下载完整源码。

构建结果位于所选构建目录的 `artifacts/<version>-<platform>`，日志位于 `logs`。详细依赖说明、增量补丁流程和故障处理分别见：

- `tools/macos-kernel/README.md`
- `tools/windows-kernel/README.md`

### 使用自己编译的内核

打开 Prism Browser 的“浏览器内核”页面，选择“导入本地构建”：

- macOS：选择编译生成的 `Chromium.app`；
- Windows：选择包含 `chrome.exe` 的 Chromium 构建目录或解压目录。

导入后先执行内核校验，再将它设为当前内核。已有环境仍会保留各自的数据和配置。

## Community 与 Pro

Community 已经包含完整的本地浏览器环境管理能力，可以永久免费使用。Prism Pro 在此基础上增加适合自动化、长期运行和本地 AI 协作的专业功能。

| 功能 | Community | Prism Pro |
| --- | :---: | :---: |
| 不限数量的本地浏览器环境 | ✓ | ✓ |
| 指纹配置、代理与 WebRTC 防泄漏 | ✓ | ✓ |
| 独立 Cookie、缓存、扩展和浏览器数据 | ✓ | ✓ |
| 环境复制、分组、批量操作和本地迁移 | ✓ | ✓ |
| 随应用提供的 Community 指纹内核 | ✓ | ✓ |
| 官方提供的新内核 | — | ✓ |
| 本地自动化 API | — | ✓ |
| 本地计划任务 | — | ✓ |
| 本地 AI · MCP 控制 | — | ✓ |

### Pro 功能

- **官方新内核**：无需在本机编译，即可使用随新版 Prism Browser 提供的新内核。
- **本地自动化 API**：在本机查询、启动和关闭指定浏览器环境，使用临时访问令牌，不对公网开放。
- **本地计划任务**：按照一次、每天或每周规则自动启动和关闭环境，适合固定时间运行的本地工作流程。
- **本地 AI · MCP**：只授权 AI 控制你选中的环境；AI 可以访问网页、读取页面内容、点击页面并填写表单，可随时停止或撤销环境权限。
- **本地优先**：Community 和 Pro 的环境数据都保存在用户自己的设备上，不会因为升级 Pro 而上传浏览器环境、Cookie、扩展数据或代理凭据。

Pro 为单设备一年授权。一枚激活码同一时间绑定一台设备；主动解绑后，可以在另一台设备继续使用剩余有效期。授权到期或解除绑定不会删除本地环境，Community 基础功能仍然可以继续使用。

## 安全报告

请不要在公开 Issue 中提交激活码、代理密码、Cookie、钱包信息、完整浏览器环境、私钥或包含个人数据的诊断文件。报告安全问题时，请提供最小复现步骤、受影响版本、平台和影响范围，并先删除敏感数据。

第三方检测网站的评分变化不一定代表安全漏洞。提交检测问题时，请同时提供检测网站、测试时间、内核版本、操作系统和具体失败字段。

## 许可证与第三方组件

Prism Browser Community 自有代码以 MIT License 发布。Chromium、ungoogled-chromium、fingerprint-chromium、Electron、React、Ant Design、Vite、TypeScript、Vitest、proxy-chain、undici、zod 及其他第三方组件继续遵循各自的开源许可证。

编译或分发 Chromium 时，必须同时保留 Chromium 源码和发行产物要求的 `LICENSE`、`LICENSES` 及组件通知。Prism Browser 的名称、标志和图标不因源码许可而自动授予商标使用权。

请仅将本项目用于合法、获得授权的浏览器隔离、自动化测试、隐私研究和账号管理。使用者应遵守目标网站条款及所在地区法律。
