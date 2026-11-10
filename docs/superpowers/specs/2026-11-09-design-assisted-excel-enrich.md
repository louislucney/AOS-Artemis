# Design：Design-assisted Excel enrich（Excel 反推设计上下文）

> 状态：**待 review（rev 3）**（本文只定范围、数据结构、验收标准；不写实现）
>
> 日期：2026-11-09
>
> 修订：rev 2 吸收评审反馈——①结构拓扑匹配（步骤动作文本 → 设计元素/边）升为 P0 必选，不再以屏名匹配为主；②LLM 改为按 module/label 聚类批量调用，并增加调用/Token 预算参数（当前不挡闭环，默认仅限制调用次数）；③Android 验收改为“执行稳定性提升”而非 UI diff 5 次一致；④新增人工确认持久化 `enrich-overrides.json` 与逐屏指纹增量复用；⑤P0 spike 增加 20 条真实存量用例的脏数据压力测试与自动匹配率门槛。
>
> 修订 rev 21（2026-11-09）：Web/LLM 任务脚本可追溯——执行前把 Excel 生成的 `taskDesc` 落盘 `.artemis/web/jobs/<taskId>/case-plan.json`（含 caseId/name/module/taskDesc/expected/reference）。
>
> 修订 rev 20（2026-11-09）：设计提取后台 job 化——Figma/pen 提取返回 `202 + jobId`，面板轮询进度并显示已用时长；同项目同时只允许一个提取 job，完成/失败结果保留 30 分钟；避免长 HTTP 请求卡死。
>
> 修订 rev 19（2026-11-09）：Figma 范围提取落地——`figma_extract_flows` 传 nodeId/URL node-id 时改走 `/files/:key/nodes`，不再整文件下载；新增 `figma_list_frames`（`?depth=2`）页面/画板清单；面板 Figma 来源先选页面/画板再提取。剩余：后台 job/进度、跨页合并。
>
> 修订 rev 18（2026-11-09）：面板设计来源统一——Figma URL 与 `.pen` 文件视为等价适配器，均提取为同一 `flows.json` 后回到同一映射预览；面板支持「已有索引 / Figma / .pen / 无设计稿」选择，不再拆成两套流程。
>
> 修订 rev 17（2026-11-09）：面板导入前设计预检已接线——「导入用例库」先调用 `design-preview`，检测 Wireframe 与 flows/ui-contract，展示 exact/ambiguous/unmapped；有索引提供「设计增强导入 / 普通导入」，无索引提示先做设计提取；apply 走 `design-apply`，needs-info 不静默。
>
> 修订 rev 16（2026-11-09）：`suite report` 接入脚本断言——读取 iOS `test_summary.adherence` 或 Android `android-adherence.json`，新增「脚本断言」Excel 列（`断言 X/Y（未命中 N）· 探索 a/b`），并用于失败分类；任务报告同样读取 artifact；`suite evidence` 自动纳入该 artifact。
>
> 修订 rev 15（2026-11-09）：Android 脚本断言已落地——运行终态后从 `data_engine.db` 逐步 OCR 标签（OCR 为空回退 UI tree 文本）计算 `【AOS-EXPECT】` adherence（起始屏/断言命中/探索），写 `testSummary.adherence` 与 `android-adherence.json`；缺 OCR/UI tree 显式降级；新增 `--fail-on-unresolved` 可选门禁（iOS/Android 同口径，旧产物无 adherence 不阻断）。剩余：更底层的确定性执行层。
>
> 修订 rev 14（2026-11-09）：屏级 overrides 已落地——`overrides` 的 `rowNumber` 可省略，省略时按屏名应用到所有引用行；行级 override 仍优先；`saveOverrides` 持久化后后续预览/apply 直接复用（测试覆盖两行同屏 + 持久化复用）。
>
> 修订 rev 13（2026-11-09）：`ambiguous` 已落地——同名多 id（真实索引 526 个重名屏）或 near 前二分差 <0.1 记 `ambiguous`，`design:null`、候选全列出、不静默取第一个；apply 不写 ambiguous，需 overrides 人工确认或 `llmMapping:"auto"` 从封闭候选中选择；映射缓存升 v2（旧 v1 自动失效）。
>
> 修订 rev 12（2026-11-09）：设计索引独立审计已实现——新增只读工具 `design_index_audit`：索引完整性（条目/重复 id/重名/空 id/短名/nodes 类型过滤/textHints 与 elements 覆盖）、显式索引与 flows/ui-contract 交叉比对（id/名称重叠、只在索引/只在参考源）、可选 Excel Wireframe 覆盖率（exact/near/ambiguous/unmapped、未被引用屏）；默认落盘 `.artemis/design/enrich/index-audit.json`。剩余：Android 硬断言。
>
> 修订 rev 11（2026-11-09）：LLM 歧义映射已实现（可选，默认 off）——`llmMapping:"auto"` 只对 unmapped 且有候选的行逐行调用 active LLM，候选集封闭、低于阈值不采纳、`maxLlmCalls` 默认 20 限流；命中记 `matchedBy:"llm"` 并写回映射缓存，报告 `summary.llmMapped/llmCalls`。测试通过注入 `chat`，不依赖网络。
>
> 修订 rev 10（2026-11-09）：逐屏 delta 已实现——`mapping-cache.json` 按 `excelSha8 + rowHash + screen + 设计屏指纹` 复用未变屏，报告 `delta {reused,remapped,added,removed}`；设计只改某屏时只重算该屏关联行。
>
> 修订 rev 9（2026-11-09）：`needs-info` 已实现——预览的 Wireframe 无有效屏返回 `excel-wireframe-unresolved`；apply 的未开启 allowNear 的全 near/unmapped 返回 `excel-mapping-no-exact`，`requireAllMapped` 有 review 返回 `excel-mapping-review`，部分 exact 仍 apply 但附 `excel-mapping-partial`；均不猜测、不静默执行。
>
> 修订 rev 8（2026-11-09）：人工确认回流已实现——`overrides`（rowNumber+screen→screenId）优先于 exact/near/unmapped，`saveOverrides` 合并写 `enrich-overrides.json`，后续预览/apply 自动复用；apply 使用人工 nodeId。
>
> 修订 rev 7（2026-11-09）：P1 apply 已实现——`apply:true` 生成新 enriched 用例集（`source=imported:...+design:<fingerprint>`，不覆盖普通导入/原 Excel）；exact 自动写 nodeId，`allowNear` 放开 near，`requireAllMapped` 拒绝 unmapped/review；原 Excel 字节不变。
>
> 修订 rev 6（2026-11-09）：P0 预览工具补结构候选——无 Wireframe 的行用步骤/预期文本匹配设计屏 textHints/elements，标 `review`；不自动接受。真实 GU Excel：23 matched / 3 review（含 TC_23、TC_31 结构候选）/ 5 unmapped / 2 no-wireframe。
>
> 修订 rev 5（2026-11-09）：P0 预览工具已落地——MCP `design_assisted_import` 读 Excel + flows/设计屏索引，按显式 Wireframe 做确定性映射，输出逐行 `matched/review/unmapped/no-wireframe` 与候选屏/id/score，报告落 `.artemis/design/enrich/`；只读，不写用例集、不改 Excel。剩余：apply/enriched case set、MCP `needs-info`、`enrich-overrides.json`、逐屏 `delta`、设计索引校验、LLM 歧义批量、Android 硬断言。
>
> 修订 rev 4（2026-11-09）：面板 `excel_mappings` 已加入 Section/Wireframe/Related TC，资产页可预览/保存模板映射，面板导入优先使用已保存映射；MCP `columns` 覆盖、`design.columns` 回显、URL/图片/Jira 值校验 warning 均已落地。剩余：MCP `needs-info`（未确认模板不猜）+ 设计索引校验。
>
> 修订 rev 3（2026-11-09）：拿到真实 Excel `GU Navigation Menu-Test Case.xlsx`（33 条、7 个 Section、26 个唯一 Wireframe 屏名）。**`Section` 与 `Wireframe` 升为一等输入**：`Section` 作为 case set 分组/feature key（`Module` 只作父级），`Wireframe` 直接作为 `designRefs`/`screens`，不再要求隐藏「执行器」sheet 手工填引用。P0 可先用显式 Wireframe 屏名做 deterministic 映射，不依赖全量 flows 提取；实测名称级 exact 22 / near 4 / missing 0，near-match 的消歧规则见 §6.2/§9.1。
>
> 关联：DESIGN §13.332（Excel 导入设计上下文检测）、§13.70/§13.93（验收口径/真实数据）、§13.218/§13.222（逐屏映射/UI 覆盖）、§13.317（Maestro 移除）。

