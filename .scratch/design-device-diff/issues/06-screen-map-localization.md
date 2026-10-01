# 06 — `screen_map` 工具 + 报告定位

**What to build:** 新增 `screen_map` 工具（`list` / `propose` / `save`）维护持久屏幕映射 `screen-map.json`（设计屏幕/组件 ↔ 路由、组件、文件；schema 版本化）；`propose` 基于 build-brief 与栈约定生成候选，`save` 显式幂等写入，差异工具只读。差异报告为每个区域写入 `localized`：命中映射则带条目，否则 `unmapped` 并给候选；无 build-brief 时说明原因。

**Blocked by:** 03（差异分类与严重度 + 阈值参数）、01（Figma × 实时截图 最小闭环）

**Status:** ready-for-agent

- [x] `screen_map` list：读取并返回映射与 schema 版本；文件缺失返回空表与提示
- [x] `screen_map` propose：粗粒度候选（带 `confidence` 与 `unmatched`，不承诺全覆盖；Figma 节点 id 与代码无天然映射），由 agent 复核后 save
- [x] `screen_map` save：显式写入、幂等（重复内容不写）、非法输入报错
- [x] 差异报告 `localized` 字段：`mapped`（含条目）/ `unmapped`（含候选或原因）
- [x] 测试：temp project 上 propose/save/幂等/只读；报告定位字段断言

## Comments

- 2026-10-01 实施完成：`src/diff/screen-map.ts`（version=1、确定性序列化、save 幂等/merge、propose 基于 build-brief + 栈约定、非法条目索引报错）；工具 `screen_map`（list/propose/save）注册；`design_device_diff` 区域输出 `localized`（mapped/unmapped/no-candidates）；Figma 节点几何补 depth=0 屏幕根节点。测试 5 例（`test/diff-screen-map.test.js`），全量 301 例通过；DESIGN §6.1/§13.18、README、AGENTS 已同步。
- code-review 修订：`localized` 契约字段对齐 spec（`mapEntry`）；`no-candidates` 带 `reason` 区分「无 build-brief/候选未覆盖」；组件条目允许仅 `design.component`（propose 不再伪填 screen）；候选惰性生成；坏 `build-brief.json` 降级不阻断对比；`screen-map.json` 损坏标记 `corrupt`；本地化辅助下沉 `screen-map.ts`、handler 更名 `screenMap`；DESIGN 表格转义修复；补「diff 只读映射」断言。
