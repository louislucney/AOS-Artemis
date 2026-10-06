# 09 — 缺口分析 iOS 修正（颜色解析 / @2x 匹配）

**Milestone:** M2（设计代码化）

**What to build:** iOS 项目的 `figma_gap_analysis` 不再把已有的 colorset/Swift 颜色全部报缺失，也不把仅 `@2x/@3x` 的 imageset 误报为资产缺口。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] iOS 颜色提取支持清单：colorset JSON（浮点组件 → hex）、Swift `Color(red:green:blue:opacity:)`、`Color("assetName")`（经 colorset 解析）；其余形式声明不识别（诚实口径）
- [x] 资产 basename 规范化剥离 `@2x/@3x` 后再匹配
- [x] 测试 fixtures 覆盖两类误报场景（含形式清单边界：不识别形式不产生误报）
- [x] DESIGN.md 同步；`npm run build && npm test && npm run lint` 全绿

## Comments

- 2026-10-06 实现完成（未提交）：`npm run build && npm test && npm run lint` 全绿（542 tests）；行为契约见 DESIGN §13.52–13.53 与 spec 决策 2–19。
