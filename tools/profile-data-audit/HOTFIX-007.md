# Windows Profile Data Audit Hotfix 007

该热修修复 profile 数据审计重复启动同一 `user-data-dir` 时读取旧 `DevToolsActivePort` 的问题。
每次 WebSocket 模式启动前都会删除旧端口文件，等待当前 Chromium 写入新随机端口，并对建连进行
短暂重试。错误信息会标明具体 profile 和读写阶段。

报告中会出现：

```json
{
  "tool": {
    "name": "profile-data-audit",
    "version": 2,
    "cdpLaunchContract": "websocket-fresh-port-retry-v1"
  }
}
```

把热修包的 `tools` 文件夹覆盖到现有 Beta 项目，在普通权限 PowerShell 中再次运行：

```powershell
.\tools\internal-beta\Resume-Windows-Local-Acceptance.ps1
```

它会复用已有安装包，不重新编译 Chromium，也不重新打包。
