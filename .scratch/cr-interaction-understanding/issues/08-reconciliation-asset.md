# 08 — 对账资产核心（证据记录 + 导航级自动升级）

**What to build:** 持久对账资产（模式照 screen-map，ADR-0004 先例）：记录设计与真机观测的差异、边的观测证据与升级状态；真机走通的导航自动升级（inferred → runtime-observed）；资产可审计、可复用，缺省不改变既有行为。端到端：执行产生证据 → 资产落盘 → 下次生成消费升级结果。

**Blocked by:** 06（执行侧证据与 deferred 语义）。

**Status:** ready-for-agent

- [ ] 资产 schema（版本化、稳定排序、纯函数读写）落项目设计目录；含设计↔观测对账条目与升级状态
- [ ] 导航级自动升级规则确定（证据门槛明确）；硬断言级不自动升级（留 09 人工/验收口径）
- [ ] 生成侧消费升级结果（至少：后续生成可用 runtime-observed 导航）
- [ ] 单测：纯函数 / 持久化 / 升级规则（仿 screen-map 先例）；不依赖设备/PG/外网
- [ ] 行为/接口变更同步 DESIGN.md（用法变更同步 README）；`npm run build && npm test && npm run lint` 全绿
