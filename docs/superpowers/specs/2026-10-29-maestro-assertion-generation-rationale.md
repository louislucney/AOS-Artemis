# Plan 2 前因后果：从 Excel 预期到可执行 Maestro 断言

> 日期：2026-10-29
> 状态：**已评审；Phase 0/1/2/3/4 完成（生成器、脚本集、CLI/面板、下发预检），Phase 5 未做**
> 范围：Web 项目（Excel/CSV 用例源 + Maestro 脚本执行）；不包含 iOS 真机 LLM 执行、发现执行、计费
> 关联：`docs/superpowers/specs/2026-10-28-web-project-test-platform-design.md` §5.3、§6；`DESIGN.md` §13.266–§13.268、§13.276

## 0. 一页结论

当前平台的判定链是完整的，**证据链断在“生成”这一环**：

- Excel 的 Expected Result 已经能被归一化成断言文档；
- 断言文档已经能驱动 PASS/UNVERIFIED 判定；
- 但系统**不会把这些断言写进 Maestro 脚本**，也不会从 Excel 步骤生成脚本；
- runner 只执行已有的 Maestro flow，只统计 flow 里已经存在的断言。

所以现在的真实语义是：

> 脚本跑绿 + 脚本里正好写了断言 → 才可能 PASS；
> 脚本跑绿 + 脚本里没写断言 → UNVERIFIED；
> 没有脚本 → 任务直接 error。

Plan 2 建议先做 **2A：确定性的脚本与断言生成**，不做 LLM，不做猜测：

1. 从 Excel 的 Steps 生成最小可执行 Maestro flow；
2. 把断言文档里的 `visible`/`notVisible` 按步骤插入对应动作之后；
3. 只生成能确定映射的内容；不能确定的标 `unresolved`，默认阻止下发；
4. 不修改现有门禁：`manual`/`ambiguous`/`calc`/`count` 仍然不能变成 PASS；
5. 生成物是不可变脚本集资产，带来源元数据，不覆盖人工脚本。

一句话：**Plan 2 不是“让判定更宽松”，而是“让已经能判定的预期真正跑到设备上”。**

## 1. 前因：判定链是怎么走到今天的

这条线从“Excel 是唯一事实源”开始，每一步都在把“人写的预期”变成机器可判定的证据。

| 阶段 | 做了什么 | 让什么变得可证明 | 仍然不能证明 |
|---|---|---|---|
| PR #2 | Excel/CSV 接入、隐藏 `__aos_assertions`、平台结果列、结果 CSV、UNVERIFIED/SKIP | 人工预期可以转成结构化断言；脚本绿不再等于 PASS | 断言还没有被执行 |
| PR #3/#4 | 分类器加固：标签、导航、闭包、否定、状态词 | 更多预期能升为高置信 `visible`/`notVisible` | 仍然只是“文档里有断言” |
| PR #12 | runner 上报 flow 里的 `assertVisible`/`assertNotVisible` 文本 | 只有 soft `text` 的文档，可以被脚本里的真实断言覆盖 | 前提是脚本里已经写了断言 |
| PR #13 | runner 扫描 `runFlow` 引用的子流程断言 | 公共登录/导航子流程的断言也能作为覆盖证据 | 仍然要求脚本已经存在 |

这条线的方向没有变：**把人工预期变成可审计的判定依据**。但它一直没有回答一个更靠前的问题：

> 这些断言由谁写进 Maestro 脚本？

目前的答案是：**没有人写，系统也不生成**。

## 2. 现状：四段链路与断点

### 2.1 输入与断言文档

- Excel/CSV 解析为 `ParsedExcelCase`：`caseId`、`steps`、`expected`、`preconditions` 等（`src/web/excel.ts`）。
- `classifyExpectedResult` 把 `expected + steps` 归一化为 `AssertionDoc`（`src/web/assertions.ts`）：
  - `visible` / `notVisible`：高置信、可硬断言；
  - `text`：软断言，不能单独决定 PASS；
  - `count` / `calc`：需要运行时数据或计算，当前不产生硬断言；
  - `manual` / `ambiguous`：人工或歧义，不猜。
- `AssertionDoc` 目前**没有持久化到 PG**，只在结果入库时重新计算，并写到 XLSX 工作副本的隐藏列 `__aos_assertions`（`src/web/results.ts` → `src/web/assertion-column.ts`）。

这里有一个容易误解的点：

> 隐藏断言列是“结果入库后的副产物”，不是“执行前的输入”。

第一次下发任务时，工作副本里还没有这一列；生成器不能依赖它，必须直接对原件重新分类。

### 2.2 判定

`assertionGate`（`src/web/verdicts.ts`）按顺序判定：

1. 没有断言文档 → `assertion-doc-missing`；
2. 没有可执行断言 → `no-executable-assertion`；
3. 有 `manual`/`ambiguous` → `manual-or-ambiguous`；
4. 只有 soft `text` 且没有 flow 断言覆盖 → `soft-assertion-only` / `soft-assertion-uncovered`；
5. `assertionCount` 缺失或 ≤0 → `assertion-proof-missing`；
6. 全部满足 → PASS。

这条门禁本身是 fail-closed 的，方向正确。问题不在门禁，而在门禁要的证据没有人生产。

### 2.3 执行

- `executeWebJob`（`src/runner/web-executors.ts`）：
  - `executionMode=llm` → 直接返回 `llm-execution-not-wired`；
  - `scriptSetId` 为空 → 直接返回 `script-set-missing`；
  - 只有 Maestro 模式 + 脚本集才真正执行。
- 脚本集是 `.zip` 资产（`src/web/assets.ts`），面板可以上传并选择（`src/console/pages.ts`）。
- 下发时会校验脚本集与 Excel/安装包的精确匹配（`src/web/job-spec.ts` 的 `assertScriptSetMatch`）。

### 2.4 一个被忽略的产品事实：手工脚本路径实际上也走不通

这是本次评估中发现的、比“没有生成器”更直接的阻塞：

- 面板上传 `scripts` 资产时，metadata 只可能写入 `{secret:true}`（仅 materials），**不会写 `sourceExcelAssetId` / `packageAssetId`**（`src/panel/actions.ts`）。
- `assertScriptSetMatch` 在两者都缺失时直接抛 `script-set-unverified`（`src/web/job-spec.ts`）。
- 面板下发请求不解析 `allowStaleScript`（`src/panel/actions.ts` 的 `parseWebJobCreateForm`），所以无法从产品界面绕过。
- 全仓库只有测试直接调用 `storeWebAsset` 写入带 metadata 的 scripts 资产；生产路径没有第二个入口。

