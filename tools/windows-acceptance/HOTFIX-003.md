# Windows Acceptance Hotfix 003

该热修让环境隔离验收使用已在 Windows 真机通过的 Chromium 启动序列：先用完整指纹参数和
`about:blank` 建立 WebSocket CDP，再创建本地存储测试页面。它同时启用 Chromium 启动日志；
如果仍然失败，报告的错误信息会附带最后一段 stderr。报告中应出现：

```json
{
  "tool": {
    "name": "windows-package-acceptance",
    "version": 3,
    "profileLaunchContract": "fingerprint-websocket-about-blank-v1"
  }
}
```

把 `run.cjs` 覆盖到现有 Beta 项目的 `tools\windows-acceptance\run.cjs`，把
`Resume-Windows-Local-Acceptance.ps1` 覆盖到 `tools\internal-beta`，然后在项目根目录运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\tools\internal-beta\Resume-Windows-Local-Acceptance.ps1
```

该脚本复用已有 Windows 安装包与 `win-unpacked`，不重新编译 Chromium，也不重新打包。
