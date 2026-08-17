# Windows Acceptance Hotfix 004

该热修修复环境隔离测试的导航竞态。Chromium 仍以 `about:blank` 安全启动并建立 WebSocket CDP，
随后测试通过 `Page.navigate` 显式进入本机 `127.0.0.1` HTTP 页面；只有 URL 与
`document.readyState` 同时正确后，才写入 Cookie 和 LocalStorage。

报告中应出现：

```json
{
  "tool": {
    "name": "windows-package-acceptance",
    "version": 4,
    "profileLaunchContract": "fingerprint-websocket-http-navigation-v2"
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