结论：**当前产品里没有一个“用户可完成”的 Maestro 脚本下发路径**。测试能过，是因为测试直接构造了带 metadata 的资产。生成器不仅要生成脚本，还必须由系统写入来源 metadata，才能通过精确匹配。

### 2.5 链路图

```text
Excel/CSV
  │ parse
  ▼
ParsedExcelCase ──classify──> AssertionDoc ──gate──> PASS / UNVERIFIED
  │                              │
  │                              └──(仅结果入库时)──> __aos_assertions
  │
  └── ??? ──> Maestro flow ──runner──> JUnit + assertionCount/assertions
                    ▲
                    └── 这一条箭头目前不存在
```

## 3. 问题定义

| # | 问题 | 直接后果 |
|---|---|---|
| P1 | 没有脚本生成器 | Maestro 任务只能依赖人工上传脚本；而人工脚本又因 metadata 缺失无法通过精确匹配 |
| P2 | 隐藏断言不参与执行 | 断言只在中心判定时使用；设备上不会执行它们 |
| P3 | JUnit 只证明“flow 跑完” | 没有断言的 flow 绿，不能证明 Expected Result 成立 |
| P4 | soft text 覆盖依赖“脚本已有断言” | #12/#13 提升了覆盖率上限，但没有提升“有多少脚本真的有断言” |
| P5 | 下发前没有预检 | `executionMode=maestro` 且无脚本时，任务能创建成功，直到 runner 领取才报 `script-set-missing` |
| P6 | 断言文档不持久 | 生成器、面板、审计无法直接复用同一份断言；每次都要重算 |

### 3.1 当前判定结果矩阵

| 条件 | 当前结果 |
|---|---|
| 没有脚本集 | `error: script-set-missing` |
| 脚本存在，断言文档 `high` 且可执行，但 flow 里没有硬断言 | `UNVERIFIED: assertion-proof-missing` |
| 脚本有硬断言，断言文档 `high` 且无 manual/ambiguous | 可能 PASS |
| 断言文档只有 soft `text`，flow 断言覆盖了它 | 可能 PASS（#12/#13） |
| 断言文档只有 soft `text`，flow 没有覆盖 | `UNVERIFIED: soft-assertion-only` / `soft-assertion-uncovered` |
| 断言文档含 manual/ambiguous | `UNVERIFIED: manual-or-ambiguous` |
| 断言文档含 `calc`/`count` | 当前不会单独产生硬断言，通常 UNVERIFIED |

这张表说明：**PASS 的上限不是分类器决定的，而是脚本里到底写了什么决定的。**

## 4. 为什么现在做

### 4.1 继续改分类器的边际收益已经很低

分类器已经把“能确定的具体标签/导航/闭包/否定”尽量升级为硬断言。再往前，主要剩下三类：

- 需要后台数据/排序/余额的预期；
- 需要计算或计数的预期；
- 语义本身模糊、必须人工判断的预期。

这三类都不应该靠分类器“猜”成硬断言。继续调规则会把误报风险推高，而不是提高真实通过率。

### 4.2 #12/#13 只解决了“有断言时怎么算”，没解决“断言从哪里来”

- #12 让 soft text 可以被 flow 断言覆盖；
- #13 让子流程断言也能计入。

两者都要求脚本里已经有 `assertVisible`/`assertNotVisible`。没有生成器，这个前提对大多数项目不成立。

### 4.3 真实样本的历史观测

此前对真实文件做过一次分类探测（样本不入库，仅作方向参考）：

- CSV：约 14 PASS / 12 UNVERIFIED；
- XLSX：约 18 PASS / 22 UNVERIFIED。

这些数字会随样本和分类器变化，不作为承诺；但它们说明：**还有相当比例的用例停在“文档里有预期、设备上没有断言”**。Plan 2 的 dry-run 应该重新测量，并按原因拆分：

- 没脚本；
- 脚本没断言；
- 断言未被覆盖；
- manual/ambiguous；
- calc/count；
- 步骤无法解析。

只有拿到这个拆分，才能判断生成器应该优先解决哪一段。

### 4.4 产品语义要求

平台对客户卖的是“测试结果”，不是“脚本执行日志”。如果 Excel 里写了预期，平台却只能回 `UNVERIFIED`，那这个结果对客户的价值有限。生成器是把“预期”变成“可执行证据”的唯一路径。

### 4.5 Phase 0 原型测量（2026-10-29）

在写生成器之前，用两份真实文件做了只读原型测量（样本不入库；解析器是临时脚本，不代表最终实现）：

| 文件 | 用例 | 分类器分布 | 断言分布 | 初版规则（未计前置） | 增强规则（未计前置） | 增强 + strict 前置 | 增强 + assume-prepared |
|---|---|---|---|---|---|---|---|
| CSV `test-cases s dollar part1.csv` | 26（拒绝 0） | high 14 / medium 12 / low 0 | hard 24 / soft 2；manual 5 / ambiguous 2 | 2/26 | **18/26**（17 有硬断言） | **0/26** | **18/26**（17 有硬断言） |
| XLSX `v4.9.0- Test Case.xlsx`（`行動預點`） | 40（拒绝 2） | high 18 / medium 18 / low 4 | hard 30 / soft 6；manual 7 / ambiguous 0 | 10/40 | **29/40**（22 有硬断言） | **14/40**（11 有硬断言） | **29/40**（22 有硬断言） |

“初版规则”只识别“点击/输入/滚动/返回/等待”这类以动词开头的步骤；“增强规则”增加了：

- **验证步骤**（`查看/检查/確認/观察/找到/是否`）不生成动作，只作为断言落点；
- 动作动词可以出现在分句中间（`在MOP首頁，點擊門市名稱`）；
- 代词回指（`点击该组件` 使用上一步提到的标签）；
- 更多引号/括号（`‘’`、`【】`、`「」`）；
- `选择/點選/選` 这类选择动作。

**前置条件才是最大的阻塞**：

