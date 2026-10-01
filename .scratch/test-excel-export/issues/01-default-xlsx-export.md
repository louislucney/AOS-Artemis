# 01 — 默认 xlsx 导出（无模版）

**What to build:** `figma_generate_tests` 在 `save !== false` 时，除既有 `tests.json` + `tests.md` 外默认再产出一份开箱可用的 `tests.xlsx`（默认表头、列宽、自动换行、首行冻结），响应 `savedTo` 带出 xlsx 路径；`excelPath` 可覆盖输出位置；`save:false` 时三份都不写。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] `figma_generate_tests` 默认落盘 `<项目>/.artemis/design/tests.xlsx`，内容与测试用例数据一致（用例名/页面链路/步骤/任务描述）
- [x] 无模版工作簿含表头 `# / 用例名称 / 涉及页面 / 步骤 / artemis 任务描述`，表头加粗、首行冻结、步骤与任务描述列自动换行
- [x] `excelPath` 可指定相对项目根的输出路径；`save:false` 时 json/md/xlsx 均不写盘
- [x] 响应 `savedTo.xlsx` 可被调用方直接定位产物
- [x] xlsx 生成失败时不产生半成品（先构建 Buffer 再原子写盘）
- [x] `renderTestsWorkbook(cases, meta, options?) => Promise<Buffer>` 纯函数 seam 可被单元测试直接解析断言
- [x] DESIGN.md 工具表与工具描述同步 xlsx 能力；构建/测试/lint 全绿
