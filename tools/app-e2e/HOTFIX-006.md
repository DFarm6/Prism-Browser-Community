# Windows App E2E Hotfix 006

该热修处理 Windows Chromium 退出后短暂占用 profile `lockfile` 的情况。E2E 临时目录清理现在会对
`EBUSY`、`EPERM` 和 `ENOTEMPTY` 执行最多 12 次指数退避重试，单次等待上限为 2 秒。

报告中会出现：

```json
{
  "tool": {
    "name": "app-e2e",
    "version": 2,
    "cleanupContract": "windows-lock-retry-backoff-v1"
  }
}
```

把热修包的 `tools` 文件夹覆盖到现有 Beta 项目，然后再次运行：

```powershell
.\tools\internal-beta\Resume-Windows-Local-Acceptance.ps1
```

它会复用已有安装包，不重新编译 Chromium，也不重新打包。