- CSV 26/26 都有前置条件（登录、积分余额、已选门店/优惠券、后台配置等）；
- XLSX 15/40 有前置条件，25/40 为空；
- 所以 strict 模式下 CSV 直接变成 0/26，XLSX 只有 14/40；
- 18/26 和 29/40 是“假设环境已按前置条件准备好”的数字，不是默认安全模式。

**Phase 1 实现后复测**（`src/web/script-gen.ts`，与原型规则略有差异，以实现为准）：

| 模式 | CSV | XLSX |
|---|---|---|
| strict | 0/26（全部 `precondition-unparsed`） | 16/40 可生成（11 有硬断言，5 无硬断言） |
| assume-prepared | 15/26 可生成（14 有硬断言，1 无硬断言） | 31/40 可生成（22 有硬断言，9 无硬断言） |

CSV 比原型低，是因为实现默认**不推断导航**（`进入“报告页面”` 保持 unresolved）且对输入字段更严格；XLSX 比原型高，是因为输入字段、验证步骤和筛选/选择处理更完整。剩余 unresolved 的原因码：

- CSV：`navigation-unparsed` 7、`conditional-unsupported` 4、`input-field-missing` 3、`scan-unsupported` 2（按步骤计）；
- XLSX：`symbol-label` 6、`scan-unsupported` 2、`input-field-missing` 1（按步骤计）。

2A 建议：

- 默认 `preconditionMode:"strict"`：前置条件非空即 unresolved（`precondition-unparsed`）；
- 显式 opt-in `preconditionMode:"assume-prepared"`：前置条件视为环境已准备，生成 `launchApp` 时 **不清状态**（`clearState:false`），并记 `precondition-assumed` warning；不做登录/数据/后台配置的自动 setup；
- 不把“已登录/积分余额/后台配置”猜成脚本动作；这些仍由测试环境或 2B 处理。

增强后仍 unresolved 的主要原因（按步骤计，未计前置）：

- `input-shape`：`输入金额“5”` 这类只给值、没给字段名的输入；
- `scan-unsupported`：扫 QR/相机动作；
- `navigation`：`进入报告页面` 这类没有具体可点标签的页面跳转；
- `tap-label`：`+`、`ⓘ`、`<` 这类单字符/符号按钮；
- `verb`：条件分支、筛选器组合、无法归类的长句。

**结论**：

1. 规则生成不是“只写点击/输入”就够；**步骤分类（动作/验证/导航/不支持）比动词表更关键**。
2. 前置条件决定生成器是否可用：strict 是安全默认，但真实文件覆盖很低；assume-prepared 覆盖高，但依赖外部环境准备，必须在 job/结果里显式标注。
3. 增强规则在 assume-prepared 下能到约 **69%（18/26）** 和 **72.5%（29/40）** 的“所有步骤可解析”，但其中只有 17/26 和 22/40 有硬断言，不能直接等同 PASS。
4. 剩余 unresolved 不应靠猜；它们正是 2B LLM/发现执行或人工补充的输入。
5. 这些数字是解析覆盖率，不是执行通过率；真机执行还会因标签不匹配、状态、数据等原因下降，Phase 5 再测。

## 5. 备选方案与取舍

| 方案 | 做法 | 优点 | 问题 | 结论 |
|---|---|---|---|---|
| A. 继续改分类器 | 加更多规则，把 soft 升 hard | 改动小 | 不产生运行时证据；误报风险上升 | 不作为主线 |
| B. 只生成断言，注入人工脚本 | 按 caseId 找到人工 flow，按步骤号插入 assert | 复用人工动作 | 人工脚本步骤与 Excel 步骤没有稳定对应；插错位置会假 FAIL；仍需人工脚本 metadata | 可作为过渡，不作为目标态 |
| C. 规则生成完整脚本 + 断言 | 从 Steps 生成动作，从 AssertionDoc 生成断言 | 端到端闭环；确定性、可审计 | 步骤解析有边界；复杂交互会 unresolved | **推荐（2A）** |
| D. LLM 直接执行 | 模型看屏幕、决定动作 | 覆盖复杂交互 | 成本/时延/非确定性；当前 `llm-execution-not-wired`；难审计 | 后置（2B） |
| E. 像素 diff / 接口测试 | 用视觉或 API 证明 | 能覆盖视觉/后端 | 不能替代 UI 文案与流程断言；diff 已明确 report-only | 不作为 PASS 主证据 |

选择 C 的核心理由：

- 复用现有 queue/host/device/租约/runner/JUnit/面板/Excel 写回，不需要新运行时；
- `visible` → `assertVisible`、`notVisible` → `assertNotVisible` 是确定性映射；
- 生成物是文本，可 review、可 diff、可版本化；
- 生成不出来就 `unresolved`，不会假绿；
- 为 2B 的 LLM 留出清晰边界：LLM 只处理规则解析不了的步骤。

## 6. 建议方案 2A：确定性生成

### 6.1 边界

**做：**

- 从原件 `ParsedExcelCase` 生成每个用例一个 `flows/<caseId>.yaml`；
- 从同一份 `AssertionDoc` 生成 `assertVisible` / `assertNotVisible`；
- 步骤先分类（动作/验证/导航/滚动/返回/不支持），验证步骤只作为断言落点；
- `preconditionMode:"strict"` 默认：前置条件非空即 unresolved；`"assume-prepared"` 显式 opt-in，前置条件视为环境已准备、`clearState:false`、记 warning；
- 生成不可变脚本集资产，写 `sourceExcelAssetId` / `packageAssetId` / `platform` / `generatorVersion` / `assertionDocHash`；
- 生成前 dry-run：逐例报告 `ready` / `unresolved` 及原因；
- 下发前预检：Maestro 模式无脚本直接 400，并给生成入口。

**不做：**

- 不调用 LLM（2B 再做）；
- 不做 testID 自动发现（沿用 spec §6.2 的后续阶段）；
- 不生成登录/积分/后台配置等前置 setup；`assume-prepared` 只做显式假设，不伪造 setup；
- 不生成 `calc` / `count` 硬断言；
- 不把 `manual` / `ambiguous` 变成断言；
- 不把系统补的 `建议｜关键预期` 当硬断言（除非管理员显式开启，沿用 spec §6.3）；
- 不覆盖人工脚本、不反向修改 Excel 原件；
- 不因为生成成功就放宽 PASS 门禁。

