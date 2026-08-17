# Prism Browser 正式发布

正式发布与日常开发包分开。发布脚本采用失败关闭：缺少发行证书、公证凭据、时间戳或签名更新配置时，
不会生成可被标记为正式版本的结果。

## 1. 准备离线更新签名密钥

在独立的安全机器或密码管理系统中创建 Ed25519 密钥。私钥不得进入项目、打包机产物或更新服务器：

```bash
openssl genpkey -algorithm Ed25519 -out prism-update-private.pem
openssl pkey -in prism-update-private.pem -pubout -out prism-update-public.pem
```

从 `build/update-config.example.json` 创建 stable 和 beta 两份配置，填写各自 HTTPS 清单地址与公钥。
配置只包含公钥，可以嵌入安装包。

## 2. macOS 签名、公证与验收

安装 Developer ID Application 证书，使用 CI 密钥库注入 `CSC_NAME` 和 Apple 公证凭据，然后执行：

```bash
tools/release/Build-Mac-Release.sh \
  /path/to/Chromium.app \
  /secure/path/update-config-stable.json
```

脚本会复制 Chromium、按 Helper 职责使用 hardened runtime 重新签名，再构建 Prism。随后强制验收
Developer ID、Gatekeeper、Apple stapler、内置内核摘要和更新公钥。私钥不参与打包。

## 3. Windows Authenticode 与验收

在 Windows 真机通过 CI 密钥库注入 `CSC_LINK`、`CSC_KEY_PASSWORD`，执行：

```powershell
.\tools\windows-package\Build-Prism-Windows.ps1 `
  -KernelZip ".\kernel\ungoogled-chromium_144.0.7559.132-1.1_windows_x64.zip" `
  -UpdateConfig ".\secrets\update-config-stable.json" `
  -RequireCodeSigning `
  -TimestampUrl "https://<证书颁发机构提供的 RFC3161 地址>"
```

门禁会验证 Prism、内置 Chromium、安装版与便携版的 Authenticode 证书及 RFC 3161 时间戳。

## 4. 生成签名更新清单

收集两台构建机已经验收的 DMG 和 Windows 安装器，在持有更新私钥的安全环境运行：

```bash
npm run release:update-manifest -- \
  --channel stable \
  --version 0.2.0 \
  --private-key /secure/prism-update-private.pem \
  --notes /secure/release-notes.txt \
  --artifact "darwin-arm64,dmg,/release/Prism-Browser.dmg,https://cdn.example.com/stable/Prism-Browser.dmg" \
  --artifact "win32-x64,exe,/release/Prism-Browser-Setup.exe,https://cdn.example.com/stable/Prism-Browser-Setup.exe" \
  --output /release/latest.json
```

先上传按版本不可变的安装文件，确认 CDN 的大小和 SHA-256 后，最后原子替换 `latest.json`。
回滚发布只允许签署一个版本号更高的新清单，不允许覆盖旧版本对应的安装文件。

## 5. Beta 候选版与灰度门禁

运行 `npm run beta:export-kit` 生成 `release/beta-acceptance-kit`，把工具包复制到最终离线验收机器。
先执行其中的 `verify-kit.mjs`，再按工具包 README 验证双平台候选安装文件、发行签名报告和真机证据归档。

门禁只授权证据中申请的一个灰度阶段，不会执行上传或发布。`internal` 之后必须按策略顺序逐级申请；
任何暂停信号、证据归档哈希变化、指标不达标或恢复构建版本不高于当前候选版都会失败关闭。