## 1. 问题

当前有两条独立链路：

```text
设计 → 用例：Figma/pen → flows.json → figma_generate_tests → tests.json/md/xlsx
Excel → 执行：importTestDocument → taskDesc → suite run / run_regression → LLM 执行
```

用户手里往往同时有 **Excel 测试文档** 和 **Figma/pen 设计稿**：

- Excel 提供人的测试意图（步骤、预期、前置、测试数据）；
- 设计提供屏幕/元素/文案/入口/验收口径。

但当前 Excel 导入只支持隐藏「执行器」sheet 里的手工 `designRefs`，不会自动读取 `flows.json`/`ui-contract.json`；导入用例的 `screens` 只是 Excel 模块名，`expectations` 只用于来源/失败分类，不是可消费的设计断言。结果是“有设计稿也只能靠人填引用，或另跑 design_to_test”。

本文定义的能力：**以 Excel 行为单位，把已有设计上下文映射并注入到用例模型**，让 Excel 的步骤保留人的意图，设计补上屏/元素/入口/验收基线。

## 2. 目标与非目标

### 2.1 目标

- 输入 `excelPath` + 设计源（Figma/pen，或已有 `flows.json`），输出逐行映射报告。
- 保留 Excel 的 `caseId`、`displayId`、人类步骤、预期、测试数据；不覆盖原 Excel。
- 为匹配行注入：
  - `screens`（设计屏名，替代/补充 Excel 模块名）；
  - `designRefs`（screen id + node ids + route）；
  - `expectations`（设计运行期文本/AC hints，符合 `StepExpectation` 形状）；
  - `preflight`/`startScreen`（入口屏）；
  - taskDesc 的设计引用/设计期望段。
