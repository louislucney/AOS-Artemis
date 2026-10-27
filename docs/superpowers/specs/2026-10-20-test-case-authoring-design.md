# 测试用例生成字段与 Excel 契约设计

日期：2026-10-20  
状态：P0/P1/P2 已实施（P0 2026-10-20；P1/P2 2026-10-26）；P2 历史对比为「最新 vs 上一批同平台」，完整时间线/趋势为后续增强
参考输入：`/Users/louis/Downloads/v4.9.0- Test Case.xlsx`（人工用例，2 个 sheet、41 条用例）

## 1. 意图与背景

AOS 当前生成的 `tests.json / tests.md / tests.xlsx` 已经能表达“流程 → 可执行任务”，但与人工用例相比，缺的是**可追溯的身份、数据、预期结果和待确认信息**：

- 人工表有 `TC_01` 编号、`Modules / Section` 两级归类、`Precondition`、`Test Data`、`Related TC`、`Step ↔ Expected Result` 对照、`Remarks` 和汇总页。
- AOS 当前默认 Excel 只有 6 列：`# / 用例名称 / 涉及页面 / 前置假设 / 步骤 / artemis 任务描述`。
- AOS 的 `tests.json` 已有 `id / expectations / preconditions / feature`，但没有模块/Section、测试数据、关联用例、设计引用、待确认项和可读用例编号。

本设计把这批人工经验落成一套**附加字段 + 默认 Excel/Markdown 契约 + 生成规则**，先保证不破坏现有三件套、模板和门禁。

## 2. 目标 / 非目标 / 反目标

### 目标

- G1：`tests.json` 增加可选字段，支持可读编号、模块/Section、测试数据、关联用例、设计引用、待确认项、变体标记。
- G2：默认 `tests.xlsx` 在保留原有 6 列的前提下追加列，并新增汇总 sheet。
- G3：`tests.md` 与 `taskDesc` 同步呈现新增信息；任务描述增加 `【测试数据】` 与 `【待确认】` 块。
- G4：所有新增信息都有明确来源；没有来源就显式标注“无”，不臆造。
- G5：旧 `tests.json`、旧模板、旧调用方保持可用。

### 非目标

- N1：不直接导入或复刻这份人工 Excel；它是设计输入，不是新的导入格式。
- N2：生成计划里不写执行结果；执行结果仍由 `suite report` / `suite_runs` 产出。
- N3：不改流程线性化、覆盖门禁、续段拆分和现有 `expectations` 语义。
- N4：不做 LLM 自由发挥式“补数据/补预期”；新增内容必须来自设计、验收口径或人工提供的结构化字段。

### 反目标

- A1：为凑满 `Test Data` 编造账号、门店、金额或商品。
- A2：模板里未知占位符被静默替换为空。
- A3：为了新增列破坏 `tests.xlsx` 前 6 列的位置或三件套落盘契约。
- A4：把“警告”当成“已确认规则”，或把探索步骤写成硬断言。

## 3. 约束

- 三件套契约不变：`save !== false` 时 `tests.json + tests.md + tests.xlsx` 同时落盘。
- `excelPath` 覆盖输出路径、`excelTemplate` 套模板的行为不变；模板模式只扩展占位符。
- 生成/测试不依赖网络、真实 PG 或设备。
- 现有 `expectations` 与 `steps` 一一对应；新增“预期结果”列只做渲染，不改变执行语义。
- 旧 `tests.json` 无新增字段时，Excel 对应列显示 `—` 或 `n/a`，不报错。
- 用例集归档（`case-sets/`）沿用现有命名 `<YYYYMMDD_HHmmss>_<功能>`，新增字段随归档 JSON 一起保存。
- **`caseId` 是既有机器身份**（`case-<sha12>`，被运行清单、套件结果、台账、面板、`suite run --case`、回归报告使用）；本设计不重命名、不迁移它。新增的可读编号使用独立名字 `displayId`，Excel 列名用 `用例编号`，避免两个“用例ID”。

## 4. 数据模型

### 4.1 `GeneratedTest` 新增字段（全部可选、附加）

