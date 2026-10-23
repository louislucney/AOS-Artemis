# design_to_test：人类/执行器双层产物设计

> 日期：2026-10-23
> 状态：已实施（2026-10-23）
> 范围：`design_to_test` / `figma_generate_tests` 产物、API 变更交互、tests.md 截图链路

## 1. 背景与问题

当前 `design_to_test` 生成的 Excel/Markdown 同时承载两类信息：

- 测试人员需要：页面、步骤、预期、测试数据、设计图；
- 执行器需要：`taskDesc`、`AOS-EXPECT`、a11y identifier、i18n key、设计节点引用。

结果是人工文档里混入 `设计元素：…`、`i18n: …`、`a11y: …`、`【AOS-EXPECT】` JSON、nodeId 等实现细节；步骤还可能直接使用设计图层名（如 `Frame 2444`、`App Button`、`Icons/search`），不符合测试人员阅读习惯。

另有两个缺口：

1. 设计修改可能新增/修改 API，但当前生成流程没有显式确认，也不会要求接口说明；
2. `tests.md` 的截图嵌入受生成参数/环境影响，可能出现 screens/ 下已有 PNG、md 却无 `<img>` 且无 warning 的静默降级。

## 2. 目标

1. 同一份产物同时服务测试人员和执行器：
   - 人类层干净、可直接执行；
   - 执行器层完整保留技术信息，agent 可读取。
2. API 变更成为显式输入：有新增/修改 API 时要求提供说明；暂缺时先生成并标 pending，后续可补。
3. `tests.md` 默认嵌入设计图；关闭或失败必须可见。
4. 后续补 API 说明复用 `design_to_test`，不新建入口、不重复生成用例。

## 3. 非目标

- 不自动从代码 diff 推断 API 变更；
- 不解析 OpenAPI 生成完整契约测试（只保存/呈现说明并关联用例）；
- 不把技术信息从执行器层删除；
- 不改变用例的覆盖闸、执行门禁、`suite run` 语义；
- 不强制所有项目重新生成历史用例（旧产物按旧结构可读）。

## 4. 人类层 / 执行器层

### 4.1 人类层（Excel 主表 / Markdown 正文）

Excel 主表列：

`# / 用例名称 / 涉及页面 / 前置假设 / 步骤 / 预期结果 / 测试数据 / 备注或待确认`

Markdown 正文：

- 用例标题、前置、测试数据、checklist 步骤、预期结果、待确认；
- 设计图嵌入在用例标题下；
- 不展示 `taskDesc`、`AOS-EXPECT`、a11y/i18n/nodeId。

### 4.2 执行器层

- Excel 新增隐藏 sheet「执行器」：`用例编号 / artemis 任务描述 / 设计引用 / 屏幕节点或标识`；
- Markdown 每个用例底部：

```md
<details>
<summary>执行器指令（agent 读取）</summary>

```text
【设计流程端到端验证】...
```

</details>
```

- 执行器层保留 `taskDesc`、`AOS-EXPECT`、a11y、i18n、nodeId；
- `tests.json` 保留现有 `taskDesc` 与结构字段，agent 仍可直接消费。

### 4.3 技术词清理（只作用于人类层）

- 步骤元素名优先取运行期可见文本（`textHints`）；
- 无可见文本时按元素类型给通用名称：按钮 / 输入框 / 列表项 / 图片 / 开关 / 标签页 / 弹层 / 其他可点击区域；
- 元素图层名只有在“看起来像人类可读文案”时才作为兜底；命中 `Frame`/`Group`/`Component`/`Vector`/`Rectangle`/`Ellipse`/`Icons/`、下划线/斜杠路径或纯代码标识时改用通用名称；
- 人类层不输出 `设计元素：…`、`i18n: …`、`a11y: …`；
- 人类层屏幕名使用可读名：优先 `sourceBoard` / 已有中文名，技术图层名回退为“未命名页面”；
- 机器层保留原始屏幕名、节点 id 与标识，供映射/执行。

## 5. API 变更交互

### 5.1 新参数

`design_to_test` 与 `figma_generate_tests` 增加：

```ts
apiChange?: "none" | "new" | "modified" | "unknown";
apiSpec?: string;          // 接口说明文本（Markdown/OpenAPI 片段均可）
apiSpecPath?: string;      // 或项目内文件路径；与 apiSpec 二选一
```

### 5.2 状态