### 6.2 输入

| 输入 | 来源 | 用途 |
|---|---|---|
| `caseId` / `name` / `steps` / `expected` / `preconditions` | 原件解析 | 生成动作与断言；前置条件按 `preconditionMode` 处理 |
| `AssertionDoc` | `classifyExpectedResult` 重新计算 | 断言来源；与判定同源 |
| `preconditionMode` | 项目/任务参数 | `strict`（默认）或 `assume-prepared` |
| `appId` | 项目配置（按平台 android/ios）或安装包 metadata | Maestro flow 必需 |
| 平台/设备类型 | job 需求 | 仅影响命令白名单/后续发现 |
| 测试资料 | materials 资产 | 2A 只保留占位符，不生成 secret |

**`appId` 是 2A 的硬前置。** 当前 `scripts` 资产与安装包都没有可靠的 `appId` 字段；需要二选一：

1. Web 项目增加按平台的必填 `appId`（Android package / iOS bundle id）；
2. 上传安装包时解析 APK manifest / IPA `Info.plist` 写入 metadata。

建议 1 优先：显式、可 review、不依赖本机 Android/iOS 工具链；2 作为便利补充。校验按平台分别做：

- Android：`^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$`（允许两段，不允许连字符）；
- iOS：非空 ASCII、至少一个点、每段非空、允许 `[A-Za-z0-9.-]`；不强制三段反向 DNS。

不要用一条 `com.xxx.yyy` 正则同时卡双端，否则会误杀合法的 Android 两段包名或带连字符的 Bundle ID。安装后能拿到真实包名时，再做一次一致性校验。

双端项目**按平台分别生成脚本集**，不要把一个 `appId` 塞进同一个 zip。`manifest.platform` 与 job 的 `requirements.platform` 必须一致；runner 只执行对应平台的脚本集。

**前置条件处理**（Phase 0 显示这是最大阻塞）：

- `preconditionMode:"strict"`（默认）：`preconditions` 非空（忽略 `无/無/None/-`）→ unresolved `precondition-unparsed`；不猜登录/积分/后台配置。
- `preconditionMode:"assume-prepared"`：前置条件视为环境已准备；flow 仍生成，但 `launchApp.clearState=false` 且 `stopApp=false`（保留前台页面/登录态），并记 `precondition-assumed` warning。此模式必须在 job/script set/结果里可见，不能静默。
- 2A 不生成登录、积分余额、后台配置、优惠券状态等 setup；这些属于测试环境或 2B。
- 真实文件里 CSV 26/26、XLSX 15/40 有前置条件；strict 下 CSV 0/26、XLSX 14/40，assume-prepared 下才是 18/26、29/40（见 §4.5）。

### 6.3 输出

脚本集目录（沿用 spec §4.5）：

```text
<project>/.artemis/web/scripts/<scriptSetId>/
  manifest.json
  flows/
    TC-001.yaml
    TC-002.yaml
```

`manifest.json` 至少包含：

```json
{
  "generatorVersion": 1,
  "platform": "android",
  "sourceExcelAssetId": "asset-...",
  "packageAssetId": "asset-...",
  "assertionDocHash": "sha256:...",
  "cases": [
    {
      "caseId": "TC-001",
      "status": "ready",
      "flow": "flows/TC-001.yaml",
      "assertions": 2,
      "assertionTexts": [
        { "step": 4, "type": "visible", "originalText": "登录成功" }
      ]
    },
    { "caseId": "TC-002", "status": "unresolved", "reason": "step-unparsed:3" }
  ]
}
```

`assertionTexts[].originalText` 是未转义的 Excel 原文；YAML 里写的是转义后的正则字面量。这个字段同时用于 review、审计和 soft text 覆盖判断，避免“YAML 里的 `\\(` 与 Excel 里的 `(` 对不上”。

`status=ready` 的定义沿用 spec §6.3：**每一步至少有一个可执行选择器**。断言数为 0 的用例仍可 `ready`（flow 可执行，但判定最多 UNVERIFIED）；生成器在 manifest 里用 `assertions: 0` + `unverified-expected` 显式标注，不假装它能 PASS。

### 6.4 步骤 → 动作规则（2A 白名单）

只识别明确动词；识别不了就 `unresolved`，不猜。步骤先分类，再决定是否生成动作：

| 步骤类型 | 示例 | 处理 |
|---|---|---|
| 启动 | `启动 App`、`打开 App` | `launchApp: { clearState: true }`，每个 flow 首步 |
| 动作 | `点击“X”`、`點選 X`、`选择“X”`、`在“Y”输入 X` | `tapOn` / `inputText`；文本必须 2..30 字、具体标签 |
| 验证 | `查看“X”`、`检查【X】`、`确认弹窗出现`、`找到“X”` | **不生成动作**；断言文档的断言落在这里（或前一个动作之后） |
| 导航 | `进入“X”页面`、`打开“X”` | 有具体可点标签 → `tapOn`；否则 unresolved，不用 `launchApp` 冒充 |
| 滚动 | `向下/向上滚动`、`滚动至“X”` | 方向明确 → `scroll`；元素明确 → `scrollUntilVisible`；否则 unresolved |
| 返回/等待 | `返回`、`等待页面加载` | `back` / `waitForAnimationToEnd` |
| 代词回指 | `点击该组件`、`再点击一个门市的“爱心”` | 用上一步提到的具体标签；无前文 → unresolved |
| 不支持 | `扫描 QR`、相机、条件分支、组合筛选 | unresolved，交给 2B/发现/人工 |

约束：

- 文本中的引号、换行、`${}`、超过 200 字 → 拒绝生成；
- 引号/括号变体（`“”`、`‘’`、`【】`、`「」`）统一解析；只有成对出现才算标签；
- Maestro 的 `tapOn`/`assertVisible`/`assertNotVisible` 文本默认按正则处理，且当前源码用 `Regex.matches`（**全匹配**，不是子串）。因此：
  - 统一对人工文案做 `escapeRegExp`（等价于 Maestro 的 `Regex.escape`），不要直接拒绝含 `()`、`[]`、`.`、`+` 的正常文案；
  - **不自动加 `.*`**：`.*登录.*` 会把“精确断言”变成“包含即可”，增加假 PASS 风险；
  - YAML 序列化优先用单引号标量（或正确转义反斜杠），避免 `\(` 在双引号里被 YAML 解释；
  - 在 runner 上记录 Maestro 版本，并用小样本验证全匹配/转义行为；不同版本若行为不同，按版本降级为 unresolved，不假设一致；
