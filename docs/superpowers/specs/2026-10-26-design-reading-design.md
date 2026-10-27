# 设计稿分块阅读（design_reading）设计

> 日期：2026-10-26
> 状态：设计稿，待确认后进入实现计划
> 关联：`figma_extract_flows` / `pen_extract_flows` / `design_to_test` / `suite ui-parity` / DESIGN §13.227

## 1. 为什么做

近期 iOS 设计核对暴露出两类问题：

1. **逐屏理解不完整**：页面一多，模型容易把每屏当独立静态图，忽略左侧分类与右侧列表联动、sticky header、搜索入口、底部 tab 等跨元素关系。
2. **连接线/标注容易被忽略**：设计图上的细线、箭头、旁注在整图缩放后变成低显著信息；模型会把文字标注当成事实，又会漏掉明显可见的控件（如灰色圆形放大镜搜索按钮）。

结果不是“少测了几个控件”，而是**CR 主线没有建立**：不知道这次改版真正围绕什么，也不知道哪些页面和交互属于同一条体验链。逐屏报告再细，仍然是平均用力的页面清单。

本设计增加一层**设计稿阅读**：按相邻画板分块读取，每块只记录可证据化的事实与带依据的初步印象，最后合并成完整交互链、CR 主线假设和待确认问题。

## 2. 目标与非目标

### 目标

- 页面很多时也能逐块读完，不因上下文超限或整图缩放丢失细节。
- 每块保留原始分辨率；对 header、底部导航、侧栏、连接线/标注做局部裁剪。
- 输出明确区分：**观察（observed）/ 推断（inferred）/ 待确认（unconfirmed）**。
- 合并后得到：屏幕清单、控件清单、交互边、跨段连接、CR 主线假设、完整性问题、问询清单。
- 推断不得自动升级为硬断言；不能被生成器当成设计事实。
- 所有结论可回溯到屏幕、坐标/裁剪图、原图或已有原型边。
- **不新增用户命令**：阅读是 `design_to_test` 的内部阶段；用户仍然只跑一个入口。

### 非目标

- 不替代 Figma 原型/REST 的确定性交互提取；已有明确原型边优先。
- 不做应用运行时验证；实现 vs 设计对比属于下一阶段（`suite ui-parity`）。
- 不自动回答设计问题；问题必须留给 owner 确认。
- 不默认对全部页面调用视觉模型；需要显式开关/预算。
- MVP 只读主屏；pen 的合并状态变体（`screens[].states`）先不进入分块/计数，`states` 字段保留为空数组。变体阅读作为后续扩展（变体 id 不得混入主屏会计）。

## 3. 与现有链路的关系

现有链路：

- `figma_extract_flows` / `pen_extract_flows`：产出 `flows.json`，含 screens、edges、screenshots、vision 元素（每屏一次）。
- `src/design/vision.ts`：单屏元素识别（`buildVisionMessages` / `runVisionPass`），输出 `vision-inferred` 元素与未决边。
- `src/design/screens.ts`：截图资产（PNG、幂等、相对路径）。
- `figma_generate_tests` / `design_to_test`：消费 flows 生成用例。

新增一个**内部阶段** `design_reading`，不新增用户命令；由 `design_to_test` 在提取 flows 之后自动执行（屏幕多时触发，可关闭）：

```
用户: design_to_test(figmaUrl/penPath)
        │
        ▼
figma/pen extract flows + screens/*.png
        │
        ▼
design_reading（分块视觉阅读，内部阶段）
  chunks/*.json  ← 段内观察 + 推断 + 问题
        │
        ▼
reading.json / reading.md  ← 合并交互链 + CR 主线 + 完整性
        │
        ▼
figma_generate_tests → suite check → 可选 run
```

`figma_extract_flows` / `pen_extract_flows` 仍可单独调用；它们不默认跑阅读，避免高级用户/脚本被额外视觉成本影响。用户面的“一条命令走完”就是 `design_to_test`。

已有 Figma 原型边作为 `observed`/`explicit` 输入传入；静态 fallback 边仍保留原 provenance，阅读层不得覆盖。

pen 已有的 `screens[].elements`（单屏 vision）作为 `knownElements` 上下文传入，不要求阅读层重新发现同一批控件；阅读层新增的关系/控件与已有元素冲突时保留两份并生成 question。控制清单仍由阅读层独立输出（不能因为已有元素就跳过 header 清单）。