- 映射可解释：`matched | ambiguous | unmapped`，每条带 `matchedBy`、`confidence`、`reason`、候选。
- 默认 **preview**，不写盘；`apply` 也只生成新用例集，不修改原 Excel。
- 复用现有 `flows.json`/`GeneratedTest`/case-sets/UI contract，不新增第二套 schema。

### 2.2 非目标

- 不让 LLM 凭空生成设计里不存在的屏/元素/节点 id。
- 不自动改写 Excel 原步骤（“LLM 重写步骤”是模式 B，另立评审）。
- 不自动把 Excel 内嵌图片当设计源；图片/参考图仍只提醒（§13.332）。
- 本阶段不解决 Android 的确定性步骤断言（`【AOS-EXPECT】` 在 Android 提交前会被剔除，见 §6.4）。
- 不替代 `design_to_test`（设计→用例）；两者共享产物，不互相覆盖。

## 3. 现状与可复用代码

| 能力 | 现有代码 | 复用方式 |
|---|---|---|
| Figma flows | `figma_extract_flows`、`src/figma/flows.ts` | 读 `flows.json`，不重复调 Figma |
| pen flows | `pen_extract_flows`、`src/pen/flows.ts` | 同上；逐屏 `.pen` 供 UI diff |
| 设计资源单一读取 | `src/figma/design-store.ts`（`designDir`、`normalizeFlowGraph`、`readFlowDocumentMeta`、`toGeneratedCase`） | 唯一读取入口，避免 schema 漂移 |
| 设计→用例 | `src/figma/test-gen.ts`（`GeneratedTest`、`StepExpectation`、`CasePreflight`、`designRefs`） | 目标 case 形状 |
| Excel 导入 | `src/workflow/excel-import.ts`（`ImportedCase`、`expectations`、`screens`） | 输入 case 形状 |
| 用例集三件套 | `src/figma/case-sets.ts`、`src/figma/test-xlsx.ts` | 落盘/隐藏执行器 sheet |
| UI 契约/逐屏对比 | `src/ui/contract.ts`、`src/ui/auto-check.ts`、`suite ui-contract` | 执行侧设计证据 |
| 断言/探索分类 | `src/provenance.ts`、`src/figma/reconciliation.ts` | `assert/explore`、人工确认 |

**关键 schema 事实**：`GeneratedTest.expectations` 是 `StepExpectation[]`（`screen/hints/provenance/confidence/kind`）；Excel 导入目前产生的是 `{kind,text}`，能被 `summarizeScriptProvenance` 计数，但不会被 `toGeneratedCase` 当作 `hintScreens`/`exploreSteps` 消费。enrich 必须输出 `StepExpectation` 形状，不能继续用 `{kind,text}`。

## 4. 总体方案

### 4.1 模式 A（推荐先做）：enrich，不重写步骤

```text
Excel 行（原样）
  → 读设计 flows.json（缓存；必要时先提取）
  → 逐行映射到设计屏/元素（确定性优先，LLM 只处理歧义）
  → 生成 EnrichedCase：
      Excel 步骤/预期/前置/测试数据不变
      + designRefs + screens + expectations + preflight
      + taskDesc 增加设计引用/设计期望段
  → 预览 mapping report
  → apply 写新用例集（源标识 imported:...+design:...）
  → suite run / suite run --ui-diff
```

### 4.2 模式 B（后续，不在本文范围）：rewrite

让 LLM 用设计重写/扩写 Excel 步骤（例如 Excel 只写“验证 My SMILES 页面”，设计展开成逐区块步骤）。必须输出逐行 diff、人工确认、保留原 Excel；风险高，等 A 模式验证后再评审。

## 5. 数据模型

### 5.1 请求参数

```ts
interface DesignEnrichOptions {
  excelPath: string;
  design:
    | { kind: "figma"; url: string }
    | { kind: "pen"; path: string }
    | { kind: "flows"; flowsPath?: string; penPath?: string }; // 复用已有 flows
  mode: "preview" | "apply"; // 默认 preview
  mapping: {
    policy: "strict" | "review" | "allow-unmapped"; // 默认 review
    threshold: number; // auto 接受阈值，默认 0.8
    llm: "off" | "auto"; // 默认 auto；off 时歧义一律 ambiguous
    maxLlmCalls?: number; // 默认 20；超出后剩余 ambiguous 直接记 unmapped
    maxLlmTokens?: number | null; // 默认 null（不限）；P1 可配
    maxLlmCostCents?: number | null; // 默认 null（不限）；P1 可配
  };
  requireAllMapped?: boolean; // 默认 false；true 时存在 unmapped/ambiguous 拒绝 apply
  write?: { caseSet?: boolean; mappingReport?: boolean }; // apply 时默认 true
}
```

`policy` 语义（apply 时）：

- `strict`：只要存在 `ambiguous`/`unmapped` 就拒绝 apply。
- `review`（默认）：`ambiguous`/`unmapped` 必须先在 review 文件里人工确认（P1），未确认不得 apply；确认后按 `human` 映射注入。
- `allow-unmapped`：允许 apply；未匹配行保留 Excel 模块名，报告/响应显式标 `unmapped`，不伪造设计覆盖。

### 5.2 映射报告（始终返回；`apply` 时落盘）

