# 02 — 模版占位符与行复制

**What to build:** `figma_generate_tests` 新增 `excelTemplate`：读取用户 `.xlsx` 模版并填充占位符——元数据占位符任意单元格可用；含行级占位符的行按用例数复制（保留样式）并逐行填充；缺行级占位符或模版不可读时明确报错且不写任何文件；0 用例时行模版被移除。README/AGENTS 同步完整占位符清单与用法示例。

**Blocked by:** 01 — 默认 xlsx 导出（无模版）。

**Status:** ready-for-agent

- [x] `excelTemplate` 支持相对项目根/绝对路径，指向不存在的文件或非 `.xlsx` 时 `ok:false` 且不写任何产物
- [x] `{{meta.source}}` / `{{meta.generatedAt}}` / `{{counts.cases}}` / `{{counts.screens}}` / `{{counts.edges}}` 在任意 sheet 单元格内子串替换
- [x] `{{index}}` / `{{case.name}}` / `{{case.screens}}` / `{{case.steps}}` / `{{case.taskDesc}}` 所在行作为该 sheet 的行模版，按用例数复制并保留样式（底色/字体/边框），多 sheet 各自可用行模版
- [x] 模版无行级占位符时报错（不静默丢用例）；未识别的 `{{...}}` 原样保留；0 用例时行模版行被移除
- [x] 步骤与任务描述在单元格内换行可读；说明性单元格文字原样保留
- [x] 工具响应带出所用模版信息；纯函数 seam 与工具入口均有用例覆盖
- [x] README、DESIGN.md、AGENTS.md 同步模版用法；构建/测试/lint 全绿
