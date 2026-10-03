# 05 — 文档与端到端验收

**What to build:** DESIGN 实施记录 + 数据契约；README/接入指南补充；端到端一条（假 Figma 不需要，直接 seeded 日志文本 + 假 collector）覆盖注册表 → 采集 → 分类 → 报告。

**Blocked by:** 04.

**Status:** ready-for-agent

- [x] DESIGN 记录（含 error-codes.json 契约与非目标）
- [x] README/接入指南更新（工作原理与 CLI 用法）
- [x] 全量 `build && test && lint` 全绿

## Comments

- 2026-10-02 实施：DESIGN §13.36 实施记录（含注册表/产物契约与非目标）、README CLI suite 段（api-errors、--fail-on api-error、报告列）与 `docs/接入指南.md`（suite 用法、项目准备表、排障行）；端到端链路由 suite-runner → run-report 用例覆盖；全量 412 例通过、lint 绿。