```ts
interface EnrichMappingReport {
  schemaVersion: 1;
  source: {
    excel: string;
    excelSha8: string;
    flows: string | null;
    flowsFingerprint: string | null;
    designSource: "figma" | "pen" | "flows" | "none";
  };
  summary: {
    rows: number;
    matched: number;
    ambiguous: number;
    unmapped: number;
    designRefs: number;
  };
  rows: Array<{
    rowNumber: number;
    caseId: string;
    displayId: string | null;
    name: string;
    module: string;
    status: "matched" | "ambiguous" | "unmapped";
    design: {
      screenId: string;
      screenName: string;
      nodeIds: string[];
      route?: string;
      matchedBy: "exact" | "normalized" | "text-hint" | "llm" | "human";
      confidence: number;
      candidates?: Array<{ screenId: string; screenName: string; score: number }>;
    } | null;
    reason: string;
    warnings: string[];
  }>;
  warnings: string[];
}
```

### 5.3 EnrichedCase（在 `GeneratedTest` 形状上补设计字段）

保留 Excel 原字段：`id/name/displayId/module/section/steps/preconditions/testData/taskDesc`。

新增/覆盖：

```ts
interface EnrichedCase extends ImportedCase {
  screens: string[];              // 设计屏名；未匹配回退 [module]
  designRefs?: { screens: string[]; nodeIds: string[]; route?: string };
  expectations: StepExpectation[]; // 设计 hints / AC；与 Excel 预期合并，不降级 assert
  startScreen?: string;
  preflight?: CasePreflight;
  designProvenance?: {
    screenId: string;
    screenName: string;
    matchedBy: string;
    confidence: number;
    flowsFingerprint: string;
  };
}
```

### 5.4 合并规则（必须固定，避免“设计覆盖人”）

1. **caseId/displayId 不变**：来自 Excel 隐藏执行器 sheet 或 `imp-<sha8>-<row>`；enrich 不重新生成。
2. **Excel 步骤/预期/前置/测试数据不删**：设计只追加 `hints`/`designRefs`/`preflight`。
3. **expectations 合并**：
   - Excel `expected` 非空 → `{kind:"assert", text}` 保留；
   - 设计 runtime-text → 追加到对应步的 `hints`，`hintsSource:"runtime-text"`；
   - 设计 AC → 追加 `hintsSource:"acceptance"`；
   - 同一步去重（空白归一化后完全相同只留一条）；不把 `assert` 降成 `explore`。
4. **screens**：匹配到设计屏 → `[screenName]`；未匹配 → 保留 `[module]` 并记 `unmapped`。
5. **taskDesc**（仅 matched 行追加）：
   - `【设计引用】screens=… nodeIds=…`；
   - `【设计期望】…`（文本 hints，Android LLM 也能看到）；
   - `【AOS-EXPECT】{...}`（仅 iOS 执行器消费；Android 提交前会剔除，见 §6.4）；
   - 不删除原 `用例/步骤/预期/前置/测试数据` 段。
6. **unmapped/ambiguous 行**：默认不改 taskDesc；在报告/响应给警告；`allow-unmapped` 显式允许执行，`strict` 拒绝 apply。

### 5.5 Excel 模板的一等字段（rev 3，真实文件驱动）

真实模板 `GU Navigation Menu-Test Case.xlsx` 的列：`TC / Modules / Section / Test Case / Precondition / Test Data / Related TC / Test Step / Expected Result / Wireframe / AOS Result / IOS Result / Jira / Remarks`。

- **Section**：同一 `Modules` 下的子功能（`Login`、`Register (Smiles card)`、`Register (Student/Military)`、`Register (MOGI)` 等）。**case set 的 feature/group 用 Section；Module 只作 parent**。否则 33 条里 32 条会挤进一个 `Login / Register` 大集。
- **Wireframe**：换行分隔的设计屏名；少数单元格有 `)0.` 粘连（如 `... (Student/ Military)0.2.1_OTP - Case 1`），解析时先按 `)0.` 拆行。**直接作为 `designRefs.screens` 与 `screens`**；不需要隐藏「执行器」sheet。
- **Related TC**：映射 `relatedCases`（同产物内 displayId）；只读展示，不参与匹配。
- **AOS/IOS/Jira/Remarks**：结果列，不参与生成/映射；保留只读，不覆盖。
- **回退规则**：没有 Section 的旧 Excel 仍按 Module 分组；没有 Wireframe 的行保留 Module 作为屏名并记 `design-refs-missing`，不静默。

### 5.6 模板差异与映射确认（不能靠列名猜语义）

每个团队的 Excel 模板不同，列名也不稳定；**自动识别只是默认别名，不是契约**。必须分三层：

1. **自动识别（便利层）**：`Section/sections/子功能`、`Wireframe/设计引用/designrefs`、`Related TC/关联用例` 等别名；识别不到就不使用该字段，不报错。
2. **显式覆盖（MCP/CLI）**：`columns: { section: "实际表头", wireframe: "...", relatedTc: "..." }`；模板不标准时由调用方指定。
3. **模板级确认（面板/配置）**：复用现有 Excel 列映射（`excel_mappings`，按 header fingerprint 保存），把 Section/Wireframe/Related TC 加入可映射字段；上传时预览表头 + 前 N 行样本，用户确认后保存 profile，后续同模板自动复用。未确认的非标准模板返回 `needs-info`，不猜。

**值校验（即使列名对，值也可能不对）**：

