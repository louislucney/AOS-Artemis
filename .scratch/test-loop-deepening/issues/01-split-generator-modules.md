# 01 — 生成器拆分：Excel 引擎与缺口分析独立成 module

**What to build:** 把测试用例 xlsx 渲染引擎与资源缺口分析从现有的生成/流程 module 中拆出，各自成为独立 module；对外行为与全部产物（tests.json / tests.md / tests.xlsx、gaps.json、工具响应）逐字节不变。这是纯 prefactor，为后续 IR 与运行器让路。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] xlsx 渲染（默认 sheet、模版占位符、样式与行复制、错误语义）与拆分前逐字节一致，现有 testgen 用例全绿
- [x] 缺口分析（扫描规则、命名、建议目录）与拆分前一致，现有 flows 用例全绿
- [x] 工具注册、响应与落盘路径不变；无行为/接口变更
- [x] `npm run build && npm test && npm run lint` 全绿

## Comments

- 2026-10-02 实施：新增 `src/figma/test-xlsx.ts`（`WorkbookMeta` + `renderTestsWorkbook` 及默认表/模版引擎原样搬移；`test-gen.ts` 改为引用并移除 ExcelJS 依赖）与 `src/figma/gaps.ts`（`flows.ts:255-588` 的扫描/命名/缺口段原样搬移 + 本地 `jsonResult`/`TOKEN_HINT`）；`color.ts`/`strings.ts`/`import.ts`/`server.ts` 改从 `gaps.js` 导入，`flows.ts` 仅保留流程图抽取。测试导入相应调整（引擎 → test-xlsx、gap 符号 → gaps）；全量 376 例通过、lint 绿，工具注册/响应/落盘路径与产物未变。见 DESIGN.md §13.30。