- 同一 flow 内重复的 tap 文本：通用词（确定/取消/保存/返回）标 `ambiguous-text`；具体标签重复不阻断，但记 warning（真正消歧留给发现阶段）；
- 单字符/符号按钮（`+`、`ⓘ`、`<`）2A 不自动生成，标 `symbol-label`；
- 中文/英文步骤都按同一动词表处理；繁体与简体都覆盖；
- `preconditions` 含登录/账号/后台等无法确定性表达的步骤 → unresolved，不伪造 setup。

### 6.5 断言 → 命令规则

| AssertionDoc | 生成 | 说明 |
|---|---|---|
| `visible` | `assertVisible: '<text>'` | 硬断言；文本做 `escapeRegExp` |
| `notVisible` | `assertNotVisible: '<text>'` | 硬断言；文本做 `escapeRegExp` |
| `text` | **默认不生成** | 见 §10 Q1；只有通过“具体标签”复核的才生成 `assertVisible`，否则 unresolved + `assertion-soft-text-skipped` |
| `manual` | 不生成 | 保持 UNVERIFIED |
| `ambiguous` | 不生成 | 保持 UNVERIFIED |
| `count` | 不生成 | 需要运行时计数，2A 不做 |
| `calc` | 不生成 | 需要表达式求值，2A 不做 |

生成断言时必须保留来源与原文：

```yaml
# aos:assertion step=4 source=excel.expected type=visible
# aos:text 登录成功
- assertVisible: '登录成功'
```

- 注释不是给 Maestro 看的，是给 review、审计和后续 diff 看的；
- `# aos:text` 写未转义原文，用于 soft text 覆盖和人工核对；
- `manifest.assertionTexts[].originalText` 是同一份原文；runner 的 `parseFlowAssertions` 仍需对 YAML 里的转义文本做反转义（或由中心用 manifest 原文覆盖），否则 #12 的 soft 覆盖会误判；
- `assertNotVisible` 的语义是“没有整段文本等于 X 的元素”，**不是**“页面任何位置都不包含 X”；若业务要求“包含即失败”，2A 的精确断言不够，标 unresolved 或后续用正则/更高阶选择器；
- 如果文本含单引号，YAML 单引号标量用 `''` 转义；含换行/控制字符直接拒绝。

### 6.6 插入位置

- `AssertionDoc.steps[].step` 是 1-based 的 Excel 步骤号；
- 生成器为每个 Excel 步骤生成一条动作（或一组动作），断言插在**对应步骤动作之后**；
- 同一屏的多个断言按文档顺序输出；
- **断言步骤号超出动作数**：分类器 `classifyExpectedResult` 目前在 `step > steps.length` 时直接归入 `ambiguous[]`（reason「步骤编号超出范围」），生成器不会收到这条断言；2A **不放宽**，保持 fail-closed。未来若要支持“第 N+1 条预期 = 最后一步之后的结果”，必须单独改分类器（推荐显式 opt-in `allowFinalStepAssertion`，默认关，并记 `final-step-inferred` warning），不能只在生成器末尾硬塞；
- 单行无编号预期在分类器里已绑定最后一步；生成器按绑定结果处理。

示例：

```yaml
appId: com.example.app
tags:
  - TC-001
---
- launchApp:
    clearState: true
- tapOn: '登录'
- tapOn: '账号'
- inputText: 'test@example.com'
- tapOn: '提交'
# aos:assertion step=4 source=excel.expected type=visible
# aos:text 登录成功
- assertVisible: '登录成功'
```

### 6.7 unresolved 与下发

沿用 spec §6.1/§6.3：

- 默认 `allowPartialUnresolved=false`：有 unresolved 用例 → 整个 job 不下发（或下发前 400 并列出用例）；
- 显式 `allowPartialUnresolved=true`：跳过 unresolved，Excel 写 `SKIP（脚本未就绪）`，任务 `partial`；
- 不允许把 unresolved 用例“生成一个只有 launchApp 的 flow”混过去；
- 生成器响应/面板必须给出每个 unresolved 的原因码，例如：
  - `step-unparsed:3`
  - `input-field-missing:2`
  - `navigation-unparsed:1`
  - `ambiguous-text:5`
  - `symbol-label:3`
  - `scan-unsupported:1`
  - `conditional-unsupported:4`
  - `assertion-manual:2`
  - `assertion-soft-text-skipped:4`
  - `assertion-uncovered-text:4`
  - `app-id-missing`
  - `app-id-invalid`
  - `precondition-unparsed`
  - `precondition-assumed`（warning，不是 unresolved）

### 6.8 版本、幂等与人工脚本

- 每次生成创建新的不可变 scripts 资产；相同输入 + 相同生成器版本 + 相同 assertionDocHash → 复用已有资产（幂等），不重复堆版本；
- 生成资产 metadata 写入 `sourceExcelAssetId` / `packageAssetId` / `platform` / `generatorVersion` / `assertionDocHash` / `origin:"generated"` / `generatedBy:"aos"`，使 `assertScriptSetMatch` 可以通过；`assertScriptSetMatch` 需扩展为 `platform` 不匹配也拒绝；
- Excel 或安装包版本变化 → 旧脚本集不匹配，任务默认拒绝；生成器按新版本重新生成；
- 人工脚本与生成脚本**逻辑隔离**（不新增资产 kind，避免动 `WEB_ASSET_KINDS`/上传路由/限额）：
  - 生成脚本：`origin:"generated"`、`generatedBy:"aos"`，不可变、不覆盖；
  - 人工脚本：`origin:"manual"`，上传时提供 `sourceExcelAssetId` / `packageAssetId` 选择（选填）；未填时提示“将无法通过精确匹配，除非下发时显式勾选 `allowStaleScript`”；
  - 面板按 `origin` 分组/过滤；任何情况下都不原地修改已存在的脚本资产；
- 下发表单增加 `allowStaleScript` 勾选（当前 `parseWebJobCreateForm` 不解析该字段）；使用时结果/任务标注 `stale-script`，便于审计。

### 6.9 生成入口

