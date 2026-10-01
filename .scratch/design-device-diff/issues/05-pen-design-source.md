# 05 — `.pen` 设计源

**What to build:** 设计源新增 `.pen`：经 pen CLI 渲染出位图（复用 `pen_export` 的定位/登录/超时/失败分类），并从 `.pen` 解析节点几何供分类使用；用户可以不依赖 Figma 完成同一条对比闭环。

**Blocked by:** 01（Figma × 实时截图 最小闭环）

**Status:** ready-for-agent

- [x] 设计源参数支持 `.pen` 路径（缺省取项目内最新文件，与既有 pen 工具一致）
- [x] 渲染复用既有 CLI 通路（可注入假 exec 供测试），未安装/未登录/超时错误分类一致
- [x] 报告 `unit.design.source = "pen"`，并携带设计节点（屏幕/组件）名称与几何
- [x] 渲染产物路径可配置，默认落既有 pen 导出目录
- [x] 测试：假 CLI exec 产出 fixture 图 + `.pen` fixture；错误分支

## Comments

- 2026-10-01 实施完成：`src/diff/pen-source.ts`——`penDesignNodes`（绝对坐标（父级累加）、`$变量`/hex 填充解析、最近祖先填充作 `parentFill`、flex 子节点无坐标时跳过）与 `renderPenDesign`（复用 `runPenExport`：默认落 `.artemis/design/pen/<name>.png`、`renderOut` 可配、失败分类与清理、未登录/超时提示一致）；工具 `design:{source:"pen",penPath?,renderOut?}`（缺省最新 .pen），Figma 路径保持兼容；报告 `unit.design={source:"pen",name}`；分类 tie-break 改为「同交集取更小节点」（修复容器节点压过子节点）。测试 5 例（`test/diff-pen-source.test.js`），全量 296 例通过；DESIGN §6.1/§13.17、README、AGENTS 已同步。
- code-review 修订：渲染复用 pen CLI 托管（`penEnvFrom` + `ensurePenCli`，测试可注入 ensure）、diff 渲染统一 1×（修复与 1× 节点几何的 2× 坐标错位，Figma 路径同步）、缺 `.pen` 与 CLI 错误分别给 `PEN_HINT`/`PEN_CLI_HINT`、报告新增 `designScreens`（顶层节点几何）、无几何容器不再剪掉子树、移除超出验收的 `timeoutMs` 入参；设备/锚点采集先于设计渲染。