- Wireframe 值像 URL / 文件路径 / 图片名（`.png/.jpg/.pen/.fig/.pdf`）→ 不写入 `designRefs`，warning `wireframe-not-screen-name`。
- Related TC 值像 Jira 单号（`AOS-123`）→ 不写入 `relatedCases`，warning `related-tc-looks-like-jira`；保留原始文本供人工判断。
- Section 值全为空或与 Module 完全相同 → 记 `section-column-redundant`，回退 Module 分组（不产生大量单行集）。
- Wireframe 列存在但 0 个有效屏名 → 记 `wireframe-unresolved`，不伪造 designRefs。
- 有设计基线但无 Wireframe 列 → 记 `design-refs-missing`，不自动按模块名硬匹配。

**当前实现状态（2026-11-09，rev 4）**：

- MCP `run_regression.columns` 支持 Section/Wireframe/Related TC；导入响应 `design.columns` 回显实际映射；Wireframe URL/图片/路径与 Related TC Jira 单号的值校验 warning 已加。
- 面板 `excel_mappings` 的 canonical 字段已加入 Section/Wireframe/Related TC；资产页预览/保存会显示这三列；**面板资产导入优先使用该资产最新已保存映射**；该资产无映射时，按“工作表名相同 + 映射里的每个表头都能在新资产表头中找到”复用同项目旧资产的映射（同一模板的新文件）；仍不匹配才回退自动识别。
- 仍缺：MCP 在“自动识别到但值可疑/多候选”时返回 `needs-info`（当前是 warning + 回退）；Wireframe 与 `flows.json`/`ui-contract.json` 的设计索引校验（当前只做值形状校验，无法证明屏名真实存在）。

## 6. 映射算法

### 6.1 预处理

- 归一化：NFKC、大小写、空白、全半角、常见标点；中文/英文同义词表（如“登录/登入/Login”）。
- 数据源：Excel `模块`/`Section`/`用例名`/`步骤`/`预期`；设计 `screen.name`、`displayName`、`runtimeText`/`textHints`、`screen-map.json` 的 `code.component`。

### 6.2 确定性匹配（P0；显式 Wireframe > 结构拓扑 > 屏名）

**0. 显式 Wireframe（最强输入，优先于一切推断）**：Excel 若带 `Wireframe`/`设计引用` 列，先按换行（及 `)0.` 粘连）拆出设计屏名，逐个与设计屏索引做归一化 exact / token overlap。命中即 `matchedBy:"excel-wireframe"`；多候选/unmatched 记 `ambiguous`/`unmapped`，不因为“看起来像”就自动接受。Excel 屏名可能过期/拼错，必须回指设计真实 id。

**结构拓扑匹配（P0 必选，先于屏名）**：国内 Excel 的模块名常是“订单中心/用户管理”，设计屏名却可能是 `Order_List_V2`、`Frame 142`；不能把屏名当主要依据。

1. **步骤动作 → 设计边/元素**：
   - 从 Excel `步骤`/`预期` 抽取动作与目标文案：中文 `点击/选择/输入/勾选/验证/看到/进入`、英文 `tap/click/select/enter/verify`，以及引号/括号内的标签（如“点击【提交】”“验证『推荐码』”）。
   - 匹配 `flows.json` 的 `edges[].element.name`、`edges[].textHints`、`screens[].textHints`、`screens[].elements[].label/intent`（`src/figma/flows.ts:143` 起）。
   - 命中边 → 目标屏 = `edge.to`；命中屏内元素 → 该屏为候选；按“精确文案 > 包含 > 词元重叠”打分（0.8–1.0）。
   - 如果 Excel 步骤没有可抽取标签，才进入屏名匹配，不得跳过结构匹配直接猜屏。
2. **屏名 exact**：归一化后 `module/section === screen.name/displayName`，score 1.0。
3. **包含/词元**：一方包含另一方，或 token Jaccard ≥ 0.6，score 0.7–0.95。
4. **屏内文本**：Excel 预期/步骤文本命中设计 `runtimeText`/`textHints`，score 0.6–0.9。
5. **screen-map 别名**：`screen-map.json` 的 component/file/name 作为候选别名，只作辅助，不单独升权。
6. 多候选且分差 < 0.1 → `ambiguous`，不猜；结构匹配与屏名匹配冲突时，结构匹配优先并记 `conflict` 警告。

### 6.3 LLM 辅助（P1；聚类批量 + 预算）

只对 deterministic 阶段的 `ambiguous` 行调用，且**按簇批量**，不逐行调用：

- **聚类**：按归一化 `module/section` + 抽取出的动作/标签集合聚类；同簇最多 20 行打包一次调用，带该簇的全局候选屏列表（screenId/name/textHints/element labels）。
- **输入**：簇内各行 `name/steps/expected/module` + 封闭候选列表；不发送截图，只发文本。
- **输出**：JSON 数组 `[{rowId, screenId, confidence, reason}]`；`screenId` 必须在候选列表内，未知 id 丢弃并记 `llm-invalid-candidate`；缺行记 `llm-missing-row`，不猜。
- **阈值**：≥0.8 自动接受；0.5–0.8 记 `ambiguous` 等人工；<0.5 `unmapped`。
- **预算/熔断**：`maxLlmCalls` 默认 20；超出后剩余 ambiguous 直接 `unmapped` 并记 `llm-call-budget-exhausted`；`maxLlmTokens`/`maxLlmCostCents` 为可选上限（当前不设默认，P1 可配），超限同样停止。
- **缓存**：`hash(clusterRowTexts + candidateIds + flowsFingerprint + promptVersion + model)`；同簇不重复调用。
- LLM 不得生成新 screen name/node id；最终映射必须能回指 `flows.json` 的真实 id。