建议先做同步入口，不做新 job kind（Phase 3 已按此实现）：

- `POST /panel/api/projects/:id/scripts/generate`（maintainer+，body: `excelAssetId`, `packageAssetId`, `platform`, `dryRun?`, `allowPartialUnresolved?`）；
- `GET /panel/api/projects/:id/scripts/:scriptSetId/flow/:caseId`：只读预览/下载单个 YAML；不返回 secret，按项目成员权限控制；
- `POST /panel/api/jobs/preflight`（或扩展现有 `/panel/api/jobs/preview`）：返回 `{ok, reason, compatibleScriptSets, nextAction}`；检查脚本集存在且 `sourceExcelAssetId`/`packageAssetId`/`platform` 全部匹配；
- CLI：`web scripts generate --project <dir> --excel <id> --package <id> --platform <android|ios> [--dry-run] [--json]`；
- 面板资产页增加“生成脚本”按钮与逐例 ready/unresolved 列表；下发页在无兼容脚本时禁用“下发”并显示“先生成脚本”CTA。

预检是体验优化，**服务端仍是权威**：`createWebJob` 在 `executionMode=maestro` 且无兼容脚本时返回 400（code `script-set-missing` 或 `script-set-mismatch`），不能只靠前端灰按钮。

生成是纯 CPU + 文件操作，不需要设备；LLM 阶段（2B）再考虑 job 化。

## 7. 具体例子

### 7.1 可生成

Excel：

| 用例编号 | 步骤 | 预期 |
|---|---|---|
| TC-001 | 1. 启动 App<br>2. 点击“登录”<br>3. 在“账号”输入 test@example.com<br>4. 点击“提交” | 1. 页面显示“登录成功” |

生成：

```yaml
appId: com.example.app
tags:
  - TC-001
---
- launchApp:
    clearState: true
- tapOn: '登录'
- tapOn: '账号'
- inputText: 'test@example.com'
- tapOn: '提交'
# aos:assertion step=4 source=excel.expected type=visible
# aos:text 登录成功
- assertVisible: '登录成功'
```

判定：flow 通过 + `assertionCount=1` + 文档 `high` + 无 manual/ambiguous → PASS。

### 7.2 不可生成

| 用例编号 | 步骤 | 预期 |
|---|---|---|
| TC-002 | 1. 打开订单页<br>2. 确认金额与后台一致 | 订单金额等于后台配置 |

生成结果：

```json
{
  "caseId": "TC-002",
  "status": "unresolved",
  "reason": "assertion-manual:2",
  "detail": "预期含后台/配置依赖，不能生成硬断言"
}
```

判定：不生成 flow；默认阻止下发；显式部分下发时写 `SKIP（脚本未就绪）`，任务 `partial`。

## 8. 风险与缓解

| 风险 | 具体表现 | 缓解 |
|---|---|---|
| 动作生成错 → 假 FAIL | “点击登录”被解析成点击了错误文本 | 只识别明确动词；文本必须具体；dry-run 可 review；unresolved 不猜 |
| 断言太弱 → 假 PASS | 生成 `assertVisible: "成功"`，页面任意位置有“成功”就过 | 拒绝通用词/状态词；只生成具体标签；`text` 默认不生成；保留来源注释 |
| 重复文本 → 点错元素 | 页面有多个“确定”，Maestro 点第一个 | 通用词标 ambiguous；后续发现阶段用 `id`/index 消歧；不静默选第一个 |
| 动态内容 → 断言永假 | 文本含日期/金额/`${}` | 含 `${}`/占位符/超长 → unresolved |
| 状态泄漏 → 用例互相影响 | 上一个用例留在登录态 | 默认 `clearState: true`；preconditions 不能确定时 unresolved |
| secret 泄漏 | 账号密码写进 YAML | 2A 不写 secret；materials 仍走运行时注入；生成物日志脱敏 |
| 脚本过期 | Excel/安装包更新后仍用旧脚本 | metadata 精确匹配；不匹配拒绝；重新生成 |
| 人工内容被覆盖 | 生成器重写人工脚本 | 生成资产不可变、独立版本；人工脚本单独管理 |
| unresolved 被忽略 | 任务带着空 flow 下发，假绿 | 默认阻止；部分下发写 SKIP 且任务 `partial` |
| 正则元字符 | `登录（成功）` 里的 ASCII 括号被当成正则分组，匹配失败或误匹配 | 统一 `escapeRegExp`；控制字符/超长直接拒绝；YAML 用单引号/正确转义 |
| YAML 注入 | 文本含引号/换行/`---` | 统一转义/加引号；超长/控制字符拒绝 |
| 全匹配语义误判 | `assertVisible: 登录成功` 只匹配整段文本，页面写“登录成功，正在跳转”会失败 | 文档化“元素文本全匹配”语义；只对具体标签生成；不自动加 `.*`；不确定时 unresolved |
| `assertNotVisible` 语义误判 | 页面有“X（停用）”，`assertNotVisible: X` 仍通过 | 精确断言只证明“没有整段等于 X 的元素”；要求“包含即失败”时标 unresolved，不自动加 `.*` |
| 转义后覆盖失效 | YAML 里是 `\\(`，Excel 原文是 `(`，soft 覆盖对不上 | manifest 存 `originalText`；runner 解析断言时反转义；覆盖比较用原文 |
| Maestro 版本差异 | 不同版本对 regex/全匹配行为不同 | runner 记录版本；小样本行为测试；不满足预期时降级 unresolved |

## 9. 验收标准

### 9.1 功能

