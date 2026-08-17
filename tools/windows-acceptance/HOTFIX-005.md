# Windows Acceptance Hotfix 005

该热修修复同一 `user-data-dir` 重启时的 CDP 随机端口竞态。Chromium 会在 profile 中保留
`DevToolsActivePort`；如果脚本在第二次启动时先读到旧文件，就会连接已经关闭的随机端口。

脚本现在会在每次启动前删除旧的 `DevToolsActivePort`，等待新 Chromium 写入当前端口，并对
WebSocket 建连进行短暂重试。错误信息也会标明 `profile-a/profile-b` 以及 `write/read` 阶段。

报告中应出现：

```json
{
  "tool": {
    "name": "windows-package-acceptance",
    "version": 5,
    "profileLaunchContract": "fingerprint-websocket-fresh-port-v3"
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
