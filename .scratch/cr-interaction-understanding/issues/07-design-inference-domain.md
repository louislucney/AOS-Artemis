# 07 — `design-inference` 失败域 + 报告来源显示

**What to build:** 失败归域新增 `design-inference`（设计推断错误可辨识）；套件报告与移动任务摘要显示断言的来源/置信度，让使用者区分「改设计 / 改用例 / 改应用」。端到端：构造推断来源步骤失败的台账 → 归域为 `design-inference` 且报告呈现来源。

**Blocked by:** 02（来源模型）。

**Status:** resolved

> 实施注（2026-10-10）：新增 `design-inference`（纯探索失败 high；混合脚本需 adherence 双证据：断言全命中 + 探索未全达成 → medium；否则回落）；tests.json expectations 汇总 + iOS adherence 解析入 `FailureInput.scriptProvenance`；套件控制台/JSON 与 run-report xlsx 显示「脚本 断言N/探索M」；移动任务摘要经 `test_summary.adherence` 透出。**设计↔观测冲突**归类依赖票 08/09 对账资产（本票未覆盖）；`jira_evidence_post` 未接线（边界见 DESIGN §13.66）。

- [ ] 失败域枚举扩展 + 确定性归类规则（推断来源失败/设计↔观测冲突 → design-inference），与既有域优先级不冲突
- [ ] 套件报告与移动任务摘要显示来源/置信度
- [ ] 单测：归域规则（含既有域回归）与报告字段；不依赖设备/PG/外网
- [ ] 行为/接口变更同步 DESIGN.md（用法变更同步 README）；`npm run build && npm test && npm run lint` 全绿