## 4. 入口与载体（不新增命令）

### 4.1 唯一用户入口：`design_to_test`

不新增 `design_read` MCP 工具，也不新增 `suite design-read` CLI。阅读是 `design_to_test` 的内部阶段：

```
design_to_test(figmaUrl|penPath, reading:"auto")
  → 前置自检
  → 提取 flows + 截图
  → 分块阅读（自动，屏幕多时）
  → 生成 tests
  → suite check
  → 可选 run
```

`design_to_test` 只新增三个可选参数，都有默认值，普通用户不用记：

| 参数 | 默认 | 说明 |
|---|---|---|
| `reading` | `"auto"` | `auto`：屏幕数 ≥ 6 且视觉可用时自动读；`true`：强制读；`false`：关闭 |
| `readingMaxScreens` | `50` | 阅读上限；超出显式截断并 warning |

- 屏幕数 < 6 时 `auto` 跳过阅读（成本收益低），仍可 `reading:true` 强制。
- `reuseExistingFlows:true` 时，若已有截图/`reading.json` 且指纹匹配，直接复用阅读结果；否则对已有截图补读。
- 阅读失败/视觉不可用：warning + 继续生成，不把整个 `design_to_test` 判失败；响应明确写“阅读已跳过/部分失败”。
- 阅读产物和问题摘要并入 `design_to_test` 的响应步骤，不要求用户再调用一个工具查看。
- `reading:false` 是逃生口；CI/脚本不受影响。

### 4.2 内部模块

- 新模块：`src/design/reading/`（types/chunk/prompt/parse/merge/store）。
- `design_to_test`（`src/workflow/design-to-test.ts`）在提取成功后调用 `runDesignReading()`；不在 `figma_extract_flows` / `pen_extract_flows` 内默认触发。
- `figma_generate_tests` 只在 `reading.json` 存在且指纹匹配时消费；缺失时沿用现有 flows，不报错。
- 不新增 MCP 工具注册、不新增 CLI 命令；高级调试直接看 `.artemis/design/reading/` 产物。

## 5. 分块策略

1. **顺序**：优先 `flows.json.screens` 顺序；Figma 画布/页面顺序、pen 画板排布保持一致。无法确定时记录 `orderSource: "flows"|"canvas"|"unknown"`，不猜。
2. **切块**：`[1..3]`、`[3..5]`、`[5..7]`……（`chunkSize=3`, `overlap=1`（内部默认，不要求用户配置））。最后一块不足 2 屏时并入前一块。
3. **块上下文**：
   - 块内屏幕 ID/名称/顺序；
   - 前后边界屏名称（不传图，只给上下文）；
   - 块内已有原型边（明确的 from/to/trigger）；
   - 入口屏/核心屏标记（沿用 flows entryScreens）。
4. **图片**：
   - 每屏只发**原图**（不整体缩小），一次消息最多 3 屏；连接线/标注在原图里按原始分辨率保留。
   - 不做固定“顶部 20%/底部 15%”裁剪：现有 Figma/pen 可能把 `Flow/Header`、状态栏、备注画在屏幕框内；让阅读层把这类区域记为 `chrome`，不得当应用 UI。
   - 局部 1:1 裁剪（header/底部/标注）作为第二阶段；MVP 先用原图 + 严格控件清单。
5. **多图失败降级**：
   - 首选一次消息带 3 屏原图；
   - 若 provider 拒绝多图/超限：直接降为 2 屏 → 1 屏 + 边界文字上下文；
   - **降级丢屏顺序固定为丢尾**（保留靠前屏；被丢屏写入 `droppedScreens`）；尾块降级后剩下的屏如果少于 2，必须先由前一块补读/邻块覆盖，否则该屏记 `unread`，不得算成功；
   - 缓存键使用**实际发送的 image 集**（降级后的屏集），不是原始 3 屏计划；降级结果不能按全量计划哈希复用；
   - 全部失败：该块标 `failed`，继续后续块，合并阶段显式报缺口；不伪造。
   - `chunkAccounting` 同时记录块数、模型调用数、`screensRead/screensTotal`、`droppedScreens`，避免把“2 次调用”误报成“2 块”或把漏读屏算成完整。

