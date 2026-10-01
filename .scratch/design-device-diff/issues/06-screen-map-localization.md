# 06 — `screen_map` 工具 + 报告定位

**What to build:** 新增 `screen_map` 工具（`list` / `propose` / `save`）维护持久屏幕映射 `screen-map.json`（设计屏幕/组件 ↔ 路由、组件、文件；schema 版本化）；`propose` 基于 build-brief 与栈约定生成候选，`save` 显式幂等写入，差异工具只读。差异报告为每个区域写入 `localized`：命中映射则带条目，否则 `unmapped` 并给候选；无 build-brief 时说明原因。

**Blocked by:** 03（差异分类与严重度 + 阈值参数）、01（Figma × 实时截图 最小闭环）

**Status:** ready-for-agent

- [ ] `screen_map` list：读取并返回映射与 schema 版本；文件缺失返回空表与提示
- [ ] `screen_map` propose：粗粒度候选（带 `confidence` 与 `unmatched`，不承诺全覆盖；Figma 节点 id 与代码无天然映射），由 agent 复核后 save
- [ ] `screen_map` save：显式写入、幂等（重复内容不写）、非法输入报错
- [ ] 差异报告 `localized` 字段：`mapped`（含条目）/ `unmapped`（含候选或原因）
- [ ] 测试：temp project 上 propose/save/幂等/只读；报告定位字段断言