```ts
export interface DesignRefs {
  screens: string[];
  nodeIds: string[];
  route?: string;
}

export interface CaseVariant {
  group: string;
  label: string;
  /** P1：变体额外预期；不合并进 expectations（保持 1:1 步骤对齐）。 */
  expected?: string[];
}

export interface GeneratedTest {
  // 既有字段不变
  displayId?: string;           // 可读编号，见 4.2
  module?: string;              // 功能名（feature name）
  section?: string;             // 用例入口屏 / 路由段
  testData?: string[];          // 逐条“键：值”文本，原样呈现
  relatedCases?: string[];      // 其他 displayId（同一产物内）
  designRefs?: DesignRefs;
  openQuestions?: string[];     // 待确认文本
  variant?: CaseVariant;
}
```

**字段名说明**：不使用 `caseId`，因为它已表示机器身份；`relatedCases` 内放 `displayId`，不是机器 `id`。

### 4.2 可读编号（displayId）

- 格式：`TC_<6 位十六进制>`，取自既有稳定 `id`（`case-<sha12>`）的后 6 位，例如 `case-e2b707762568` → `TC_762568`。
- 理由：人工表用 `TC_01` 顺序号，但顺序号在重新生成/增删用例后会漂移；稳定哈希更适合 Jira、运行记录和跨版本对照。
- 冲突：同一份生成内重复时追加 `-2`、`-3`。
- `#` 列继续表示本次生成中的顺序；`displayId` 不承担排序职责。
- 机器引用仍以 `id` 为准；`displayId` 只用于展示、沟通和表内关联。
- 同一用例在 live 产物与各功能归档中保持同一个 `displayId`（由 `id` 推导，与子集无关）。

### 4.3 模块与 Section

- `module` = `feature` 对应功能名；无 feature 时回退 `未分组`。
- `section` = `preflight.screen`（用例入口屏）去空白；缺失时回退 `startScreen`，再缺失回退 `screens[0]`，仍为空则 `未指定`。
- 不做语义猜测（例如不从步骤文本推断“選擇門市”这种人工 Section）；人工可用验收文件覆盖（7.1 的 `section` 覆盖）。

### 4.4 预期结果（不新增字段）

`expectations` 已与 `steps` 对齐；Excel/Markdown 渲染规则：

- `kind === "explore"` → `（探索，不判定）`。
- 有 `screen` 且有 `hints` → `→ <screen>：<hints 前 3 条，`、`分隔>`；`hintsSource === "acceptance"` 追加 `（验收口径）`。
- 有 `screen` 无 hints → `→ <screen>`。
- 无 expectation → `—（无显式期望）`。
- `prelude` 步骤 → `—（前导导航）`。
- P1 变体：在编号预期之后追加 `变体预期（<label>）：...`，不改变 `expectations` 长度。

### 4.5 Payload 汇总（按产物范围）

`tests.json` 顶层增加：

```json
{
  "schemaVersion": 2,
  "summary": {
    "modules": ["訂單與探索"],
    "sections": ["首頁", "到店自取_MOP"],
    "cases": 215,
    "withTestData": 12,
    "openQuestions": 3,
    "variantGroups": 2
  }
}
```

- **按产物范围计算**：live 产物统计全部 flows；每个功能归档（`case-sets/*.json`）统计该子集，`summary`、`relatedCases`、`汇总` sheet 都以子集为准，避免归档里出现不属于自己的 case 计数/引用。
- `schemaVersion` 缺失视为 1；新生成写 2。
- 旧读取方忽略未知字段；新读取方对 v1 按“无新增信息”处理。
- `summary.openQuestions` 计数是“条目数”，不是“涉及用例数”；`summary.withTestData` 是“有测试数据的用例数”。

## 5. 数据来源与生成规则

### 5.1 `testData`

