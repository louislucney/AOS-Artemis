# 04 — 报告、反馈与 CLI 透出

**What to build:** `suite report` xlsx/JUnit 增加 API 错误与处理判定列/元素（读 trace 产物，可追溯 traceId）；`suite feedback` 聚合未处理错误为可追踪建议；CLI 新增 `suite api-errors <traceId>` 手动采集复算。

**Blocked by:** 03.

**Status:** ready-for-agent

- [x] xlsx 列与 JUnit failure 内容含错误码/处理判定；无产物时留空不报错
- [x] feedback 输出 api 维度建议（默认只建议）
- [x] `suite api-errors <traceId>` 支持 `--serial/--no-save/--json`；退出码语义与 evidence 一致

## Comments

- 2026-10-02 实施：`run-report` 读 trace 产物 → 逐例 `apiErrors/apiErrorsDegraded`，xlsx 追加「API 错误 / 处理判定」列，JUnit failure 内容追加 `api_error: CODE verdict=… handler=…`；`generation-feedback` 聚合未处理错误为 `issues.apiErrors` 与 `kind:"api"` 建议（可追踪 case/trace）；CLI 新增 `suite api-errors <traceId>`（注册表缺失→2、无状态/采集失败→1、成功→0，`--serial/--no-save/--json`），`suite run` 支持 `--no-api-errors/--fail-on api-error`；run-report/generation-feedback/suite-command 测试增补全绿。
