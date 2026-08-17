# Prism Browser Beta 候选版验收

本工具包不包含任何证书、私钥、代理凭据或正式更新地址。macOS 与 Windows 分别完成正式签名打包后，
把安装文件和平台验收报告集中到一台隔离机器做最终离线验签。

收到或复制本目录后，先验证工具包本身：

```bash
node verify-kit.mjs /path/to/beta-acceptance-kit
```

## 平台证据

两个平台都必须完成：

1. 打包应用端到端验收；
2. native 和 fixed-template 指纹审计；
3. 环境数据备份、恢复和隔离验收；
4. 代理出口、WebRTC、DNS 与 Geolocation 身份验收；
5. 至少 2 小时运行趋势检查；
6. 至少 20 次启动与 5 次从上一 Beta 升级；
7. 使用一个版本号更高、代码回退的恢复构建完成回滚演练。

Windows 继续使用 `tools/windows-acceptance`、`audit:fingerprint-matrix`、`audit:network`、
`audit:profile-data` 和 `analyze:soak`。macOS 使用相同 npm 工具，并额外运行
`tools/packaging/Verify-Mac-Package.sh` 的正式签名模式。

## 候选安装包离线验签

先使用离线 Ed25519 公钥验证更新清单、两个安装文件和两份平台签名验收报告：

```bash
node verify-update-candidate.mjs \
  --manifest /candidate/latest.json \
  --public-key /candidate/prism-update-public.pem \
  --require-channel beta \
  --artifact "darwin-arm64,/candidate/Prism-Browser-beta.dmg" \
  --artifact "win32-x64,/candidate/Prism-Browser-Setup-beta.exe" \
  --acceptance "darwin-arm64,/candidate/macos-release-acceptance.json" \
  --acceptance "win32-x64,/candidate/windows-signing-acceptance.json" \
  --output /candidate/beta-candidate-verification.json
```

## 灰度与恢复门禁

从 `evidence.template.json` 复制证据文件，只填写已实际执行的数据和报告归档 SHA-256。校验时必须同时传入
macOS 与 Windows 的实际证据归档，工具会重新计算哈希，不能只靠手工填写：

```bash
node validate-evidence.mjs \
  --candidate /candidate/beta-candidate-verification.json \
  --evidence /candidate/beta-evidence.json \
  --evidence-bundle "darwin-arm64,/candidate/macos-beta-evidence.zip" \
  --evidence-bundle "win32-x64,/candidate/windows-beta-evidence.zip" \
  --policy ./beta-rollout-policy.json \
  --output /candidate/beta-rollout-readiness.json
```

首次把 `rolloutGate.requestedPhase` 设为 `internal`、`completedPhase` 设为 `null`。晋级时，
`requestedPhase` 只能是紧邻的下一阶段，`completedPhase` 必须是刚完成的阶段，且 `observedHours`
达到策略要求；不能跳级。任何 `pauseSignals` 都会拒绝晋级。

通过只授权证据中申请的一个阶段，不会自动上传或扩大范围。每个阶段观察期结束后必须使用新的证据重新运行。
出现签名、哈希、指纹、环境数据、代理身份、崩溃率或更新成功率异常时立即暂停。

“回滚”不允许重新发布旧版本号；应构建一个版本号更高、代码回退的恢复版本，并再次执行完整签名和验收。