6. **预算与并发**：
   - `readingMaxScreens` 默认 50，硬上限 200；超过 50 需显式传更大值。
   - 块并发默认 2（`AOS_READING_CONCURRENCY`，1–4）；单次 ChatFn 超时默认 180s（`AOS_READING_TIMEOUT_MS`，10s–600s）。
   - 预计块数 > 20 时，`design_to_test` 响应先给 warning（`reading-budget-large`）并继续；不静默把 200 屏拖成几十分钟。
   - 所有模型调用（含 spine 文本总结）计入 `stats.calls`，响应/`reading.json` 可见。

## 6. 段内记录契约

每块输出一个严格 JSON（解析后校验；不合法条目丢弃并记 warning）。

```json
{
  "chunkId": "chunk-001",
  "screenIds": ["s1", "s2", "s3"],
  "screens": [
    {
      "screenId": "s1",
      "name": "行動預點",
      "observed": {
        "title": "推薦",
        "headerControls": [
          { "kind": "search", "label": null, "bbox": { "x": 0.86, "y": 0.06, "width": 0.1, "height": 0.05 }, "confidence": 0.98 }
        ],
        "persistentNav": {
          "sideNav": ["飲料", "咖啡飲品", "茶瓦納"],
          "bottomTabs": ["首頁", "星禮程", "隨行卡", "行動預點", "咖啡故事"],
          "activeTab": "行動預點"
        },
        "contentGroups": [
          { "label": "推薦", "items": ["冰蘋果山茶花風味美式"] }
        ],
        "floatingActions": [
          { "kind": "cart-entry", "label": "購物袋", "bbox": { "x": 0.72, "y": 0.82, "width": 0.18, "height": 0.1 } }
        ],
        "annotations": [
          { "text": "產品搜尋", "source": "annotation-line", "target": "unknown", "bbox": { "x": 0.6, "y": 0.25, "width": 0.2, "height": 0.05 } }
        ]
      },
      "states": [],
      "inferredInteractions": [
        {
          "element": "search",
          "action": "tap",
          "to": "product-search",
          "basis": "icon+position",
          "status": "inferred",
          "confidence": 0.9,
          "why": "顶部右侧灰色圆形放大镜；目标页未在块内出现"
        }
      ]
    }
  ],
  "crossScreenLinks": [
    {
      "fromScreenId": "s1",
      "fromElement": "產品搜尋",
      "toScreenId": null,
      "toLabel": "產品搜尋",
      "status": "unconfirmed",
      "basis": "annotation-line",
      "why": "标注线起点靠近首个商品 +，未与搜索按钮连线"
    }
  ],
  "questions": [
    {
      "id": "q-001",
      "screenId": "s1",
      "question": "「產品搜尋」标注线是从搜索按钮、商品行还是绿色 + 出发？",
      "why": "不同起点对应不同交互，会影响生成用例"
    }
  ]
}
```

### 必填与校验

- 每屏必须有 `observed.headerControls`、`observed.persistentNav`、`observed.contentGroups`、`observed.floatingActions`（**键必须存在；空数组合法**，表示“确实没有”）。
- 可见但无法命名的图标 → `kind:"other"` + bbox，**禁止省略**。
- bbox 缺失/非法时**保留控件但 bbox=null** + `reading-control-bbox-missing` warning（不因缺几何丢掉整个控件）；目标可按屏幕 id 或屏幕名解析。
- 顶栏右侧圆形放大镜 → 必须归为 `search`，不得因无文字跳过。
- `headerControls` 只放应用控件；`Flow/Header`、状态栏、备注等 chrome 不进入控件清单，parser 记 `chrome-suspect` warning（机械防线仅此一条，非穷尽）。
- `status` 只能是 `observed|inferred|unconfirmed`。
- `observed` 必须有可见证据（bbox/裁剪图/已有原型边）；`inferred` 必须有 `basis`；`unconfirmed` 必须生成 `questions`。
- 标注线单独进 `annotations`，不得覆盖控件清单；标注不能自动证明目标页。

### 6.1 与代码库 `Provenance` 的映射（防止推断冒充硬断言）

阅读层的 `status` 是**阅读记录状态**，不是生成器的 `Provenance`：

