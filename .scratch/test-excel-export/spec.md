# 测试用例 Excel 导出（支持指定模版）

Status: ready-for-agent

## Problem Statement

测试工程师拿到了 `figma_generate_tests` 产出的 `tests.json` / `tests.md`，但无法直接交给非技术的 QA/产品在 Excel 里评审、勾选、排期执行：md 是给开发看的，json 不是人读格式。团队通常有自己固定格式的测试用例表格（模版），逐条手工复制粘贴既慢又容易漏。

## Solution

扩展 `figma_generate_tests`：在原有 `tests.json` + `tests.md`（过程文档）之外，**默认同时导出 `tests.xlsx`**，每个端到端流程一行（用例名称/涉及页面/步骤/artemis 任务描述）。

- 不传模版时：生成带表头、列宽、自动换行的开箱即用表格。
- 传 `excelTemplate` 时：读取用户的 `.xlsx` 模版，填充 `{{占位符}}`——元数据占位符任意单元格可用；含行级占位符的那一行会按用例数复制填充，保留模版原有样式。

## User Stories

1. 作为测试工程师，我想在 `figma_generate_tests` 后直接拿到 `tests.xlsx`，以便用 Excel 评审和分发用例，不用手工整理。
2. 作为测试工程师，我想让每一行对应一个端到端流程（用例名/页面链路/步骤/任务描述），以便逐条勾选执行。
3. 作为测试工程师，我想指定输出路径 `excelPath`，以便把用例表放在团队约定的目录而不是默认位置。
4. 作为测试工程师，我想传入团队现成的 `.xlsx` 模版，以便输出直接符合公司用例表格式，不用二次排版。
5. 作为测试工程师，我想在模版里用 `{{meta.source}}`、`{{meta.generatedAt}}` 等占位符，以便表头自动带上设计源与生成时间。
6. 作为测试工程师，我想在模版里用 `{{counts.cases}}` 等占位符，以便汇总区自动显示用例数。
7. 作为测试工程师，我想在模版里写一行 `{{index}}` / `{{case.name}}` / `{{case.screens}}` / `{{case.steps}}` / `{{case.taskDesc}}` 作为行模版，以便每一行自动按用例展开且保留模版样式（底色、边框、字体）。
8. 作为测试工程师，我想模版里其它说明性单元格（不在用例行上的文字）原样保留，以便模版的使用须知不被覆盖。
9. 作为测试工程师，我想步骤与任务描述在单元格里换行显示，以便一条用例的步骤可读。
10. 作为测试工程师，我想无模版导出也有可读的默认格式（表头加粗、列宽、换行），以便开箱即用。
11. 作为测试工程师，当模版里没有行级占位符时，我想得到明确的报错，以便立即修正模版而不是拿到一份静默丢数据的表。
12. 作为测试工程师，当模版文件不存在或不是 `.xlsx` 时，我想得到明确报错且不产生半成品文件，以便失败可重试。
13. 作为测试工程师，我想 `save:false` 时完全不写盘（json/md/xlsx 都不写），以便干跑预览。
14. 作为 AI agent，我想工具响应里包含 `savedTo.xlsx` 路径与是否使用模版的信息，以便把产物路径回传给用户或后续工具。
15. 作为 AI agent，我想 Excel 导出复用 `generateTestCases` 的结果（同一份用例数据），以便各格式内容一致、不重复生成。
16. 作为维护者，我想导出实现不新增网络/设备依赖，测试用内存 Buffer 与临时目录，以便在 CI 无外网环境稳定运行。

## Implementation Decisions

- **落点**：扩展现有 `figma_generate_tests` 工具，不新增独立工具。新增可选参数：
  - `excelPath?: string`：xlsx 输出路径（相对项目根），默认 `.artemis/design/tests.xlsx`。
  - `excelTemplate?: string`：`.xlsx` 模版路径（相对项目根或绝对路径）。
