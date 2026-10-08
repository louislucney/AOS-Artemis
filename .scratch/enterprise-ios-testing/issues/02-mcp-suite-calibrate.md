# 02 — MCP：`suite calibrate`（xcresult → case_id 对齐/差分校准）

**What to build:** 新增 `suite calibrate`：读取确定性套件结果（`--report <json>` 或 `--xcresult <bundle>` 经 `xcrun xcresulttool get test-results tests`），按 case_id 对齐 MCP 台账，输出差分校准：agreed-pass/fail、MCP 漏报（XCTest fail 而 MCP pass）、MCP 误报（XCTest pass 而 MCP fail）、单边项；汇总漏报率/误报率并落盘 `.artemis/design/reports/calibration-<stamp>.json`。

**Blocked by:** None

**Status:** resolved

- [ ] 容错解析 xcresulttool test-results（嵌套 testNodes）与简化 `{tests:[{name,status}]}`
- [ ] case_id 对齐：测试名内嵌 `case-<12hex>` 优先；命名匹配兜底
- [ ] 单侧缺结果如实标注（xctest-only / mcp-only），不臆测
- [ ] 测试：解析、对齐、漏报/误报计算、落盘；不联网不跑 xcrun（`--report` 路径）
- [ ] 文档同步

## Comments

- 2026-10-08 实施：新增 `src/figma/calibration.ts`（容错解析 xcresulttool `testNodes`/简化 `tests[]`；case_id 以测试名内嵌匹配，不猜测）；`suite calibrate`（`--report`/`--xcresult`/`--fail-on-miss`/落盘 `.artemis/design/reports/calibration-*.json`）；纯函数测试 3 例 + CLI 测试 2 例；已用真实 Xcode 27 xcresult（64 tests）验证解析器。
