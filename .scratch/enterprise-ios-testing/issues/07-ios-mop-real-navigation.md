# 07 — iOS：新 MOP 模块接入真实导航（L2 物理前提）

**What to build:** `AppDelegate` 目前仅在启动参数下 present 新 MOP 模块（独立模块 + 调试入口）。L2 流级"真实导航"E2E 需要生产入口可达新模块：确认真实 MOP 入口（OrderRevampHomePageViewController 等）与新 Revamp 模块的接线方式，最小接线（可带开关），并保证 release 构建生效路径明确。

**Blocked by:** None（先侦察；接入方式确认后实施）

**Status:** ready-for-human

- [ ] 侦察真实入口与旧/新单品页路由关系，产出接线方案（含回滚）
- [ ] 最小接线实施或明确阻塞结论（若涉及产品决策则转 ready-for-human）
- [ ] 构建验证 + 手动导航路径说明

## Comments

- 2026-10-08 侦察结论：真实入口 `OrderRevampHomePageViewController`（Order tab）→ 旧单品页 `OrderRevampItemDetailLongViewController`，4 处调用（Feature cell / Search / ReviewOrder / LoggedInPrevious，经 StoryboardManager 实例化）。
- 阻塞点：新模块 `MOPItemDetailViewController` 无真实购物车/后端集成（加入购物车仅本地 toast），直接接入真实导航会回归真实购物车行为。
- 建议接线方案（待产品决策）：① 真实商品模型 → `MOPItemDetailProduct` 映射适配；② 开关路由（远程/编译配置）控制新旧单品页；③ 回滚=关开关。前置条件=购物车/后端集成。故转 ready-for-human。

- 2026-10-08 补充（映射缺口证据）：4 处调用点传入的现有详情页为 `OrderItemDetailViewController`（TW CR，`item=[data getBasicItemData]`、`itemSizesInfo=[data getItemSizesInfo]`）或旧 Revamp Long 页；新模块 `MOPItemDetailProduct` 需要 options/steppers/nutrition 等富结构，现有 basic 数据结构不直接携带 → 接线需专门的数据适配层，故确认阻塞于产品决策而非纯路由开关。

- 2026-10-08 边界修正（用户指示）：MCP 不深入项目实现细节；本票保留为**项目侧**决策/实施事项，MCP 侧不再推进（MCP 侧对应能力为 `suite loop` 的"测试→完善"迭代）。