- **默认产出**：`save !== false` 时，`tests.json` / `tests.md` / `tests.xlsx` 三者都写。`save:false` 时三者都不写，也不读取/校验模版。
- **新增依赖**：`exceljs`（读写 `.xlsx`，自带类型）。仅运行时依赖，测试不联网。
- **新 seam**：`src/figma/test-gen.ts` 导出 `renderTestsWorkbook(cases, meta, { templatePath? }) => Promise<Buffer>`，与现有 `renderMarkdown` 同级；工具层调用它并把 Buffer 原子落盘。`writeFileAtomic` 扩展支持 `Buffer`。
- **模版占位符**（单元格字符串内做子串替换）：
  - 元数据（任意 sheet、任意单元格）：`{{meta.source}}`、`{{meta.generatedAt}}`、`{{counts.cases}}`、`{{counts.screens}}`、`{{counts.edges}}`。
  - 行级（触发行为行模版）：`{{index}}`（1 起）、`{{case.name}}`、`{{case.screens}}`（` → ` 连接）、`{{case.steps}}`（编号换行连接）、`{{case.taskDesc}}`。
  - 含行级占位符的**首个**行作为该 sheet 的行模版；按用例数复制（样式随行复制），逐行填充。多个 sheet 各自可带自己的行模版；只有元数据占位符的 sheet 原样填元数据。
  - 未识别的 `{{...}}` 占位符原样保留（便于发现笔误），不做报错。
  - 模版里没有任何行级占位符 → 报错（避免静默丢用例数据），且不写任何文件。
  - 用例数为 0 时，行模版行被移除（不留占位符）。
- **无模版默认表**：sheet 名 `测试用例`，表头 `["#", "用例名称", "涉及页面", "步骤", "artemis 任务描述"]`，表头加粗、首行冻结、列宽固定、步骤与任务描述列自动换行。
- **错误与写盘顺序**：先构建好 xlsx Buffer（含模版读取校验），再依次原子写 xlsx/json/md；模版错误在写盘前返回 `ok:false`，不产生半成品。
- **响应**：`savedTo` 增加 `xlsx` 字段；使用模版时附 `excel.template` 说明。
- 工具描述同步说明 xlsx 与模版能力。

## Testing Decisions

- 好测试只验证对外行为：给定用例与模版，得到一个可被 exceljs 重新解析的 Buffer/文件，断言 sheet 名、单元格值、行数、样式保留；错误场景断言报错与「未写任何文件」。
- **Seam 1（工具入口，现有）**：`figmaGenerateTests(runtime, args)`。临时项目写入 `flows.json`，调用工具，读回 `tests.xlsx` 用 exceljs 解析断言；覆盖默认导出、模版导出、坏模版不写盘、`save:false` 不写盘。先例：`test/import-tokens.test.js`。
- **Seam 2（纯函数，与 `renderMarkdown` 同级）**：`renderTestsWorkbook`。直接对返回的 Buffer 解析断言，覆盖默认表格式、元数据占位符、行模版展开与样式保留、缺行级占位符报错、0 用例。先例：`test/figma-testgen.test.js` 现有纯函数用例。
- 模版夹具在测试内用 exceljs 现写临时 `.xlsx`，不引入二进制 fixture；不依赖网络、PG、设备。

## Out of Scope

- 用例执行结果的回填（PASS/FAIL/耗时列）与执行过程 md 报告：执行仍走 `mobile_run_task` 与既有 trace/notes 机制，本特性只负责把「生成的用例」导出为 Excel。
- `.xls`/`.xlsm`（宏）、图表、条件格式、数据验证、图片等模版的完整保真：exceljs 能力范围内尽量保留，超出范围不保证。
- 独立的 `figma_export_tests_excel` 工具或 CLI 子命令（可后续从 tests.json 重导时再加）。
- 多语言/多套模版批量导出。

## Further Notes

- 「测试的过程产生 md 文件」由既有 `tests.md` 承担，本次不改变其结构；xlsx 与 json/md 共用同一份 `generateTestCases` 数据，保证三份产物一致。
- 模版使用说明需写进 DESIGN.md 工具表与 README，占位符清单要完整列出，便于用户自制模版。
- `exceljs` 为 CJS 包，NodeNext + esModuleInterop 下用默认导入即可；构建产物无需额外打包步骤。