| 阅读记录 | 生成器映射 | 说明 |
|---|---|---|
| 已有 Figma 原型边 | `explicit` | 设计器明确画的交互，沿用现有高置信 |
| 阅读层 `observed` 控件 | `vision-inferred` | “按钮确实存在”是观察，但仍是视觉识别，不是原型断言 |
| 阅读层 `observed` 交互边 | `vision-inferred` | 只有线两端都可见才可记 observed；默认仍进探索 |
| 阅读层 `inferred` 交互边 | `vision-inferred` | 带 basis，只进探索 |
| `unconfirmed` | 不进入生成 | 只进 questions / 报告 |
| 人工确认后的边 | `human-confirmed` | `answers.json` 命中后；报告标 `observed` + `basis:"human-answer:<id>"`，仍不写回 flows/tests |

只有 Figma 原型边和人工确认可以进 `explicit`；**视觉阅读永远不会把一条边直接升级为硬断言**。

## 7. 合并契约

### 7.1 屏幕与控件

- 按 `screenId` 合并；重叠块重复屏幕保留字段更完整的一份。
- 冲突（同一控件不同 kind/bbox）不静默覆盖：保留两份，生成 question，标 `conflict`。
- 元素按 kind+label+bbox 去重。

### 7.2 交互边

- 去重键：`fromScreenId + fromElement + action + toScreenId/toLabel`。
- 优先级：`observed` > `inferred` > `unconfirmed`；同优先级不同目标 → 保留并生成 question。
- 已有 Figma 原型边作为 `observed` 种子；阅读层的推断不能覆盖它。
- `to` 未知保留 `null`，进入 `unresolvedEdges`，不猜下一个屏。
- **端点机械校验**：`toScreenId` 不在全局屏集 → 降级 `unconfirmed` + question；模型返回 plan 之外的 `screenId` → 丢弃 + warning。不能只靠模型自觉。
- **overlap 一致性**：同一屏被相邻块各读一次时，比较 `title/headerControls/persistentNav` 的归一化结果；分歧 → question + `completeness.overlapConflicts`，不静默取一份。

### 7.3 CR 主线假设

不是“自动判定 CR 重点”，而是**可复核的主线假设**。分两步：

1. **确定性候选（不调模型）**：
   - 输入：入口屏、最长可达路径、连接密度、屏幕标题/旁注、显式 `annotations`。
   - 计算：入口屏 → 最长路径；按连接密度排序核心屏；把 `observed` 边串成主候选链。
2. **MVP 不调用文本总结**：直接用候选链 + 屏幕名生成模板化 `summary`/`title`，不额外花一次 LLM；语义化“菜单改版”总结留第二阶段（届时需把调用计入 `stats.calls`）。

输出：

- `spine.title`、`spine.summary`、`spine.screenIds`
- `spine.edgeIds`（用了哪些边）
- `spine.statusSummary`：observed/inferred/unconfirmed 各几条
- `spine.confidence` + `spine.basis`（`entry+longest-path` / `density` / `annotations` / `model-summary`）
- `spine.status`：`inferred`；证据不足（无入口、无连接、屏数 < 3）→ `unconfirmed`
- **含非 observed 边时**，`reading.md` 与响应必须标注“主线含 N 条推断边”，不得让推断主线看起来像硬结论。
- 可选输入 `intent`（一句 CR 目标）只作为总结的上下文，不参与事实判定；不传也能工作。
- 可选 `baselineReadingPath` / 旧 flows 只用于“改动集中区域”提示，MVP 可不实现。

主线假设只用于阅读排序和评审提示，不进入硬断言/门禁。

### 7.4 完整性与问题

合并报告包含：

- `screens` / `observedScreens` / `screensRead` / `screensTotal` / `failedScreens` / `unreadScreens`
- `droppedScreens`（降级丢尾/截断导致的未读）
- `truncatedScreens`（`readingMaxScreens` 截断）
- `orphanScreens`（不在任何主线/边上的屏）
- `unresolvedEdges`
- `unconfirmedEdges`
- `overlapConflicts`
- `conflicts`
- `questionsTotal` / `questionsOmitted`（报告只展示前 20 条；全量留在 chunks）
- `questionsAnswered`（命中人工答案、已抑制的问题数）
- 每屏 `boardLabel` / `stateLabel`（画板/页面/状态标签，位置不限；Frame/Screen/Group N 等通用名不采用；不混入 App 标题）
- 每屏 `knownStates`（flows 中已知的状态变体标签；仅元数据；状态屏按 frame id 去重）
- 状态屏 `kind:"state"` + `parentScreenId`（`readingStates:true` 时进入分块；不进入 CR 主线）
- `questions`（按标注线/关键入口优先，最多 20 条）
- `coverage`：有 header 控件清单的屏数、有底部 tab 清单的屏数、有连接线记录的屏数。
- `chunkAccounting`：请求块 / 成功 / 失败 / 复用 / 调用；不静默截断。

