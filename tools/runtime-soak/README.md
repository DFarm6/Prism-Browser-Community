# 主进程长时间运行趋势分析

分别在环境启动稳定后、30 分钟和 2 小时通过 Prism“导出诊断包”保存 JSON，然后执行：

```bash
npm run analyze:soak -- \
  --output artifacts/runtime-soak.json \
  artifacts/diagnostics-start.json \
  artifacts/diagnostics-30m.json \
  artifacts/diagnostics-2h.json
```

工具比较 Prism 主进程的 RSS、Heap、External Memory、累计 CPU 和 Node 活动资源类型，同时确认
Launcher 没有残留启动/关闭任务和遗留进程。诊断包不包含环境名称、代理凭据或浏览内容。

当前 Gate 是用于发现明显的持续增长：

- RSS 增长不超过初始值 50% 或 128 MiB 中的较大值；
- Heap 增长不超过初始值 50% 或 64 MiB 中的较大值；
- External Memory 增长不超过初始值或 64 MiB 中的较大值；
- 活动资源增长不超过初始数量或 20 个中的较大值；
- 区间平均主进程 CPU 不超过 50%；
- 最后一次快照没有启动、关闭、队列或遗留进程。

浏览器子进程的站点内存会随页面内容变化，不计入 Prism 主进程泄漏 Gate。固定本地页面下的真实 Chromium
主进程和全部子进程可使用 `npm run audit:stress` 单独验收。