### 6.4 平台差异

- **iOS**：`【AOS-EXPECT】` 会被 AOS iOS 执行器解析并做逐步确定性核对；这是设计断言真正生效的路径。
- **Android**：`src/figma/case-runner.ts` 的 `stripIosExpectation` 会在提交前剔除 `【AOS-EXPECT】`；因此 Android 当前只能：
  - 把设计 hints 写进 `【设计期望】` 文本供 LLM 参考；
  - 用 `suite run --ui-diff` + `ui-contract.json` 做逐屏 UI 对比（pen 逐屏 `.pen`）；
  - 不能声称 Android 步骤断言是硬门禁。
- Figma 源：自动逐屏 UI diff 目前依赖 `design/pen/screens/<id>.pen`；Figma 需先转逐屏 `.pen`（`scripts/figma-to-pen.mjs` 或 pen.dev），否则 `unverified`，不伪造。

**Android 降级验收（不能拿 UI diff 当门禁）**：UI diff 受渲染、动画、字体抗锯齿影响，不是确定性信号；在 Android 缺少步骤硬断言前，enriched 用例只能算“增强建议”，不能进入回归门禁。验收改为对比 **enrich 前 vs enrich 后**同一批用例在同一设备的表现：

- 指标：通过率、失败域构成、人工干预次数、步骤偏差/重试次数（来自 trace/日志）；
- 通过标准：通过率不下降，且至少一个稳定性指标改善（例如人工干预次数下降、同一失败域不再反复出现）；
- UI diff 只作 report-only 证据，不参与 5 次一致性判定；若连续多批都没有改善，记录“Android enrich 无收益”并停止推广，而不是硬上。

## 7. 产物与幂等

- **不覆盖原 Excel**；`apply` 生成新用例集，`meta.source = imported:<base>@<excelSha8>+design:<flowsFingerprint>`。保留 `imported:` 前缀，使覆盖闸继续按导入集 `n/a` 处理；设计指纹进入幂等键，设计变更后是新产品，不覆盖旧集。
- 新 case set 仍落 `.artemis/design/case-sets/`，三件套（json/md/xlsx）；隐藏执行器 sheet 的 `humanStepsHash` 由人类步骤重算（enrich 不改人类步骤，因此可复用原 taskDesc 的幂等语义）。
- 映射报告落 `.artemis/design/enrich/<excelSha8>-<flowsFingerprint>.mapping.{json,md}`；`preview` 不写盘。
- **人工确认回流**：`.artemis/design/enrich/enrich-overrides.json` 持久化 review 确认（`excelSha8/featureKey/rowHash/module/screenId/screenName/source:"human"/confirmedBy/confirmedAt/flowsFingerprint`）。匹配优先级 **human > LLM > deterministic**；同一 Excel+设计再次运行直接复用，不再进 LLM/ambiguous。设计屏已删除/改名 → 标 `stale` 要求重确认，不静默套用。
- **设计变更增量**：映射缓存以 `rowHash + screenId + screenFingerprint` 为键（Figma 用 `FlowScreen.nodeHash`；pen 用逐屏文件 sha；缺失用屏内容哈希）。flows 全局指纹变化时只重算受影响屏关联行；报告 `delta {reused, remapped, added, removed}`，未变屏行复用旧映射。
- 幂等键：Excel sha + flows fingerprint + options（policy/threshold/llm/model）；同输入重复输出一致；LLM 结果缓存。
- `apply` 前必须已有 mapping report；`requireAllMapped`/`strict` 时存在 `ambiguous/unmapped` 直接拒绝。
- 失败回滚：三件套写入沿用现有 `saveCaseSetFiles`/`cleanupFiles` 语义；登记失败回滚。

## 8. 接口

### 8.1 MCP 工具（建议新增，不改现有语义）

`design_assisted_import`（名称待 review）或 `figma_enrich_excel` / `pen_enrich_excel`：

```ts
{
  excelPath: string;
  design: { figmaUrl?: string; penPath?: string; reuseExistingFlows?: boolean; flowsPath?: string };
  mode?: "preview" | "apply"; // 默认 preview
  mappingPolicy?: "strict" | "review" | "allow-unmapped"; // 默认 review
  mappingThreshold?: number; // 默认 0.8
  llmMapping?: "off" | "auto"; // 默认 off（显式开启才消耗 token）
  mappingBudget?: { maxCalls?: number; maxTokens?: number; maxCostCents?: number };
  requireAllMapped?: boolean;
}
```

响应：`mapping`（报告摘要）、`rows`（逐行状态）、`warnings`、`artifacts`（apply 时的三件套路径）、`nextAction`（`suite run --ui-diff` / `design_to_test` / 补设计引用）。

### 8.2 CLI（可选）