- 类型为 `string[]`，每条是可直接呈现的“键：值”文本（例：`搜尋關鍵字：南山`）。
- 来源只有人工结构化的验收文件 `.artemis/design/acceptance.json` 的 `data` 映射（见 7.1）；不做键值拆分、不从步骤文本猜测。
- 用例覆盖的屏幕集合与 `data` 的键求交集，按用例屏幕顺序拼接，去重，最多 12 条。
- 无命中 → `[]`；Excel 显示 `n/a（无显式数据）`，Markdown 不显示该小节，`taskDesc` 不注入空块。

### 5.2 `openQuestions`

- 类型为 `string[]`，每条可直接呈现。
- P0 来源只有验收文件 `questions` 映射（按屏幕），按用例屏幕顺序拼接、去重、最多 10 条。
- **P0 不把设计警告自动挂到每条用例**：`DesignWarning` 没有用例/屏幕作用域，逐行复制会噪声化；警告仍走现有响应/`tests.json.warnings`/`tests.md`/`suite check` 面。
- 普通信息类警告（如 `feature-identity-new`、截图降级）不升级为“待确认”。
- 后续若需要“警告→用例”映射，作为 P2 单独立项（需要先给 warning 增加 screen/case 作用域）。

### 5.3 `relatedCases`

- 在同一产物范围内（live 或单个功能归档）查找：同 `module`，或与当前用例共享至少 1 个屏幕；排除自身。
- 按“共享屏幕数降序 → displayId 升序”取前 3。
- 无候选 → `[]`。
- 保证引用对象存在于同一产物；跨功能引用不输出。

### 5.4 `designRefs`

- `screens` = 用例覆盖屏幕（与 `screens` 字段一致）。
- `nodeIds` = 这些屏幕在 flow graph 中的 `id`（Figma 节点 id / pen 节点 id），按屏幕顺序。
- `route` = 入口屏的 `suggestedRoute`（存在时）。
- 无节点 id → 只输出屏幕名，不伪造引用。

### 5.5 变体（P1）

- 验收文件 `variants` 可按屏幕定义变体行（标签、数据、额外预期）。
- 生成时克隆命中屏幕的基准用例：
  - `displayId` 仍由 `id` 推导；克隆的 `id` 哈希**纳入 variant.label**，避免与基准用例撞 id。
  - `variant = {group, label, expected}`；`testData` 合并变体 `data`。
  - 不重写 `steps`/`expectations`；变体额外预期单独渲染（4.4）。
- 无显式 variants 时只做展示分组（`module + section` 相同且 ≥2 条 → 汇总页计数组），**不自动生成新用例**。

### 5.6 `taskDesc` 注入

在既有 `【真实数据】` 与 `【AOS-EXPECT】` 之间追加：

```text
【测试数据】
- 搜尋關鍵字：南山
- 我的最愛：已滿 5 個

【待确认】
- 上次點購門市是本地存儲還是 API 存儲？
```

- 空数组不注入对应块。
- 不改写 `【真实数据】` 文案；测试数据是补充，不是替代。
- 执行器遇到 `【待确认】` 只记录、不当作断言。

## 6. Excel / Markdown 契约

### 6.1 默认 `tests.xlsx`

保留 sheet 名 `测试用例` 和前 6 列位置不变，在末尾追加 8 列：

| # | 列 | 来源 | 空值显示 |
|---|----|------|----------|
| 1 | `#` | 顺序号 | — |
| 2 | `用例名称` | `name` | — |
| 3 | `涉及页面` | `screens.join(" → ")` | — |
| 4 | `前置假设` | `preconditions.join("；")` | — |
| 5 | `步骤` | `prelude P1.. + steps 1..` | — |
| 6 | `artemis 任务描述` | `taskDesc` | — |
| 7 | `用例编号` | `displayId` | `—` |
| 8 | `模块` | `module` | `未分组` |
| 9 | `Section` | `section` | `未指定` |
| 10 | `测试数据` | `testData` 行 `- text` | `n/a（无显式数据）` |
| 11 | `关联用例` | `relatedCases.join(", ")` | `—` |
| 12 | `预期结果` | 与步骤同编号的多行文本 | `—（无显式期望）` |
| 13 | `设计引用` | `屏名(nodeId)` 或屏名 | `—` |
| 14 | `备注/待确认` | `openQuestions` 行 `- text` | `—` |

