# 02 — 来源模型置标（provenance / confidence / 文本类别）

**What to build:** 流程与用例产物携带机器可读的来源（显式交互 / 推断 / 真机观测 / 人工确认）与置信度、文本类别。解析置标：Figma 显式交互=explicit-interaction，pen 合成=inferred；生成携带到 step/expectation。旧产物缺字段按 legacy-unknown 保守（推断级）消费，不静默升权；解析升级可回填。端到端：fixture 解析与生成 → 产物带来源字段；旧 fixture 走保守路径。

**Blocked by:** 01（无交互检测决定 pen 置标为推断的前提）。

**Status:** ready-for-agent

- [ ] 流程 screen/edge 与用例 step/expectation 新增来源与置信度字段，枚举语义与 CONTEXT.md / ADR-0008 一致
- [ ] Figma 显式交互标 explicit-interaction；pen 合成标 inferred；解析升级可回填
- [ ] 缺字段旧产物 = legacy-unknown，按保守级消费；schema 版本策略明确且向后兼容
- [ ] 文本类别字段就位（消费规则留 03）
- [ ] 单测覆盖置标 / 回填 / 兼容三组；三件套落盘规则不回归；不依赖设备/PG/外网
- [ ] 行为/接口变更同步 DESIGN.md（用法变更同步 README）；`npm run build && npm test && npm run lint` 全绿