```text
suite excel enrich --excel <path> --design <figma-url|pen-path|flows-path>
  [--apply] [--policy strict|review|allow-unmapped] [--threshold 0.8]
  [--llm off|auto] [--json]
```

默认 preview；`--apply` 才写。`run_regression` 保持现状；enriched 用例集按普通 case set 被 `scope`/`all` 选中。

## 9. 验收标准

### 9.1 1 天 spike（P0；理想 + 脏数据）

- 已实现入口：MCP `design_assisted_import`（`excelPath` + `screenIndexPath`/`flowsPath`，`save:false` 可只看响应）；报告默认落 `.artemis/design/enrich/`。
- **3 条理想用例**（模块名与设计屏名一致）＋ **20 条以上真实存量 Excel 用例**（模块名业务化、屏名开发化/未命名）＋ 1 个 pen/Figma 设计稿（或已有 `flows.json`）。
- 只做 deterministic 映射（显式 Wireframe + 结构拓扑 + 屏名 + 文本）＋ preview；不调用 LLM、不写盘。
- 输出逐行 `matched/ambiguous/unmapped`、屏/节点、reason、候选；报告 `autoMatchRate`、`ambiguousRate`、`unmappedRate`。
- 人工抽检自动匹配的 20 条，记录 **precision**（自动匹配中正确的比例）和误配样本。
- **真实文件首轮（2026-11-09，`GU Navigation Menu-Test Case.xlsx`）**：33 条、7 个 Section、26 个唯一 Wireframe 屏名；当前 Figma depth=4 名称索引 exact 22 / near 4 / missing 0。该结果只证明“显式 Wireframe 列很强”，不等于最终 autoMatch；near-match 仍需消歧。
- **near-match 规则**：短名/单 token（如名为 `0` 的节点）不得作为匹配；`Forgot Password`、`Smiles MOGI` 这类差异需更深节点/别名或标 `stale`；先修匹配器，再统计 autoMatch。
- **通过标准**：
  - 3 条理想用例全部 matched；
  - 真实用例 **autoMatchRate ≥ 40%**（按唯一屏名/行均可，报告口径固定；低于 40% 停止进入 P1，先补匹配器或 overrides）；
  - 抽检 **precision ≥ 90%**（宁可少匹配，不可错匹配）；
  - 没有“静默匹配”；没有 invent 的 screen id；near-match 不得靠短名误命中。
- 40% 是 stop/go 的默认门槛，不是行业标准；本次真实文件已有 22/26 exact，重点从“提高覆盖率”转为“消歧和 precision”。

### 9.2 单元/集成测试（P1 apply）

- 归一化/同义词/包含/文本命中打分；
- 多候选分差 <0.1 → ambiguous；
- LLM 返回非候选 id → 拒绝；低置信 → ambiguous；缓存命中不重复调用；
- expectations 合并：assert 不降级、去重、`hintsSource` 正确；
- `designRefs`/`screens`/`preflight` 注入；
- caseId/displayId 稳定；原 Excel 字节不变；
- `apply` 幂等；重复 apply 不产生重复 case set；
- `strict`/`requireAllMapped` 拒绝 unmapped；`allow-unmapped` 明确披露；
- `toGeneratedCase` 能消费 enriched `expectations`（hintScreens/exploreSteps/provenance）；
- 现有 `npm test` 全绿、lint 0 error。

### 9.3 端到端（P2；iOS 与 Android 分开验收）

- **iOS**：enriched 用例的 `【AOS-EXPECT】` 进入硬断言路径；同一用例连续 5 次，PASS/FAIL 路径与失败域一致（不一致按 quarantine 规则隔离）。`suite run --ui-diff` 只作补充证据，不替代断言一致性。
- **Android**：不做“UI diff 5 次一致”的门禁——UI diff 受渲染/动画/抗锯齿影响，不是确定性信号。按 §6.4 的降级验收：enrich 前 vs 后同批用例的通过率、失败域、人工干预、步骤偏差；通过率不降且至少一个稳定性指标改善才算有收益；否则记录“Android enrich 无收益”并停止推广。
- **UI diff 使用边界**：`--ui-diff`/`--fail-on-ui` 只对 pen 逐屏 `.pen` 可核验的屏生效；未匹配/跳过屏 `unverified` 如实呈现；Figma 未转 `.pen` 时不参与门禁。
- **硬断言边界**：Android 已接事后 OCR/UI tree adherence（`--fail-on-unresolved` 可选门禁）；更底层的状态机执行层未实现前，报告不得声称“确定性硬校验”，enriched 用例进入 Android 回归门禁时按可核对断言覆盖披露。

## 10. 分阶段

| 阶段 | 内容 | 产出 | 完成标准 |
|---|---|---|---|
| P0 | 显式 Wireframe + 结构候选 + preview | mapping report（JSON/MD） | **已实现** `design_assisted_import`（含无 Wireframe 的步骤文本结构候选）；20 条真实压力测试待补 |
| P1 | apply + overrides + needs-info + 逐屏 delta + LLM 歧义（可选）+ 设计索引审计 + ambiguous 已实现 | enriched case set + 报告 | 均已单测（LLM 用注入 chat）；Android 事后 adherence 已接，更深执行层另立项 |
| P2 | iOS 硬断言接线 + Android 事后 OCR adherence + UI diff report-only 已实现；更深执行层待补 | 端到端证据 | iOS 5 次一致；Android 通过率不降且有稳定性收益 |
| P3（可选） | 模式 B：LLM 重写步骤 + diff 审查 | 人工确认后的新步骤 | 逐行 diff、原 Excel 不变 |

