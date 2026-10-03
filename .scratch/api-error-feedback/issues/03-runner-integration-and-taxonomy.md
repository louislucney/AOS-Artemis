# 03 — suite-runner 集成与 api-error 失败域

**What to build:** 每例终态后按时间窗采集并匹配，结果落 `.artemis/traces/<traceId>/api-errors.json` 并进 `SuiteCaseResult.apiErrors`；`classifyFailure` 新增 `api-error` 域（仅 unhandled 触发，优先级低于环境、高于数据环境）；`suite run --fail-on api-error` 可让未处理错误阻断通过。

**Blocked by:** 01, 02.

**Status:** ready-for-agent

- [x] 逐例 `apiErrors` + degraded 原因可见；采集可注入（测试假 collector）
- [x] 无注册表/无设备时不阻塞，其余用例照跑
- [x] unhandled → 失败域 api-error；handled/observed 不改域仅作证据
- [x] `--fail-on api-error` 时未处理错误使用例 FAIL（默认不阻断）

## Comments

- 2026-10-02 实施：`failure-taxonomy` 新增 `api-error` 域（仅 `handled === false` 触发，优先级：崩溃 > 环境 > api-error > 数据环境 > …）；`suite-runner` 每例终态按需加载注册表、采集并匹配（`logcatCollector` 可注入）、落 `.artemis/traces/<traceId>/api-errors.json`，`SuiteCaseResult.apiErrors + apiErrorsDegraded`、`SuiteRunReport.apiErrorCatalog`；`--fail-on api-error` 时未处理错误把 passed 改判 failed（默认仅证据）；suite-runner 增 4 例（含 e2e 到 report）全绿。