- 第 1–6 列位置不变，避免破坏按列号读取的既有脚本。
- 第 5、6、10、12、14 列 `wrapText + vertical: top`。
- 表头加粗、首行冻结，保持现有样式。

### 6.2 汇总 sheet

新增 sheet `汇总`（`项 | 值 | 说明`），按当前产物范围统计：

- 来源、生成时间、用例总数、功能数、模块数、Section 数。
- 有测试数据用例数、待确认数、变体组数。
- 硬覆盖（complete/uncovered screens/edges）、探索覆盖、警告数。
- 执行统计固定写 `待执行（由 suite report 回填）`，不伪造通过/失败数字。
- 平台/版本/设备：生成期未知 → `n/a`；不阻塞。

### 6.3 模板模式

`excelTemplate` 继续按行级占位符复制。新增占位符：

- `{{case.displayId}}`
- `{{case.module}}`
- `{{case.section}}`
- `{{case.testData}}`（多行）
- `{{case.relatedCases}}`
- `{{case.expectations}}`（多行、与步骤同编号）
- `{{case.designRefs}}`
- `{{case.openQuestions}}`
- `{{case.variantLabel}}`
- `{{case.variantExpected}}`
- `{{counts.withTestData}}`、`{{counts.openQuestions}}`

未知占位符原样保留；不新增“缺字段即报错”的硬失败（模板作者自行决定）。

### 6.4 `tests.md`

- 每例标题：`### <displayId> · <module> / <section> — <name>`；字段缺失时用 `未分组 / 未指定`。
- 小节顺序：前置假设 → 测试数据（非空才显示）→ 步骤 → 预期结果 → 待确认（非空才显示）→ artemis 任务描述。
- 截图、警告、对账信息保持现状。

### 6.5 Excel 导入路径（`workflow/excel-import.ts`）

`renderTestsWorkbook` 同时服务生成与 Excel 导入。导入产物也使用同一 14 列 + `汇总` sheet，映射如下：

- `module` = 导入模块名（feature name）；`section` = `screens[0]`；缺失时按 4.3 回退。
- `displayId` = 导入器已有的 `caseId`（`imp-<sha8>-<行号>`，本身可读且稳定）；不另生成 `TC_`。
- `testData` / `openQuestions` = `[]`（导入列若含“测试数据/备注”则后续 P1 接入）。
- `预期结果` = 导入的 `expectations`（`kind`/`text`）按步骤渲染；探索步显示 `（探索，不判定）`。
- `designRefs` = `screens`，无节点 id。
- `汇总` = 导入子集计数。
- 不保留“旧版 6 列”模式；导入与生成共用同一渲染契约，避免两套表。

## 7. 验收文件 schema（附加）

### 7.1 `acceptance.json` v2（向后兼容）

```json
{
  "screens": {
    "首頁": ["預設顯示會員等級與最新資訊"]
  },
  "data": {
    "選擇門市": ["搜尋關鍵字：南山", "我的最愛：已滿 5 個"]
  },
  "questions": {
    "選擇門市": ["上次點購門市是本地存儲還是 API 存儲？"]
  },
  "section": {
    "首頁": "行動預點"
  },
  "variants": [
    {
      "screen": "選擇門市",
      "label": "我的最愛已滿 5 個",
      "data": ["我的最愛：5 個"],
      "expected": ["第 6 個愛心點擊時提示：我的最愛最多可儲存 5 個"]
    }
  ]
}
```

- 旧格式 `{screens: {name: string[]}}` 继续有效。
- `data` / `questions` 的键是屏幕名，值是字符串数组；空串/非字符串忽略；不要求键值分隔。
- `section` 是屏幕 → 人工 Section 名的覆盖；命中时优先于 4.3 的自动回退。
- `variants` 仅接受含 `screen + label` 的条目；`data`/`expected` 可选。
- 非法条目忽略并产生 `acceptance-details-invalid` 警告（不阻断生成）。
- 上限：每屏 data/questions 各 20 条、variants 20 条，超出截断并告警。

## 8. 兼容性与迁移

