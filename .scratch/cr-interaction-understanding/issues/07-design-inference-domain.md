# 07 — `design-inference` 失败域 + 报告来源显示

**What to build:** 失败归域新增 `design-inference`（设计推断错误可辨识）；套件报告与移动任务摘要显示断言的来源/置信度，让使用者区分「改设计 / 改用例 / 改应用」。端到端：构造推断来源步骤失败的台账 → 归域为 `design-inference` 且报告呈现来源。

**Blocked by:** 02（来源模型）。

**Status:** ready-for-agent

- [ ] 失败域枚举扩展 + 确定性归类规则（推断来源失败/设计↔观测冲突 → design-inference），与既有域优先级不冲突
- [ ] 套件报告与移动任务摘要显示来源/置信度
- [ ] 单测：归域规则（含既有域回归）与报告字段；不依赖设备/PG/外网
- [ ] 行为/接口变更同步 DESIGN.md（用法变更同步 README）；`npm run build && npm test && npm run lint` 全绿
