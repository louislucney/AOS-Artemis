# 03 — 差异分类与严重度 + 阈值参数

**What to build:** 差异区域不再只有像素差异：用设计侧节点几何（设计树的 bbox/文本/名称）把每个候选区域归入 `missing / extra / position-size / color / text / asset`，并映射严重度 `blocker / major / minor / info`（主内容缺失/多余 ≥ major，文本区域差异 major，小面积颜色差异 minor）。判定阈值全部可配：像素阈值、最小区域面积、聚类间距、区域数上限（默认 0.1 / 0.5% / 8px / 20）。输出按「严重度 → 面积 → 坐标」排序。

**Blocked by:** 01（Figma × 实时截图 最小闭环）

**Status:** ready-for-agent

- [ ] 设计侧几何进入引擎：每个区域可携带设计节点引用（id/name）
- [ ] 类别判定规则与严重度映射按上述默认实现，且不依赖真机侧结构数据
- [ ] 工具参数暴露阈值（缺省用默认值），报告记录实际使用的阈值
- [ ] 落在系统边缘条带、且无对应设计节点的区域标 `suspected: "system-area"`，严重度压到 `info`
- [ ] 汇总 `byCategory` / `bySeverity` 正确且稳定排序
- [ ] 测试：合成用例覆盖每一类别与严重度（缺块、位移、变色、文本变化、多余元素）
