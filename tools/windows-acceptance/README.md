# Windows 安装包自动验收

该脚本在 Windows 10/11 x64 真机对 Prism `release` 目录执行无网络自动验收：

- 校验安装版、便携版及 `SHA256SUMS-windows-x64.txt`；
- 校验 `win-unpacked` 中 Prism 主程序和内置 Chromium 关键文件；
- 使用独立临时 Electron 用户目录启动管理端，确认页面完整渲染；
- 使用两个临时 Chromium `user-data-dir` 分别写入 Cookie 和 LocalStorage；
- 使用与产品窗口相同的完整指纹参数，并为两个临时环境保持各自稳定的种子；
- 各自重启后确认数据持久存在且没有跨环境串号；
- 输出单个无代理凭据、无浏览内容的 JSON 报告，默认自动删除临时数据。

需要 Node.js 22 LTS x64。脚本只监听 `127.0.0.1` 随机调试端口，不访问外部网络，也不会读取
`%APPDATA%\prism-browser` 的正式数据。

在 Prism Windows 打包项目根目录执行：

```powershell
npm run accept:windows -- `
  --unpacked ".\release\win-unpacked" `
  --output ".\release\windows-package-acceptance.json"
```

使用独立验收工具包时，可以直接指定此前的 v3 项目目录：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\tools\windows-acceptance\Run-Windows-Acceptance.ps1 `
  -ProjectRoot "E:\Prism-Windows-Package-Kit-144.0.7559.132-v3"
```

正常结果为：

```text
Windows package acceptance: PASS
PASS  deliverableHashes
PASS  bundledKernelIntegrity
PASS  prismManagementWindow
PASS  independentProfilePersistence
PASS  independentProfileIsolation
```

只有排查失败时才使用 `--keep-data`；它会保留系统临时目录中的验收数据。
