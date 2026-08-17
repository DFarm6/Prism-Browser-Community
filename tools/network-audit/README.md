# 真实代理网络审计

该工具使用真实代理执行两阶段验收：

1. Node 通过代理分别访问 IPWho 与 ipify，要求两个独立服务返回同一个出口 IP，并取得完整国家、时区和城市级位置。
2. 启动 Prism Fingerprint Chromium，验证浏览器公网 IP、语言、时区、Geolocation、WebRTC、DNS 路由和 QUIC 配置。

可复制 `tools/network-audit/proxy.example.json` 创建本机私有配置。代理凭据放在该 JSON 文件中，报告只记录
协议和“是否使用凭据”，不会记录主机、端口、用户名或密码：

```json
{
  "protocol": "socks5",
  "host": "proxy.example.com",
  "port": 1080,
  "username": "account",
  "password": "secret"
}
```

建议将文件权限设为仅当前用户可读，然后执行：

```bash
chmod 600 private-proxy.json
npm run audit:network -- \
  --browser "/path/to/Chromium.app/Contents/MacOS/Chromium" \
  --proxy-file private-proxy.json \
  --platform macos \
  --version 144.0.7559.132 \
  --output release/network-audit-macos.json
```

Windows PowerShell：

```powershell
npm run audit:network -- --browser ".\release\win-unpacked\resources\kernels\current\chrome.exe" --proxy-file ".\private-proxy.json" --platform windows --platform-version 10.0.0 --version 144.0.7559.132 --debug-transport websocket --output ".\release\network-audit-windows.json"
```

HTTP、HTTPS 和 SOCKS5 使用同一流程。审计工具不会把凭据放入 Chromium 参数，而是先创建只监听
`127.0.0.1` 的临时无认证桥；Chromium 退出后桥会立即关闭。
