# 11 — 验收口径入生成（设计标注先行）

**What to build:** 设计标注/人工确认表达的验收口径成为硬断言期望来源（与来源模型绑定）；无口径的屏保持提示级；冲突交人工（走 09 审阅面）；Jira AC 摄取留待后续集成。端到端：fixture 含验收标注 → 硬断言期望来自口径并带来源字段。

**Blocked by:** 03、04、09（分类过滤、探索分流、人工裁决面）。

**Status:** resolved

> 实施注（2026-10-10）：`Flow/AC*` 分组与 `AC:`/`验收：` 前缀批注识别为验收口径（空体忽略、每屏 ≤5、flows.json `screens[].acceptance`）；assert 期望优先取口径（`hintsSource:"acceptance"`），无口径回退运行期文本（提示级）；`.artemis/design/acceptance.json` 人工确认覆盖优先；Jira AC 摄取留后续集成。见 DESIGN §13.70。

- [ ] 验收口径的识别规则（设计标注形式）与解析；模糊时保守为提示级
- [ ] 硬断言期望来源 = 口径/人工确认，与 hints 分类联动；冲突经审阅面裁决
- [ ] 单测（口径解析/保守回退/冲突路径）；不依赖设备/PG/外网
- [ ] 行为/接口变更同步 DESIGN.md（用法变更同步 README）；`npm run build && npm test && npm run lint` 全绿
