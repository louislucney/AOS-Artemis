# 10 — 元素级映射自动发现 + accessibilityIdentifier 建议

**What to build:** 执行/探索观测时按文本 + 几何自动匹配设计元素 ↔ 可点击元素并持久化（带 confidence）；输出代码侧 accessibilityIdentifier 建议；人工可补关键路径。端到端：跑一次执行 → 资产含元素级映射 → 生成物/简报含 identifier 建议。

**Blocked by:** 08（对账资产与观测证据）。

**Status:** ready-for-agent

- [ ] 匹配规则确定性（文本归一化 + 几何），误配可控（阈值/多候选择一策略）
- [ ] 元素级映射写入持久资产（与屏幕级映射共存）；关键路径可人工补
- [ ] identifier 建议出现在简报/生成物，命名遵循技术栈约定
- [ ] 单测（匹配/持久化/建议）；不依赖设备/PG/外网
- [ ] 行为/接口变更同步 DESIGN.md（用法变更同步 README）；`npm run build && npm test && npm run lint` 全绿