- `tests.json`：新增字段全部可选；`schemaVersion` 缺失按 1 处理。旧用例集归档无需迁移。
- `tests.xlsx`：前 6 列不变；新增列只追加。现有精确断言表头的测试需更新（`test/figma-testgen.test.js`）。
- Excel 导入：列形状与生成统一；导入测试需补新列/汇总断言（`test/workflow-excel-import.test.js` 等）。
- `tests.md`：标题格式变化会影响按旧标题匹配的脚本；设计上接受，并在实现时更新相关测试。
- 模板：新增占位符是附加能力；旧模板不受影响。
- `suite check`：只检查三件套存在/时效/`【真实数据】`，新增字段不参与门禁。
- `suite backfill`：忽略归档 JSON 中的新增字段；不影响 `createdAt`/basename 解析。
- 文件命名不变（`<YYYYMMDD_HHmmss>_<功能>`）。

## 9. 实施分期

### P0（先做）

- `displayId`、`module`、`section`。
- `testData`（仅 acceptance `data`；无则 `n/a`）。
- `openQuestions`（仅 acceptance `questions`）。
- 默认 Excel 追加 8 列 + `汇总` sheet。
- Markdown 标题/小节、`taskDesc` 两个新块。
- `acceptance.json` 的 `data`/`questions`/`section` 读取。
- Excel 导入路径同契约（缺失字段 `—/n/a`）。
- 纯函数单测 + xlsx/md/taskDesc 断言。

### P1

- `relatedCases`、`designRefs`。
- `variants` 克隆与 `variant` 标记（含独立 id 哈希、变体预期）；汇总页变体组计数。
- 模板新增占位符全量测试。

### P2

- 执行结果回填（独立 sheet 或 `suite report` 联动，不写进生成计划）。
- 跨平台（AOS/iOS）结果列；历史运行对比。
- 设计警告→用例的 scope 映射（需要 warning 带 screen/case 作用域）。

## 10. 我的决定（可被覆盖）

- **新增可读编号叫 `displayId` / `用例编号`，不动既有 `caseId`**：避免机器身份与展示编号混淆。
- **Excel 保留前 6 列并追加**：优先兼容既有按列号读取的脚本。
- **生成计划不写执行结果**：避免计划和事实混在一张表。
- **测试数据/待确认都是 `string[]`，不做键值拆分**：人工表本身就是“键：值”文本，拆分会引入歧义。
- **设计警告不自动逐条挂到用例**：没有作用域，先只在现有警告面呈现。
- **变体克隆放 P1**：P0 只做字段和展示，避免生成数量/门禁突变。
- **导入与生成共用同一 Excel 契约**：不维护两套表。
- **汇总页执行统计留空**：不伪造 0 或通过率。

## 11. 验收测试清单（实现时）

1. `tests.json`：新字段存在性、可读 displayId、module/section 回退、summary 计数（live 与功能子集分别正确）。
2. 旧 `tests.json` 无新字段：加载/渲染不报错，Excel 显示 `—/n/a`。
3. 默认 xlsx：14 列表头、行值映射、`预期结果` 与步骤编号对齐、`汇总` sheet 计数。
4. 模板：新旧占位符替换、未知占位符原样保留、多行 wrap。
5. `taskDesc`：有数据/无数据、有待确认/无待确认四个分支。
6. `acceptance.json` v1/v2：旧格式兼容、`section` 覆盖、非法条目告警、上限截断。
7. Markdown：标题格式、空小节不出现、截图不受影响。
8. Excel 导入：同一 14 列 + 汇总；缺失字段回退值；导入 expectations 渲染。
9. P1：变体克隆 id 唯一、变体预期独立渲染、子集 relatedCases 不越界。
10. 回归：`npm run build && npm test && npm run lint` 全绿。

## 12. 不在本设计内

- 把人工 Excel 直接导入为用例（另有 `run_regression` Excel 导入路径）。
- 从需求文档自动抽取规则/默认值/上限。
- 自动生成跨平台执行结果列。
- 更改 `suite check`/覆盖门禁口径。
