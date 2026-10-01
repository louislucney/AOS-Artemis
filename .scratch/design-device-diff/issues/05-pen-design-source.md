# 05 — `.pen` 设计源

**What to build:** 设计源新增 `.pen`：经 pen CLI 渲染出位图（复用 `pen_export` 的定位/登录/超时/失败分类），并从 `.pen` 解析节点几何供分类使用；用户可以不依赖 Figma 完成同一条对比闭环。

**Blocked by:** 01（Figma × 实时截图 最小闭环）

**Status:** ready-for-agent

- [ ] 设计源参数支持 `.pen` 路径（缺省取项目内最新文件，与既有 pen 工具一致）
- [ ] 渲染复用既有 CLI 通路（可注入假 exec 供测试），未安装/未登录/超时错误分类一致
- [ ] 报告 `unit.design.source = "pen"`，并携带设计节点（屏幕/组件）名称与几何
- [ ] 渲染产物路径可配置，默认落既有 pen 导出目录
- [ ] 测试：假 CLI exec 产出 fixture 图 + `.pen` fixture；错误分支