1. 给定一个步骤可解析、断言为 `visible`/`notVisible` 的用例，生成器产出可被 Maestro 执行的 flow，且 `assertionCount` 等于生成的断言数。
2. 给定含 `manual`/`ambiguous`/`calc`/`count` 的用例，生成器**不产生**对应硬断言，并给出明确 reason；soft `text` 被跳过时给 `assertion-soft-text-skipped`。
3. `dryRun=true` 不写任何脚本资产，只返回逐例状态与原因。
4. 生成脚本集带 `sourceExcelAssetId`/`packageAssetId`/`platform`；下发时精确匹配通过；Excel/安装包/平台变化后匹配失败。
5. Maestro 模式无兼容脚本下发时，中心在创建任务前返回 400（code `script-set-missing`/`script-set-mismatch`），不再等到 runner 报错；前端 preflight 能在提交前提示并禁用按钮。
6. 现有 PASS 门禁不变：生成成功不等于 PASS；仍需 flow 通过 + 断言证据。
7. 含 `()`、`[]`、`.`、`+`、`|`、`^`、`$`、`\` 的文案能被正确转义并生成 YAML；YAML 可被 Maestro 解析；断言原文在 manifest/comment 中保留。
8. 分类器对 `step > steps.length` 仍归 `ambiguous`（2A 不放宽）；如未来启用 `allowFinalStepAssertion`，默认关闭且有 `final-step-inferred` warning。

### 9.2 安全

1. 生成物不包含 materials 中的 secret；日志/错误摘要不回显 secret。
2. `caseId` 作为文件名前做字符白名单/长度限制，拒绝路径穿越。
3. 断言的文本长度、类型、控制字符校验与中心 ingest 口径一致。
4. 生成器只读原件，不写原件；工作副本写回仍走既有 journal 规则。

### 9.3 指标（dry-run + 真机小样本）

- Phase 0 原型基线：strict 下 CSV 0/26、XLSX 14/40；assume-prepared 下 CSV 18/26、XLSX 29/40。Phase 1 实现后：strict 下 CSV 0/26、XLSX 16/40；assume-prepared 下 CSV 15/26（14 有硬断言）、XLSX 31/40（22 有硬断言）。2A 目标不低于对应模式基线，并记录提升/回退；
- 生成 `ready` / `unresolved` 数量，及 unresolved 原因分布；
- 生成用例中 `visible`/`notVisible`/`text` 的比例，以及 soft text 被跳过（`assertion-soft-text-skipped`）的比例；
- 含 regex 元字符的文案数量与转义后成功率；
- 真机执行后 PASS/FAIL/UNVERIFIED 分布，与生成前基线对比（按平台拆分）；
- FAIL 中“动作失败”与“断言失败”的比例；
- 人工抽查 PASS 样本的假阳性率（目标是 0；发现即回退规则）。

### 9.4 测试

- 单元：步骤解析、断言映射、regex 转义/YAML 单引号、unresolved 原因、幂等 hash；
- 单元：`assertVisible`/`assertNotVisible` 的原文映射（`originalText`）、runner 反转义、soft 覆盖；
- 单元：确定性 zip、manifest、`assertionDocHash`、文件名清洗、幂等写入；
- 集成：fixture 工作簿 → 生成脚本集 → fake runner 执行 → 结果入库 → 门禁 PASS/UNVERIFIED；
- 集成：双平台 fixture 分别生成 `platform=android`/`platform=ios` 脚本集，`appId` 不串台；
- 集成：无脚本/不匹配脚本的 preflight 与服务端 400；
- 回归：现有测试全绿；lint 0 error；`step > steps.length` 仍 ambiguous；platform 不匹配拒绝；
- 安全：路径穿越、超长文本、`${}`、secret 不落盘。

## 10. 需要评审拍板的问题

### Q1. soft `text` 要不要生成成 `assertVisible`？

- **建议：默认不生成。** 只有通过“具体标签”复核（长度 2..30、无状态/泛化词、无 `${}`）的 `text` 才生成；其余保持 unresolved，并记 `assertion-soft-text-skipped`。
- 理由：`text` 之所以是 soft，就是因为分类器不确定它是不是可定位的具体文案；直接生成会把不确定性变成假 PASS 风险。
- 备选：全部生成，靠人工 review；不推荐作为默认。

### Q2. 2A 做“完整脚本”还是“只生成断言”？

- **建议：完整脚本（规则白名单）。** 只生成断言无法解决 `script-set-missing`，也无法解决人工脚本 metadata 缺失。
- 如果评审认为完整脚本风险太大，可以退到 B 方案：只对“人工脚本已存在且 metadata 完整”的项目生成断言；但这不能覆盖真实客户项目。

### Q3. unresolved 默认阻止整个 job，还是允许部分下发？

- **建议：沿用 spec 默认阻止。** 部分下发必须显式 `allowPartialUnresolved=true`，并写 `SKIP（脚本未就绪）` / `partial`。
- 理由：默认放行会让“没生成出来”悄悄变成“没执行”，客户看不到缺口。

### Q4. `appId` 从哪里来？

- **建议：Web 项目增加按平台的必填 `appId`**（Android package / iOS bundle id），生成时校验与安装包一致（能解析时）。Phase 3 先用项目已有 `appPackage` 作为缺省，双端项目需显式传 `--app-id`/面板值；后续再补按平台配置。
- Android/iOS 分别校验，不要用一条 `com.xxx.yyy` 正则；双端分别生成脚本集，manifest 带 `platform`。
- 备选：上传安装包时解析 metadata；需要 `aapt`/`plutil` 等工具，跨平台一致性差。

### Q5. 人工脚本怎么处理？

- **建议：生成脚本与人工脚本逻辑隔离。** 生成资产 `origin:"generated"`、`generatedBy:"aos"`、不可变；人工脚本 `origin:"manual"`，上传时提供 `sourceExcelAssetId`/`packageAssetId` 选填字段，未填时警告；下发页暴露 `allowStaleScript` 勾选，并在结果中标注 `stale-script`。
- 不新增 `generated-scripts` 资产 kind，也不按目录做“物理隔离”；用 metadata 分组/过滤即可，避免动 `WEB_ASSET_KINDS`、上传路由、限额与测试。
- 不建议让生成器覆盖人工脚本，也不建议让生成器“修补”人工脚本。

### Q6. LLM 现在做吗？

- **建议：不做。** 2A 先把确定性链路跑通，拿到 unresolved 原因分布；2B 只对规则解析不了的步骤调用 LLM，并且输出仍走同一套白名单/校验。
- 理由：当前没有 token 计费表、没有 LLM 执行证据、没有非确定性结果的可审计方案；先做 LLM 会把风险和成本前置。

### Q7. 断言文档要不要持久化？

- **建议：2A 不新增表。** 生成时重新分类，记录 `assertionDocHash`；结果入库时再分类一次，保证判定与生成同源。
- 如果后续需要审计/复用，再考虑把 `AssertionDoc` 存到 job/script set 的 JSON 产物里（不是新 PG 表）。

### Q8. 断言步骤号 = 动作数 + 1，要不要放宽？

- **2A 建议不放宽（方案 A）。** 分类器当前把 `step > steps.length` 归入 `ambiguous`；保持 fail-closed，用户修正 Excel 编号或补步骤。
- 备选 B：显式 opt-in `allowFinalStepAssertion`（默认关），把 N+1 绑到最后一步并记 `final-step-inferred` warning；需单独改分类器、跑全量回归。
- 备选 C：面板人工确认“绑定到最后一步”；体验最好，但 2A 工作量增加。
- 不采用“生成器偷偷把 N+1 塞到末尾”的隐式行为。

### Q9. 前置条件怎么处理？

- **2A 建议默认 `strict`**：前置条件非空 → unresolved；不猜登录/积分/后台配置。
- 提供显式 `assume-prepared`：前置条件视为环境已准备，`clearState:false`，记 `precondition-assumed` warning；必须在 job/script set/结果可见。
- 不把前置条件自动转成登录/数据 setup；那是 2B/测试环境职责。
- 真实文件 strict 覆盖率很低（CSV 0/26、XLSX 14/40），assume-prepared 才到 18/26、29/40；产品需要明确默认值和提示。

## 11. 若批准，实施顺序

| 阶段 | 内容 | 产出 |
|---|---|---|
| 0 | dry-run 测量 | 已完成原型：CSV 18/26、XLSX 29/40（assume-prepared，未计前置）；strict 见 §4.5 |
| 1 | `src/web/script-gen.ts` 纯生成器 + 单元测试 | 已完成：步骤分类/动作/断言 → flow YAML；`test/web-script-gen.test.js` 19 例 |
| 2 | 脚本集资产落盘 + metadata + 幂等 | 已完成：`src/web/zip.ts` + `src/web/script-set.ts`；manifest/metadata/幂等/平台匹配 |
| 3 | 面板/CLI 生成入口 + dry-run 展示 | 已完成：`web scripts generate` + assets 页表单/脚本集表；dry-run/manifest/审计 |
| 4 | 下发预检 + 部分下发语义 | 已完成：无脚本 400 `script-set-missing`；unresolved 409 `script-set-incomplete`，显式 `allowPartialUnresolved` 放行；面板勾选/前端提示 |
| 5 | 真机小样本验收 | PASS/FAIL/UNVERIFIED 与基线对比；假阳性抽查 |
| 6 | （后续）发现执行 / testID 字典 | 用 `id:` 替代 `text:`，降低歧义 |
| 7 | （后续）2B LLM 处理 unresolved | 受控、可审计、仍走白名单 |

## 12. 这份方案不解决什么

- `calc`/`count` 断言：仍需要运行时数据或表达式求值；
- 后台数据/排序/余额类预期：仍保持 manual/UNVERIFIED；
- 视觉/像素差异：仍是 report-only，不作为 PASS 主证据；
- testID 自动发现：2A 不做，文本定位仍有歧义风险；
- iOS 真机 LLM 执行：仍 `llm-execution-not-wired`；
- 接口/API 测试：不属于 UI flow 断言；
- token 计费：2A 不调用 LLM，不产生生成 token 成本。

---

**评审重点**：Q1（soft text 是否生成）、Q2（完整脚本 vs 只生成断言）、Q4（`appId` 来源）、Q5（人工脚本策略）、Q8（步骤号 N+1 是否放宽）。以上 Q1–Q8 已按 2026-10-29 评审结论确定；Q8 的 B/C 仅作为后续备选。

## 13. 评审记录（2026-10-29）

- Q1：默认不生成 soft `text`；只对通过具体标签复核的子集生成；dry-run 记 `assertion-soft-text-skipped`。
- Q2：做完整脚本（规则白名单），同时提供 YAML 预览/下载。
- Q4：项目按平台配置必填 `appId`；Android/iOS 分别校验；双端分别生成脚本集，manifest 带 `platform`。
- Q5：生成/人工脚本逻辑隔离（`origin` metadata），不新增资产 kind；人工脚本上传补 metadata 字段，下发暴露 `allowStaleScript`，结果标注 `stale-script`。
- Q8：2A 保持 fail-closed，不放宽步骤号 N+1；未来如需支持，走显式 opt-in `allowFinalStepAssertion`（默认关）或人工确认。
- 正则：统一 `escapeRegExp`，YAML 用单引号/正确转义；不自动加 `.*`；manifest/comment 保留 `originalText`，避免转义文本破坏 soft 覆盖。
- 预检：前端禁用按钮 + 服务端 400 双保险；预检校验脚本集与 Excel/包/平台三者兼容。
- Phase 0：用两份真实文件做了原型测量；初版规则只有 CSV 2/26、XLSX 10/40 可解析，增强为“动作/验证/导航/不支持”分类后达到 CSV 18/26、XLSX 29/40（均未计前置条件）。计入前置后：strict 为 CSV 0/26、XLSX 14/40；assume-prepared 才回到 18/26、29/40。结论：2A 的步骤分类和前置条件模式同样关键；验证步骤可作为断言落点，不生成动作；默认 strict，assume-prepared 必须显式。
- Phase 1：`src/web/script-gen.ts` 纯生成器 + `test/web-script-gen.test.js` 19 例已完成；实现后复测 strict CSV 0/26、XLSX 16/40，assume-prepared CSV 15/26（14 有硬断言）、XLSX 31/40（22 有硬断言）。
- Phase 2：`src/web/zip.ts`（确定性 zip）+ `src/web/script-set.ts`（manifest/metadata/幂等写入）已完成；`assertScriptSetMatch` 增加 platform 校验。
- Phase 3：`src/web/script-generation.ts` 服务 + `web scripts generate` CLI + assets 页“生成 Maestro 脚本”表单/`POST /panel/api/projects/scripts/generate` 已完成；appId 缺省用项目 `appPackage`，双端显式传；仍不做下发预检/设备执行。
- Phase 4：`createWebJob` 预检完成——Maestro 无脚本 → 400 `script-set-missing`；脚本 metadata `unresolved>0` 未显式允许 → 409 `script-set-incomplete`；面板增加 `allowStaleScript`/`allowPartialUnresolved` 勾选与前端无脚本提示。
- 下一步：Phase 5 真机小样本验收（生成脚本 → 执行 → PASS/FAIL/UNVERIFIED 与基线对比；假阳性抽查）。