| 输入 | apiReview.status | 行为 |
|---|---|---|
| `none` | `not-applicable` | 正常生成，文档标注“无 API 变更” |
| `new`/`modified` + spec | `provided` | 写入 `api-review.md`，Excel/MD 展示说明 |
| `new`/`modified` 无 spec | `pending` | 先生成；顶部/汇总可见“待补充 API 说明”；响应 `nextAction: provide-api-spec` |
| 未传 `apiChange` | `unknown` | 生成；提示确认是否涉及 API 变更 |

待补充不阻断生成，也不把用例标成通过；不伪造接口。

### 5.3 产物

- `tests.json` 顶层：

```json
{
  "apiReview": {
    "change": "new",
    "status": "pending",
    "specPath": null,
    "updatedAt": "2026-10-23T..."
  }
}
```

- `provided` 时写 `.artemis/design/api-review.md`（`apiSpec` 原文 + 元信息），`tests.json.apiReview.specPath` 指向它；
- Excel 汇总 sheet 增加 API 状态行；Markdown 顶部增加 API 状态块；
- 当说明存在时，人类层展示接口说明摘要/全文链接，执行器层保留原文路径。

### 5.4 后续补充（复用同一入口）

`design_to_test` 支持：

```json
{
  "reuseExistingFlows": true,
  "reuseExistingTests": true,
  "apiChange": "new",
  "apiSpec": "..."
}
```

行为：

- 不重新提取 flows、不重新生成用例、不改变 caseId；
- 只更新 `tests.json.apiReview`、`api-review.md`、`tests.md`、`tests.xlsx`；
- 返回 `apiReview.status="provided"` 与 `updatedArtifacts`。

## 6. tests.md 截图

- `design_to_test` 增加 `screens?: boolean`，默认 `true`，并显式传给 `figma_generate_tests`；
- 显式 `screens:false` 时在 `tests.json` / `tests.md` 写入 `screens-disabled` warning；
- 截图失败沿用 `screenshot-*` 降级 warning，但在 MD 顶部显示可见提示；
- 已有 PNG 可复用，不为截图重复渲染；
- 生成后校验：若 `screens` 开启且存在可映射屏幕，MD 至少包含一个 `<img>` 或明确 warning。校验失败只警告，不阻断落盘。

## 7. Excel 细节

- 默认工作簿主表人类列；隐藏「执行器」sheet；
- 自定义模板：
  - `{{case.steps}}` 继续输出人类步骤；
  - `{{case.taskDesc}}` 继续输出机器任务；
  - 模板作者自行决定列布局，不强制隐藏；
  - 文档说明模板可能包含技术信息。
- `设计引用` 列从人类主表移到执行器 sheet。

## 8. 测试

- 生成步骤不含 `设计元素` / `i18n` / `a11y` / `nodeId`；
- 元素名为技术图层名时回退通用名称；
- Excel 主表无 `taskDesc`，隐藏 sheet 含 `taskDesc`；
- MD 正文不含 taskDesc，折叠区含 taskDesc；
- `renderMarkdown` 传入图片映射时输出 `<img src="...">`；
- API 状态四种分支；pending 生成成功并返回 nextAction；补 spec 复用路径不改变 caseId；
- `design_to_test` 传 `screens:true` 覆盖 `AOS_SCREENS=0`；关闭时产生 warning；
- 旧 `tests.json` 无 `apiReview` 时正常读取。

## 9. 兼容与迁移

- `tests.json` 新字段均为可选；旧产物无需迁移；
- `GeneratedTest` 新增字段可选，旧 case-set 读取不变；
- 新生成默认使用双层结构；重复生成会重建三件套；
- 不改变 `mobile_run_task` 入参：仍传 `flows[].taskDesc`。

## 10. 实施顺序

1. 人类/机器步骤拆分与技术词清理（纯函数 + 单测）；
2. Excel 双层 sheet 与 MD 折叠执行器层；
3. API 参数、状态写回、补说明复用路径；
4. `design_to_test` 透传 `screens` + md 图片校验；
5. 文档/README/DESIGN 更新，全量测试。

## 11. 设计取舍（本设计的默认决定）

- 机器信息放在隐藏 sheet / 折叠 details，而不是删除：满足测试人员阅读，同时保留 agent 可靠性；
- API spec 不解析为强 schema：先确保“有说明、可追溯”，避免把 OpenAPI 兼容性做成新的未完成承诺；
- 后续补说明走 `reuseExistingTests`，避免重复生成导致 caseId 漂移。

## 12. Builder-check 后的补充决议

以下为设计评审后补充的默认决定，避免实施时靠猜。

### 12.1 数据模型与 ID 稳定