## 8. 落盘产物

```
<project>/.artemis/design/reading/
  chunks/
    chunk-001.json
    chunk-001.md
    ...
  reading.json
  reading.md
```

MVP 不产出 crops（局部裁剪作为第二阶段）；`readingPaths` 不返回不存在的 `cropsDir`。每个 chunk 记录 `plannedScreenIds` 与 `screenIds`（实际读到），降级/失败时二者不同。

`reading.json` 顶层：

```json
{
  "schemaVersion": 1,
  "source": "figma|pen|flows",
  "flowsFingerprint": "...",
  "screensFingerprint": "...",
  "generatedAt": "...",
  "model": "...",
  "chunkSize": 3,
  "overlap": 1,
  "screens": [],
  "edges": [],
  "spine": {},
  "questions": [],
  "completeness": {},
  "warnings": []
}
```

内容哈希按**块**计算：**实际发送的屏幕 ID + 图片** sha256 集 + 块内 flows 子图指纹（该块屏幕及其边，canonical 键序）+ chunkSize/overlap + promptVersion + **解析后的 model ID**。若发生 3→2→1 降级，用降级后的实际 image 集计算/写缓存，绝不能用原始 3 屏计划哈希复用。未变则复用该 chunk；`reuse:false` 忽略已有缓存并重写同名 chunk（不删除历史文件）。顶层 `flowsFingerprint` 只作元数据/新鲜度提示，不参与块缓存键，避免改一屏导致 50 屏全部重跑。切换 active entry/模型会改变块哈希，旧模型结果不会被误用；屏名不进哈希，merge 时按当前 refs 重解析。

## 9. `design_to_test` 响应中的阅读回执

阅读阶段不是独立命令，合并进 `design_to_test` 的 `steps` 和顶层 `reading` 摘要：

```json
{
  "ok": true,
  "steps": [
    { "step": "extract", "screens": 12, "edges": 9 },
    { "step": "read", "chunks": 6, "observed": 9, "inferred": 4, "unconfirmed": 3, "ms": 4200 },
    { "step": "generate", "cases": 8 },
    { "step": "check", "ok": true }
  ],
  "reading": {
    "summary": "读到 12 屏，合并 9 条 observed、4 条 inferred、3 条 unconfirmed；CR 主线假设 1 条。",
    "spine": { "...": "..." },
    "questions": [
      {
        "id": "q-001",
        "screenId": "s1",
        "screenName": "行動預點",
        "element": "搜索按钮",
        "question": "点击搜索按钮后进入独立产品搜索页，还是当前页展开搜索框？",
        "why": "决定生成 tap→page 还是 tap→state",
        "options": ["独立產品搜尋页", "当前页搜索框"]
      }
    ],
    "artifacts": {
      "json": ".../reading.json",
      "markdown": ".../reading.md"
    }
  }
}
```

人工答案放 `.artemis/design/reading/answers.json`：按 `screenId/screenNameIncludes/elementIncludes/questionIncludes` 匹配问题或交互，命中后抑制问题；匹配先做 NFKC、常见繁转简、去标点/空白，并按内置同义词（搜尋/search、門市/store、取餐/pickup、底部弹层/bottom sheet 等）归一。`style` 可追加 `separators`/`stateKeywords`/`synonyms`。`resolution.toScreenId` 支持真实屏 id 或 `"self"`（页内切换/底部弹层），`dropInteraction` 可删除错误推断边，`screenTitle` 可修正标题栏。答案在合并期生效，不触发模型调用，也不写回 flows/tests。

普通用户只看 `steps`/`reading.summary`/`questions`；不需要记住额外命令。报告最多展示 20 条高优先级问题（标注线优先，其次 search/back/cart/tab/結帳/取餐等关键入口）；全量问题保留在 `chunks/*.json`，`completeness.questionsTotal/questionsOmitted` 给出计数。问题不是失败；没有问题也明确写 `questions: []`，不伪造“已确认”。

