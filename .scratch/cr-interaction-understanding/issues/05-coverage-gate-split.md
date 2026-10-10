# 05 — 覆盖口径与门禁分离 + `--strict`

**What to build:** `suite check`/`suite run` 的覆盖闸区分硬覆盖（explicit/observed/confirmed）与探索覆盖；`requireFullCoverage` 按硬覆盖判定、探索覆盖单独报告；弱断言可选 `--strict` 升门禁。端到端：CLI 对不同 fixture 输出新口径的退出码与报告。

**Blocked by:** 04（探索步骤表示）。

**Status:** ready-for-agent

- [ ] 覆盖计算（单一实现）扩展为硬/探索两类；默认门禁不被推断边虚高
- [ ] `requireFullCoverage` 语义更新（文档化）；探索覆盖在响应与报告可见
- [ ] `--strict`：弱断言可选纳入门禁；默认行为不变（退出码 0/1/2 语义保持）
- [ ] 单测 + CLI 行为测试（退出码与报告断言）；不依赖设备/PG/外网
- [ ] 行为/接口变更同步 DESIGN.md（用法变更同步 README）；`npm run build && npm test && npm run lint` 全绿