- `GeneratedTest.steps` **保持技术步骤不变**（现有 caseId 的哈希依据不动，避免 baselines/quarantine/flake/历史关联全部漂移）；
- 新增可选 `humanSteps: string[]`，只用于 Excel/Markdown 人类层；
- 新增可选 `displayName` / `displayScreens`，只用于人类层；`name` / `screens` 保持机器语义；
- `taskDesc` 不改变（仍供 `mobile_run_task` 使用，capability 回填不受影响）。

### 12.2 执行器层放什么

- Excel 隐藏 sheet「执行器」列：`用例编号(caseId) / displayId / artemis 任务描述 / 设计引用 / 屏幕节点或标识`；
- Markdown `<details>` 内放 `taskDesc` 与 `设计引用`（screen(nodeId)）；a11y/i18n 已在 taskDesc 的机器步骤中；
- 不为了 nodeId 修改 `taskDesc`，避免破坏 `mobile_run_task` 契约。

### 12.3 Excel 主表与导入契约

- 主表保留 `用例编号 / 模块 / Section / 关联用例` 等既有可读列；
- 仅把 `artemis 任务描述` 与 `设计引用` 移到隐藏 sheet；
- 不删除 `run_regression` Excel 导入依赖的列，保持 generate → edit → import 回环；
- 自定义模板仍按占位符渲染；模板作者可自行决定布局，文档提示模板可能含技术信息。

### 12.4 屏幕显示名

- CJK 名称、普通英文单词/短语（Home、Checkout）视为可读；
- 仅当名称整体是图层技术名（`Frame 2444`、`Component Set`、`Group 12`、`Vector`、`Icons/...` 等）或仅含代码标识时回退「未命名页面」；
- 多个屏幕回退同名时按出现顺序追加 `(2)`、`(3)`，避免人类层无法区分；
- 技术原值保留在 `screens` / 设计引用，不影响截图映射。

### 12.5 API 说明的后续补充

- `reuseExistingFlows + reuseExistingTests + apiChange/apiSpec` 走 **原位更新**：
  - 只更新 `tests.json.apiReview`、`api-review.md`、现有 `tests.md` 顶部 API 区块、现有 `tests.xlsx` 的「API 说明」sheet；
  - 不重新提取 flows、不重新生成用例、不改变 caseId；
  - 保留自定义 Excel 模板与已有设计图；
  - case-set 归档不更新（API 说明是文档元数据，不进入执行门禁）。
- 若旧产物没有可识别的 tests.md/tests.xlsx，只写 tests.json + api-review.md，并在响应 `updatedArtifacts` 说明缺失项。
- `apiSpecPath` 不可读 → 用法错误，不静默降级。
- `save:false` 时不写任何文件，响应只返回 `apiReview`。

### 12.6 API 状态生命周期（已由 §13.7 定稿：方案 A）

正常重新生成时，如果之前已有 `provided` 的 API 说明：

- **方案 A（建议）**：沿用上次说明并标记 `carriedForward:true`，同时在文档/响应提示“请复核是否仍适用”；
- **方案 B**：重置为 `unknown`/`pending`，要求重新提供；旧 `api-review.md` 保留但不引用。

`apiChange:"none"` 明确覆盖为 `not-applicable`；`apiSpec` 不带 `apiChange` 视为 `new`。

### 12.7 截图关闭/失败

- `design_to_test` 默认 `screens:true`，显式覆盖 `AOS_SCREENS=0`；`screens:false` 时写 `screens-disabled` warning；
- 环境变量关闭也要写 warning（不再静默）；
- 截图失败沿用 `screenshot-*` warning；MD 顶部显示可见原因；
- `saveArtifacts.markdown=false` 时 warning 仍写 tests.json 与响应。

### 12.8 响应形状

- 保留现有 `nextAction`（run 续跑）不变；
- 新增 `apiReview: { status, nextAction?: "provide-api-spec" | "confirm-api-change", ... }`，作为独立字段，不与 run 的 nextAction 混用。

## 13. 评审反馈修订（2026-10-23）

评审结论为“通过、小修后出计划”。以下修订吸收关键 1/2/3 与中等问题。

### 13.1 导入回环必须消费执行器层

- 隐藏「执行器」sheet 增加：`caseId`、`displayId`、`humanStepsHash`、`artemis 任务描述`、`设计引用`。
- `run_regression` Excel 导入读取隐藏 sheet，按 `caseId` 匹配：
  - 人类步骤哈希与 `humanStepsHash` 一致（测试人员未编辑）：直接采用隐藏 sheet 的 `taskDesc`，保留 `caseId`；
  - 哈希不一致（已编辑）：按现行规则从人类列重建 `taskDesc`，保留原 `caseId` 作为血统，并在导入结果 warning 中标注“步骤已编辑，执行描述按人类步骤重建”；
  - 无隐藏 sheet / 无匹配 caseId：维持现有导入合成逻辑。