**回答闭环已在合并期实现**：`.artemis/design/reading/answers.json` 按 `screenId/screenNameIncludes/elementIncludes/questionIncludes` 匹配问题或交互；命中后抑制问题、可补目标屏/页内状态/底部弹层/标题栏或删除错误推断边。答案不触发模型调用，不写回 flows/tests；未回答的问题保持原状态，不伪造“已确认”。

## 10. 与生成/实现对照的接线

### MVP（本设计范围）

- `design_to_test`：提取 → **分块阅读** → 生成（沿用现有 flows）→ check。
- 阅读阶段**只产出报告与问题**，不改生成器、不改硬门禁；`reading.json` 落盘供人复核。
- 用户仍然只跑 `design_to_test` 一个入口；`reading:false` 可关闭。
- 这样先把“UI 到底长什么样、连接线是否成立”厘清；生成侧是否消费这些观察，留到第二步验证后再接。

### 第二步

- `figma_generate_tests` 读取 `reading.json`：
  - 原型边/人工确认边才是 `explicit`/`human-confirmed`；
  - `observed`/`inferred` 仍按 `vision-inferred` 进入探索；
  - `unconfirmed` 不生成；在响应中列问题。
- `design_to_test` 的 `reading:"auto"` 默认策略与 `answers.json` 合并期闭环均已生效。
- `suite ui-parity` 用 `reading.json` 的 observed 控件/屏幕清单与运行时 AX 对比，输出 missing/extra/role/position 差异；sticky/联动等行为需真机交互验证，不由静态图直接判定。

## 11. 失败与降级

| 情况 | 行为 |
|---|---|
| 无 `flows.json` | `needs-setup`，提示先 extract flows |
| 截图缺失 | 该屏 `failed`，继续其他块；报告缺口 |
| 视觉模型不可用（auto） | `reading` 关闭，返回 `vision-unavailable`，不阻断 flows |
| `reading:true` + 非视觉模型 | **拒绝发起带图请求**，返回 `reading.status:"skipped"` + `vision-required` warning；绝不把图交给纯文本模型编造观察 |
| 多图被拒 | 丢尾降为 2 图/单图；warning + `droppedScreens` |
| 单块超时/400/402 | 该块 failed，继续其他块；不无限重试；报告显式缺口 |
| JSON 不合法 | 丢弃不合法条目 + warning；不静默补全 |
| 连接线起点不明 | `unconfirmed` + question |
| 目标屏不在全局屏集 | 降级 `unconfirmed` + question；plan 外屏丢弃 + warning |
| 块失败 | 计入 `chunkAccounting.failed`；合并仍产出部分结果 |
| 预计块数 > 20 | warning `reading-budget-large`，继续；不静默拖成长任务 |
| 超过 `readingMaxScreens` | 显式截断并 warning，不假装读全 |

状态映射：`read` = 所有计划屏实际读到且无失败块；`partial` = 至少一块成功但有失败/漏读/截断；`skipped` = 0 块成功。`ok:true` 表示“报告可读/已落盘”，不等于“阅读完整”；完整性看 `completeness.screensRead/screensTotal`。`runDesignReading` 抛异常（写盘/JSON 读取）统一 catch → `status:"skipped"` + warning，不让 `design_to_test` 失败。

## 12. 测试

- 分块/重叠：7 屏 → `[1,2,3] [3,4,5] [5,6,7]`；6..10 屏表格化钉死（6→3 块、7→3、8→4、9→4、10→5）；最后不足 2 屏并入。
- 降级/缓存：3→2→1 丢尾、缓存键用实际 image 集、`screensRead/screensTotal` 不把漏读算完整。
- 控件清单：缺 `headerControls` 字段 → 校验失败；空数组合法；搜索按钮由 prompt 断言、parser 保留、旁注含“搜尋”但无 search → question。
- 连接线：起点不明 → `unconfirmed` + question；目标屏不在全局屏集 → 降级 + question；不得自动生成边。
- 合并：同屏冲突保留两份 + question；observed 不被 inferred 覆盖；overlap 不一致 → question。
- CR 主线：入口/最长路径可复现；`edgeIds/statusSummary` 存在；含推断边时 markdown 标注；证据不足时 `unconfirmed`。
- 视觉守卫：`reading:true` + 非视觉模型 → 不发请求、不产生 observed。
- 模型/缓存：active entry 变化使块哈希失效；`reuse:false` 忽略缓存。
- 失败/状态：全失败 → `skipped`；部分失败 → `partial`；写盘异常 → skipped + warning；块失败不阻断其他块。
- 缓存：相同指纹复用；图片/参数变化重跑。
- 只读：不写 flows/tests；只写 `.artemis/design/reading/`。
- 集成：临时项目 + fake `ChatFn`，7 屏，断言 reading.json/reading.md、问题、会计。
- 全量 `npm run build && npm test && npm run lint`。

