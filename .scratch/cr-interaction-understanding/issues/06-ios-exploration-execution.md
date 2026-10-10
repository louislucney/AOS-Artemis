# 06 — iOS 探索步骤执行语义

**What to build:** iOS 执行器识别探索步骤：可执行但不硬失败，记录实际路径与命中，标 deferred；adherence 只核对硬断言；起始屏 preflight 与终态验证语义保持。端到端：假设备跑 fixture，探索步失败不挂用例、实际路径与 deferred 留痕在 trace/摘要。

**Blocked by:** 04（探索步骤表示）。

**Status:** ready-for-agent

- [ ] 执行器解析并执行探索步骤：失败不置用例失败；实际路径/命中写入 run.json 与摘要
- [ ] adherence 仅统计硬断言；deferred 标记在 run.json / test_summary 可见
- [ ] 既有硬断言语义、preflight、终态验证行为不回归
- [ ] 单测（假设备/假 WDA）；不依赖真机/PG/外网
- [ ] 行为/接口变更同步 DESIGN.md（用法变更同步 README）；`npm run build && npm test && npm run lint` 全绿
