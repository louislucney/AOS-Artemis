# 03 — 批注文本分类与过滤

**What to build:** 设计稿中的批注文字（`Flow/*` 分组、note 类图层）不再被当作运行期文本进入断言候选；hints 按类别输出（运行期文本 / 批注 / 图层名），断言候选只用运行期文本，批注最多保留提示级展示。端到端：fixture 生成后断言与期望中不含批注文本。

**Blocked by:** 02（文本类别字段）。

**Status:** ready-for-agent

> 注（02 落地后边界收窄）：结构分类（`Flow/*` 祖先层 → `annotation`）已随 02 的文本类别字段落地；本票剩「消费过滤（断言候选/期望不吃批注与图层名）+ note 类图层细化 + starbucks 回归 fixture」。

- [ ] 结构规则分类：`Flow/*` 分组、note 类图层 → 批注；其余候选 → 运行期文本；图层名独立类别
- [ ] 断言候选与期望不再消费批注与图层名（提示级可展示，不参与判定）
- [ ] starbucks 式样例（「刊頭廣告 - 活動跑馬燈」「Flow/Section」类文本）固化回归 fixture
- [ ] 单测覆盖三类分类与过滤；不依赖设备/PG/外网
- [ ] 行为/接口变更同步 DESIGN.md（用法变更同步 README）；`npm run build && npm test && npm run lint` 全绿