## 13. 实施拆分（MVP）

1. **schema + chunker + store**：`src/design/reading/`（types/chunk/store），单测。
2. **prompt + parser + validator**：严格 JSON、控件清单、observed/inferred/unconfirmed、问题。
3. **run pass + merge**：多图调用、降级、合并、CR 主线、完整性；输出 `reading.json`/`reading.md`。
4. **接进 `design_to_test`**：提取成功后调用；`reading`/`readingMaxScreens` 参数；响应 `steps` + `reading` 摘要；失败不阻断。
5. **报告回执**：`reading.md`、响应 summary、questions、warnings；生成链路保持现状。
6. **测试与全量验证**：fake ChatFn、分块/合并/降级/缓存/只读/问题；`npm run build && npm test && npm run lint`。

不新增 MCP 工具、不新增 CLI 命令。

## 14. 我的默认决策（可被覆盖）

- 入口：**不新增命令/工具**；阅读是 `design_to_test` 的内部阶段，默认 `reading:"auto"`（屏幕数 ≥ 6 且视觉可用时触发），`reading:false` 可关闭。
- `reading:true` + 非视觉模型：拒绝发图，返回 skipped + `vision-required` warning。
- 分块：3 屏 + 1 屏重叠；每屏原图；多图失败丢尾降级；缓存键用实际发送 image 集。
- 预算：`readingMaxScreens` 默认 50；并发 2；单调用默认 180s（`AOS_READING_TIMEOUT_MS`）；预计块数 > 20 warning。
- 状态：`observed` 只表示“可见事实/已有原型边”；视觉阅读产生的交互边一律映射 `vision-inferred`，不自动成为硬断言；只有原型边/人工确认才是 `explicit`/`human-confirmed`。
- chrome：不进入 `headerControls`；parser 对 `Flow/Header`/状态栏/备注出 `chrome-suspect` warning。
- 变体：默认只读主屏；`readingStates:true` 时把 `states` 的唯一 frame（按 id 去重，不按 label 合并）作为独立屏纳入分块（`kind:"state"` + `parentScreenId`，报告标「状态变体」/「父屏」），状态屏不进入 CR 主线；另对独立 screen 名（如 `Login / Empty`）按状态词后缀启发式归并。无状态输入时 warning `reading-states-unavailable`。未开启时仍把唯一标签作为 `knownStates` 元数据展示。
- 命名风格：状态拆分支持 `- / ｜ _ · （） []` 等多分隔符与中英日韩状态词；拆不出时保留完整 `boardLabel`，`stateLabel=null`；通用设计器名不作为标签。
- 已有 `screens[].elements`：作为 `knownElements` 上下文，按块过滤，不要求重找；冲突保留两份 + question。
- 主线：确定性候选 + 一次可选文本总结；输出 `edgeIds/statusSummary`，含推断边必须标注；只叫“假设”。画板顺序边标 `canvas-order`，报告显式提示不代表真实控件跳转。
- 回答闭环：合并期读取 `.artemis/design/reading/answers.json`，抑制已回答问题并修正边/标题；不触发模型调用，不写回 flows/tests。
- 生成接线：MVP 阅读报告只读，不改生成器/门禁；第二步再保守增强。
- 缓存：块级哈希（实际图片集 + 块内 flows 子图 + 参数 + promptVersion + 解析后的 model ID）；改一屏不会让全部块重跑。
- 旧产物：没有 `reading.json` 时现有流程完全不变。

## 15. 默认范围（已按“一个命令”要求收敛）

1. `design_to_test` 内部自动阅读：屏幕数 ≥ 6 且视觉可用时触发；`reading:false` 关闭。**不要求用户额外跑一步。**
2. 回答闭环：`.artemis/design/reading/answers.json` 在合并期生效（已实现）。
3. `suite ui-parity` 实现对照第二阶段：MVP 先做设计侧阅读报告，不改生成器。

无阻塞项；以上为默认，若要把某一项提前到 MVP 再改。
