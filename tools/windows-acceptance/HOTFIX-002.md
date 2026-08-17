# Windows Acceptance Hotfix 002

该热修只替换 Windows 验收工具，不重新编译 Chromium，也不重新生成安装包。

把 `run.cjs` 覆盖到现有 Beta 项目的 `tools\windows-acceptance\run.cjs`，把
`Resume-Windows-Local-Acceptance.ps1` 覆盖到 `tools\internal-beta`，然后在项目根目录运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\tools\internal-beta\Resume-Windows-Local-Acceptance.ps1
```

脚本会复用现有 `release\win-unpacked`、安装版和便携版，依次完成包验收、应用 E2E、环境数据隔离、
四模板指纹矩阵和最终汇总。成功时最终报告为：

```text
release\local-acceptance-windows-0.2.0-beta.1-internal.json
```