## 11. 风险与开放问题

1. **屏名歧义/多语言**：Excel 模块名与设计屏名不一致时，单靠屏名会大量 ambiguous；结构拓扑匹配是主路径，但仍需同义词表/`screen-map`/overrides。
2. **结构匹配误报**：“提交/下一步/确认”等通用文案可能出现在多屏；必须结合当前屏上下文、动作类型和候选分差，precision 门槛（≥90%）优先于覆盖率。
3. **设计源过期**：flows fingerprint 进幂等键；逐屏指纹 + `delta` 只重算受影响屏，避免全量 review。
4. **人工确认过期**：`enrich-overrides.json` 的 screenId/rowHash 失效时标 `stale`，要求重确认，不静默套用。
5. **多屏用例**：P0 只支持单主屏；跨屏步骤先标 ambiguous，不猜。
6. **设计引用冲突**：Excel 隐藏 sheet 已有 `designRefs` 时，人工值优先于自动映射，冲突记 warning。
7. **Figma UI diff 限制**：自动逐屏对比依赖 pen `.pen`；Figma 需转换，否则 `unverified`。
8. **Android 确定性执行层**：事后 OCR/UI tree adherence 已接；点击/输入后的状态机断言仍需新的确定性执行层，不能只靠 LLM 文本或 UI diff。
9. **LLM 成本/隐私**：聚类批量、只发文本、缓存；`maxLlmCalls` 默认 20；Token/金额预算为可选上限（用户已决定先闭环，不设默认硬上限）。
10. **模式 B 风险**：LLM 重写步骤可能改变原意；必须 diff + 人工确认，不默认开启。

## 12. 附录：最小映射报告示例

```json
{
  "schemaVersion": 1,
  "source": {
    "excel": "qa/cases.xlsx",
    "excelSha8": "1a2b3c4d",
    "flows": ".artemis/design/flows.json",
    "flowsFingerprint": "sha256:…",
    "designSource": "pen"
  },
  "summary": { "rows": 3, "matched": 2, "ambiguous": 1, "unmapped": 0, "designRefs": 2 },
  "rows": [
    {
      "rowNumber": 2,
      "caseId": "imp-1a2b3c4d-2",
      "displayId": "TC_18",
      "name": "Check the UI of the My SMILES page",
      "module": "My SMILES",
      "status": "matched",
      "design": {
        "screenId": "screen-my-smiles",
        "screenName": "My SMILES",
        "nodeIds": ["12:34", "12:35"],
        "matchedBy": "exact",
        "confidence": 1
      },
      "reason": "模块名与设计屏名归一化后完全一致",
      "warnings": []
    },
    {
      "rowNumber": 3,
      "caseId": "imp-1a2b3c4d-3",
      "displayId": "TC_19",
      "name": "验证推荐码区域",
      "module": "Referral",
      "status": "ambiguous",
      "design": null,
      "reason": "候选 My SMILES / Referral Program 分差 0.04",
      "warnings": ["需人工确认或补 module 名"]
    }
  ],
  "warnings": ["1 行 ambiguous；apply 需 review 或 allow-unmapped"]
}
```

## 13. 真实 Excel 首轮分析（2026-11-09）

文件：`/Users/louis/Downloads/GU Navigation Menu-Test Case.xlsx`

- 33 条用例（TC_01–TC_33），1 个可见 sheet（`APP`），无隐藏「执行器」sheet，无内嵌图片。
- 7 个 Section：`Landing page`、`Login / Register`、`Login`、`Register`、`Register (Smiles card)`、`Register (Smiles Virtual Card)`、`Register (Student/Military)`、`Register (MOGI)`。
- 26 个唯一 `Wireframe` 屏名；与当前 Figma 文件 depth=4 节点名索引对照：**exact 22、near 4、missing 0**。
- near 4：
  - `1.0_Homepage` → 设计侧是 `Homepage` / `1.0.A_Homepage…` / `1.0.B_Homepage…`，应按前缀/语义消歧，不直接绑名为 `Homepage` 的 TEXT 节点。
  - `0.5.Forgot Password`、`0.5_Forgot Password (Email Filled)` → depth=4 未出现；需更深节点或标 `stale`，不能误配到名为 `0` 的节点。
  - `0.1_Register (Smiles MOGI Virtual Card)` → depth=4 只有 `0.3.2_Register_Mobile (Smiles MOGI Virtual Card)`；`0.1_Register` 变体可能不存在/过期，先标 `unmapped/stale`。
- 结论：
  - `Wireframe` 列是 P0 最强输入，优先于“猜屏名”；`Section` 决定分组，避免 32 条挤进一个 `Login / Register` 大集。
  - 当前不需要先跑全量 `figma_extract_flows`；可以先建“设计屏名索引”（同名/别名/节点 id），再按 Wireframe 逐行解析。
  - Figma 全量提取对该文件仍不可用：`fetchFile` 拉整树会被 terminated；`figmaExtractFlows` 需要 node-scoped fetch 或 page/screen 级索引，属于 P0 前置工具修复，不是 Excel 映射算法问题。