- 新增生成→不改一字→导入→断言 `taskDesc`、前置、caseId 齐全的端到端测试；再补一条“编辑步骤后导入”测试，断言重建路径与 warning。
- 主表列名保持既有 14 列中可读的 12 列（`用例编号/模块/Section/关联用例` 保留），只把 `artemis 任务描述` 与 `设计引用` 移入隐藏 sheet；导入别名表同步覆盖“前置假设/测试数据/备注或待确认”等列名。

### 13.2 API 说明不再使用共享可变路径

- 取消项目级 `.artemis/design/api-review.md`；
- `apiSpec` **内联**到 `tests.json.apiReview.apiSpec`，上限 64 KiB；`apiSpecPath` 只作为输入，读取后内联；超出上限/路径穿越/不可读 → 用法错误；
- `apiReview` 随 `payload` 一起写入每个 case-set JSON（现有 `...payload` 复制链），因此每份归档自带当时的 API 说明；
- 补充说明时，按 case-set JSON 的 `savedTo.json === tests.json` 匹配并更新现有归档的 `apiReview`，不另建共享文件；
- Excel/Markdown 直接渲染内联说明；`apiReview.apiSpecSha256` 用于幂等更新与证据比对。

### 13.3 人类层降级会计

- `GeneratedTest` 增 `humanization: { elements, fallbacks, fallbackLabels, density }`；
- 人类层标签优先级钉死：
  1. 运行期可见文本（`textHints`）；
  2. 去掉通用词后的可读图层名（剥离开头 `Icons/Icon/Image/Frame/Group/Component/Vector/Rectangle/Ellipse/Layer/App`、结尾 `Button/Btn/Text/Label/Input/Field/View/Container/Icon/Image`，剩余有意义的词 + 控件类型）；
  3. 控件类型通用名（按钮/输入框/列表项/图片/开关/标签页/弹层/可点击区域）。
- 明确边界：`App Button` →（无有意义词）→“按钮”；`Submit Order Button` → “Submit Order 按钮”；`Icons/search` → “搜索图标”或“图标”；不保留整个技术图层名。
- 单用例回退密度 > 20% 或回退元素 ≥3 时，自动写入“备注或待确认”列；汇总/响应同时给出回退计数与密度。

### 13.4 manifest 冻结 API 状态

- `RunManifest` 顶层增 `apiReview` 快照：`change/status/specSha256/designFingerprint`；
- 跑批时若 API 说明仍 `pending`，历史批次清单可追溯“这轮执行时说明缺失”；
- 面板批次详情可只读展示该状态，不影响执行门禁。

### 13.5 截图嵌入计数校验

- 以 `caseScreens.summary`/`caseRefs` 计算映射到的屏幕引用总数与实际 MD `<img>` 数，二者不一致即写 `screenshot-embed-mismatch` warning；
- 不再以“至少一个 `<img>`”作为通过条件；部分丢失同样可见；
- 截图失败/关闭沿用 `screenshot-*` / `screens-disabled`。

### 13.6 `screens` 参数边界

- `design_to_test.screens` 只控制 tests.md/xlsx 的截图嵌入与 tests 截图采集，**不影响** vision 识别、flows/flow-map 的截图路径；
- 默认 `true` 并显式覆盖 `AOS_SCREENS=0`；显式 `false` 或环境变量关闭都写 warning；
- 加一条测试：`screens:false` 时 vision 调用计数不变、仅有嵌入关闭 warning。

### 13.7 API 生命周期（采纳方案 A）

- 正常重新生成且未显式给 `apiChange`：沿用上次 `apiReview`，写 `carriedForward:true` 到 `tests.json`、MD/Excel 顶部与响应，提示“请复核是否仍适用”；
- 生成时记录 `designFingerprint`（flows 源指纹）；新生成指纹与旧 `apiReview.designFingerprint` 不一致时，carriedForward 升级为醒目 warning `apiReview-design-changed`；
- `apiChange:"none"` 明确覆盖为 `not-applicable`；`apiSpec` 不带 `apiChange` 视为 `new`；
- 不删除旧 spec 内容，避免证据丢失。

### 13.8 低优先备注

- `<details>` 打印/PDF 展开行为由渲染器决定，文档知悉；
- “测试数据”列来源继续沿用现有 `testDataByScreen`/acceptance data，不在本设计扩展；
- CMS 用例包当前固定人列；若未来需要执行器 sheet，复用本设计的隐藏 sheet 列契约。
