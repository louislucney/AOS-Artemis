# 04 — 推断边 → 探索步骤（生成语义）

**What to build:** 推断来源的跳转在生成物中表现为探索步骤：可执行、不断言、标 deferred；taskDesc 与「AOS-EXPECT」块携带来源标记且保持平台中立（Android 侧忽略语义不变）。端到端：用含 inferred 边的 fixture 生成 → tests.json/md/xlsx 出现探索步骤而非硬断言步骤。

**Blocked by:** 02（来源模型）。

**Status:** ready-for-agent

- [ ] 生成器按来源分流：inferred → 探索步骤（可执行动作描述、不断言、deferred 标记）；explicit-interaction/confirmed → 现行硬断言路径
- [ ] 探索步骤不进入硬断言期望集合；taskDesc 与「AOS-EXPECT」块扩展可辨识且不破坏既有解析
- [ ] 旧 flows（legacy-unknown）按保守 = 探索处理；三件套同时落盘规则不回归
- [ ] 单测：分流 / 兼容 / 三件套；不依赖设备/PG/外网
- [ ] 行为/接口变更同步 DESIGN.md（用法变更同步 README）；`npm run build && npm test && npm run lint` 全绿
