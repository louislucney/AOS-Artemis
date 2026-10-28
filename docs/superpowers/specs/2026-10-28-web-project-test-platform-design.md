# 网页新增项目与测试任务平台设计（Excel 主表 + Maestro 脚本 + LLM 执行）

> 2026-10-28 · 状态：brainstorm 定稿；builder-check 完成、问题已并入；待用户批准后出实施计划。
> 关联现状：现有 panel / HTTP 服务、文件台账与 PostgreSQL 台账、suite task / runner / 设备执行、Excel 导入、usage 采集、LLM 条目与 ARTEMIS 子进程。

## 1. 意图与业务模型

### 1.1 业务

- 本服务是一个**独立收费项目**：公司先向 LLM 厂商付费，平台按项目、按账期记录 LLM token 成本，再向客户收费。
- 客户项目**由管理员在网页手动新增**，不走 MCP 接入，不需要用户填写服务器路径或 MCP 配置。
- 新项目复用现有能力：用例资产、任务下发、执行机（runner）领取、设备执行、结果/证据、面板、审计。
- 新项目的主流程：

```
网页新增项目
  → 上传/引用 Excel 测试文件 + 测试资料 + APK/IPA
  → 生成 Maestro 脚本（或选择 LLM 执行）
  → 下发测试任务到指定执行机
  → 执行机安装安装包，按预设流程执行
  → 回传逐用例结果、设备/包/时间信息与证据
  → Excel 空白列补建议与结果、面板查看详情
  → LLM token 成本按项目/任务/账期汇总并出账
```

- 成功依据：**测试用例的执行结果**（逐用例 PASS/FAIL/SKIP/ERROR；任务是否通过由用例结果聚合）。

### 1.2 已确认的产品决策

1. 项目名称**全局唯一**，作为项目标识与存储划分；系统在 workspace 下创建同名/安全 slug 目录。
2. Excel 是**唯一事实源**；脚本是执行产物，不能反向修改 Excel 已有内容。
3. 系统以**用例编号列为锚**，从表头行向右追加系统列；只写空白格或未被人工改动的系统格，不覆盖、不删除人工内容；重跑可刷新系统结果。
4. 测试文件允许**任意 Excel**，通过列映射接入；也允许引用项目历史文件。
5. 最小必填列：**用例编号 + 步骤**；其他列可缺失。
6. 同一文件内用例编号重复：**保留第一条，拒绝后续重复行**，导入继续并报告行号。
7. 脚本格式：**Maestro YAML**，覆盖 Android 与 iOS 模拟器；iOS 真机走 LLM/Appium（见 §1.2.22）。执行机只需 APK/IPA，不需要项目源码或 Gradle/Xcode 构建。
8. 执行方式：**Maestro 脚本执行**与 **LLM 实时执行**两种，任务下发时选择。
9. testID 由**系统在真实设备上自动发现**；接受“先跑草稿/发现执行，再生成正式脚本”的代价。
10. 任务下发到**执行机（runner）**，不要求用户选择具体设备；执行机自动选择空闲且平台匹配的设备。
11. 结果保存两层：Excel 右侧 8 列摘要 + 独立详细结果（每步动作/截图/日志/设备/包/时间/trace）。
12. 计费范围**只算 LLM token**，设备占用、执行机时长、存储、平台服务费暂不计。
13. 对客价格 = 厂商标准价 ×（1 + 加成）；加成**按厂商/模型分别配置**。
14. 价格表与加成由**管理员在网页后台维护**，带生效时间、版本与审计。
15. 账期由管理员为每个项目指定**任意起止日期**。
16. 客户账单币种统一**人民币**；美元厂商按**调用时实时汇率快照**折算。
17. 角色：管理员负责项目、价格表、账单；dispatcher/维护人员负责下发；沿用现有用户/角色体系。
18. 界面**扩展现有 panel**，不另做独立客户门户（第一版）。
19. 测试文件、测试资料、安装包是**项目级版本库**，任务引用具体版本。
20. 测试资料可填写测试账号/密码/环境地址等，敏感信息掩码、日志不落明文、执行时注入。
21. **远程执行机**：项目与资产在中心，执行机按任务下载资产/脚本、在本地工作目录执行、回传结果；不要求项目目录预存在执行机。
22. **iOS 混合**：Android 与 iOS 模拟器用 Maestro；iOS 真机用 Appium / 现有 AOS 执行器，不走 Maestro。
23. **敏感信息不发给模型**：LLM 模式只看到占位符；账号/密码由执行器在设备动作前替换，模型、prompt、trace 不出现明文。
24. LLM 凭证与计费范围：第一版先用平台统一 LLM 条目；逐项目 key / 客户自带 key 的计费归属后续新增（见 §8.5）。
25. 下发时用户可指定执行机，也可再指定具体设备；都不指定时系统在下发时自动选 host + device。
26. 自动选机：平台、iOS 模拟器/真机、执行方式所需工具是**硬要求**；设备型号、系统版本是**软偏好**，用于同池排序，不满足也可降级。
27. 任务绑定到具体设备；设备在线时下发即预占租约，离线时保持 pending（不伪造租约），上线后再预占；同一设备同一时刻只执行一个任务；一台执行机按空闲设备数并行。
28. 自动选中的设备掉线或超时未领取 → 释放回池重选；用户只指定 host → 保留 host、重选该 host 上的设备；用户指定 host + serial → 保留 host/serial 等该设备回归，保持 pending 并告警，不静默改派（显式取消/改派除外）。
29. 执行机心跳必须上报设备型号与系统版本；没有这两项时只能按平台/设备类型匹配，软偏好不可用。

### 1.3 非目标（第一版不做）

- 原生代码脚本（Espresso / XCUITest）生成与编译；第一版只有 Maestro 黑盒脚本。
- 设备、执行机、存储、带宽、平台服务费计费。
- 多币种客户账单；第一版只出人民币账单。
- 客户自助门户/客户登录；第一版由内部管理员出账、导出账单。
- 厂商账单 API 自动对接；第一版由管理员录入厂商账单金额做对账。
- 自动修复因 UI 改版而失效的脚本；第一版标记过期并要求重新生成/发现。
- Excel 公式、合并单元格、图表、宏的完整语义支持；遇到即显式拒绝该行/该文件并给指引。

### 1.4 反目标

- 脚本/执行结果覆盖人工填写的 Excel 单元格。
- 把“token × 单价”直接称为厂商实付；必须区分“计算金额”和“厂商账单”。
- 第二份 Excel 事实源（例如另建一份 JSON 让用户维护）。
- 静默跳过无法解析的行、无法定位的元素、无法执行的用例。
- 用一个全局 key 却宣称能拿到厂商级逐项目/逐任务实付。

## 2. 角色与权限

沿用现有 HTTP 用户/角色（viewer / dispatcher / maintainer / admin）：

| 动作 | viewer | dispatcher | maintainer | admin |
|---|---|---|---|---|
| 查看项目、任务、结果、账单 | ✓ | ✓ | ✓ | ✓ |
| 新增/归档项目 |  |  |  | ✓ |
| 上传/删除测试资产（Excel/资料/安装包） |  |  | ✓ | ✓ |
| 生成/删除脚本 |  |  | ✓ | ✓ |
| 下发/取消测试任务 |  | ✓ | ✓ | ✓ |
| 维护价格表/加成/汇率 |  |  |  | ✓ |
| 创建/关闭账期、出账、对账调整 |  |  |  | ✓ |

- 项目创建时记录 `owner`（管理员）与可选的客户名称；第一版不做客户账号。
- 所有写动作沿用现有 `X-AOS-Console` 校验、审计与角色 scope；新增动作注册到 panel action scope。

## 3. 用户旅程

### 3.1 管理员新增项目

1. 打开「项目」→「新增项目」。
2. 填：项目名称（全局唯一）、平台（Android/iOS/两者）、应用包名或 Bundle ID、客户名称（可选）、账期配置（起止日期、币种固定 CNY）。
3. 系统校验名称唯一与合法字符，创建 `<workspace>/<slug>/`、生成 `.artemis/` 与最小 `aos.config.jsonc`，登记 project 行。
4. 项目详情页出现「测试资产 / 测试任务 / 脚本 / 结果 / 计费」入口。

### 3.2 维护人员准备资产

1. 上传任意 `.xlsx`，系统预览表头。
2. 映射列：必填「用例编号」「步骤」；可选「名称」「预期」「前置」「模块」「优先级」「testID」「测试数据」。
3. 保存映射（按项目 + 表头指纹），校验重复用例编号（保留第一条，拒绝后续行并报告）。
4. 重新上传“下载的工作副本”时，检测 `建议｜`/`执行｜` 系统列并让上传者显式选择：**继承系统格**（与上一版本 journal 终态逐格比对，一致才重播种为系统格、可刷新；不一致或未选则冻结）或**作为人工内容**（全部冻结）。默认“作为人工内容”，预览显示将冻结的格数；不得静默把旧结果当人工内容。
5. 上传测试资料：键值对 + 附件；敏感项标记为 secret。
6. 上传 APK/IPA；系统解析包名、版本名、版本号/build、文件 sha256。
7. 可引用项目历史 Excel/资料/安装包版本，不重复上传。

### 3.3 生成脚本

1. 选择 Excel 版本 + 安装包版本 + 平台。
2. 系统基于映射字段生成**草稿 Maestro 脚本**（文本定位优先）。
3. 若执行机可用，触发一次**发现执行**：安装包、按步骤执行、逐步抓 UI 层级，建立「元素文本 → testID」字典。
4. 用字典重写为正式脚本（`id:` 优先，`text:` 兜底）；未解析元素写入 Excel 建议列并标记未确认。
5. 保存不可变脚本集：版本号、源 Excel sha、包版本、选择器字典版本、脚本 sha、生成时间。
6. Excel/包/字典变化后脚本标记 `stale`，任务默认拒绝使用过期脚本，除非显式允许。

### 3.4 下发任务

1. 「下发」选择项目、平台、Excel 版本、测试资料版本、安装包版本、执行方式（Maestro / LLM）、用例范围（全部/按模块/按编号）、重试次数、优先级。
2. 执行机选择：自动（按硬要求过滤 + 型号/系统版本打分）或指定 host；指定 host 时可再指定具体设备（serial），也可让系统在该 host 上选。
3. 系统在下发时完成 host + device 选择并预占设备租约；指定模式校验设备归属、硬要求与空闲；自动模式无候选时任务保持 pending 并给出原因。自动任务绑定 `targetHostId + deviceSerial`；租约过期/机器失联时清空两者并回到全局池重选。指定 host（未钉设备）保留 `targetHostId`、只清空 `deviceSerial` 并在同一 host 上重选；指定 host + serial（`devicePinned=true`）保留两者，等待该设备回归，不改派。
4. 执行机按设备 worker 领取绑定给自己的任务；安装包、运行脚本或 LLM 任务；结果回写。
5. 面板显示任务状态、逐用例结果、设备/包/时间、证据；Excel 工作副本右侧空白列补充摘要。

### 3.5 出账

1. 管理员维护价格表/加成/汇率。
2. 项目到达账期结束日，系统提示可关账；管理员确认并处理 Checklist 后冻结用量、生成客户账单草稿（不自动关账）。
3. 管理员核对厂商账单，录入厂商账单金额与差异原因；系统生成对账调整项。
4. 确认后出账，账单可导出；已出账账期不再回改，迟到用量进入下一账期调整。

## 4. 领域模型

### 4.1 项目 Project

- `id`, `name`（显示名，全局唯一，NFKC + 大小写归一后唯一）, `slug`（目录名，ASCII 安全，冲突时追加短 hash）, `rootPath`, `platforms[]`, `appPackage`/`bundleId`, `customerName`, `owner`, `status`（active/archived）, `createdAt`.
- 现有 project 表扩展：`customer_name`, `billing_currency`（固定 CNY）, `archived_at`, `source`（`manual` / `mcp`）。

### 4.2 资产 AssetVersion 与 Excel 工作副本

- `id`, `projectId`, `kind`（`excel` | `materials` | `package`）, `version`, `filename`, `originalSha256`, `originalStoragePath`, `size`, `uploadedBy`, `createdAt`, `metadata`（包名/版本/平台/Excel 映射摘要）。
- **原件不可变**：上传原件进 CAS（`assets/<sha256>.xlsx`），供引用、重放、staleness、审计；新上传产生新版本。
- **Excel 工作副本是派生物**：`workbook/<assetVersionId>.xlsx`，系统可写；其 sha 变化**不影响**原件 sha、脚本 staleness、assetSnapshot 或 CAS。脚本/任务/映射一律挂 `assetVersionId` + 原件 sha。
- **runner 不以 Excel 为执行依据**：执行所需的 case set、taskDesc、脚本、测试资料由中心派生；runner CAS 只缓存 package 与**不含 secret** 的 materials 附件，不缓存 Excel 工作副本。含 secret 的 materials 每任务经 TLS 下发到 0600 job 目录、job 结束即删，不落 CAS。任务可携带 Excel **原件**只读快照供排查（不含中心写回的 8 列），执行与 staleness 一律以中心 case set/原件 sha 为准；runner 不解析该快照。
- **写回 journal**：每次写回记录 `jobId, assetVersionId, caseId, columnKey, cellRef, value, writtenAt, actor`，用于区分“系统写的格”和“人工写的格”（见 §5.2）。

### 4.2b Excel 写回 Journal

- `excel_writeback_journal`：`id`, `assetVersionId`, `jobId`, `caseId`, `columnKey`（8 列之一）, `cellRef`（如 `H12`）, `value`, `writtenAt`, `actor`。
- 只追加，不更新历史；同一单元格保留最后一次系统写入记录，用于判断是否被人工改过。
- **两阶段写**：写格前先追加 `status=pending` 的 journal 行 → 写单元格 → 置 `confirmed`。崩溃恢复扫描 `pending` 行：单元格值 === 记录值 → confirm；否则按系统格重写/补写。`allowClearedRefresh` 只对 `confirmed` 行生效，避免把崩溃窗口误判为人工格。
- journal 不进入原件 CAS；它是工作副本的审计与刷新依据。

### 4.3 Excel 映射 ExcelMapping

- `id`, `projectId`, `assetVersionId`, `sheetName`, `headerFingerprint`, `columnMap`（canonical field → column index/header）, `createdBy`, `createdAt`.
- 映射基于**原件**，不基于工作副本；系统追加的 `建议｜`/`执行｜` 列不参与映射。
- `headerFingerprint` 不是原始表头哈希，而是**语义指纹**：必填列 `caseId`/`steps` 是否存在 + 核心列名别名/模糊匹配结果 + sheet 名。列顺序调整、错别字（仍能匹配别名）不要求重新映射；匹配不确定时 UI 提示确认，不静默套用。
- 复用规则：同项目 + 同语义指纹自动建议上次映射；用户可覆盖并保存新映射。

### 4.4 测试资料 MaterialsVersion

- 键值对列表：`key`, `value`, `secret`（bool）, `description`；附件走 AssetVersion。
- 敏感值加密存储（主机密钥或项目 secret store），面板掩码，日志不落明文；执行时注入环境变量。

### 4.5 脚本集 ScriptSet

- `id`, `projectId`, `version`, `sourceExcelAssetId`, `packageAssetId`, `selectorDictId`, `platform`, `flows[]`（caseId → 文件路径）, `sha256`, `status`（draft/ready/stale）, `generatedBy`, `createdAt`。
- 脚本文件存放 `<project>/.artemis/web/scripts/<scriptSetId>/...`。

### 4.6 选择器字典 SelectorDictionary

- `id`, `projectId`, `packageName`, `packageVersion`, `platform`, `entries[]`（text/accessibility label → `id`/`accessibilityId`, screen, confidence, source）, `createdAt`。
- 发现执行产生；按包版本隔离。

### 4.7 测试任务 TestJob

- 复用现有 `regression_tasks` 队列与 runner 生命周期；新增 `job_spec` JSON 列（nullable，旧任务不受影响）。
- `job_spec.kind` 包含 `web-test` 与 `web-discovery`；发现执行复用同一队列、租约、心跳、超时与取消，不另建生命周期。
- `job_spec`：

```json
{
  "kind": "web-test",
  "assignment": "manual" | "auto",
  "devicePinned": false,
  "targetHostId": "...",
  "deviceSerial": "...",
  "requirements": {
    "platform": "android" | "ios",
    "deviceKind": "device" | "simulator" | "any",
    "deviceModel": ["iPhone 15"],
    "osVersion": { "min": "17.0", "max": null },
    "tools": ["maestro"]
  },
  "deviceLeaseId": "...",
  "excelAssetId": "...",
  "materialsAssetId": "...",
  "packageAssetId": "...",
  "scriptSetId": "...",
  "executionMode": "maestro" | "llm",
  "caseFilter": { "modules": [], "caseIds": [] },
  "retry": 1,
  "allowStaleScript": false,
  "allowPartialUnresolved": false,
  "assetSnapshot": [
    { "kind": "excel", "id": "...", "sha256": "...", "filename": "..." },
    { "kind": "package", "id": "...", "sha256": "...", "filename": "..." },
    { "kind": "materials", "id": "...", "sha256": "..." }
  ]
}
```

- 现有 `refs`/`platforms`/`priority`/`targetHostId` 继续使用；`refs` 指向由 Excel 生成的内部 case set，保证现有 runner/报表兼容。
- `assignment=manual` 时 `targetHostId` 必填，`deviceSerial` 可空（空表示在该 host 上按硬要求/软偏好选设备）；`assignment=auto` 时两者由系统在下发时写入。`devicePinned=true` 表示用户钉住 `deviceSerial`：失联时保留 host/serial 等待，不改派；`devicePinned=false` 的 manual 任务只钉 host，失联时只清 serial 并在同 host 重选。
- `requirements.platform`、`requirements.deviceKind`（非 `any` 时）、`requirements.tools` 是硬过滤；`deviceModel`/`osVersion` 是软偏好，仅用于同池排序。
- `deviceLeaseId` 指向下发时创建的预占租约；现有 `device_leases` 主键是 `(host_id, serial)`，因此取 `"<hostId>:<serial>"`；runner 领取后转为执行租约，任务取消/超时/失联时释放。
- `assetSnapshot` 在创建任务时冗余写入 sha256/filename/包名/版本，防止资产后续被归档/删除导致结果无法溯源。Excel 快照只能是 CAS 原件（不含 8 列写回），仅排查用；执行以中心派生的 case set/taskDesc 为准（见 §4.2）。
- `allowPartialUnresolved` 默认 false；true 时跳过 `unresolved` 用例，Excel 写 `SKIP（脚本未就绪）`，任务状态为 `partial` 而非 PASS/FAIL。
- `scriptSetId` 在 `executionMode=llm` 或 `web-discovery` 时可为 null；Maestro 模式必须非空。
- `job_spec.kind=web-discovery` 的最小形状：`{ kind:"web-discovery", assignment, devicePinned, targetHostId, deviceSerial, requirements, excelAssetId, packageAssetId, baseSelectorDictId?, resumeFromStep? }`；它不产出 TestJobResult，只产出 SelectorDictionary/`partial-discovery`；重试新建 job 并继承 `baseSelectorDictId`。

### 4.8 任务结果 TestJobResult

- 任务级：`jobId`, `projectId`, `mode`, `scriptSetId`, `excelAssetId`, `packageAssetId`, `assetSnapshot[]`, `runnerHostId`, `deviceSerial`, `deviceModel`, `deviceOsVersion`, `packageName`, `packageVersion`, `packageBuild`, `packageFilename`, `startedAt`, `finishedAt`, `durationMs`, `status`, `gate`, `tokenCost`, `traceIds[]`。
- 用例级：`caseId`, `caseName`, `status`（PASS/FAIL/SKIP/ERROR）, `startedAt`, `finishedAt`, `durationMs`, `failureStep`, `failureReason`, `failureDomain`, `screenshotPaths[]`, `stepLogPath`, `deviceLogPath`, `traceId`, `tokenUsage`, `cost`.
- 详细记录落 `.artemis/web/results/<jobId>/...`（JSON + screenshots + logs），DB/manifest 存索引与摘要。

### 4.9 计费

- `llm_usage_events`：`id`, `projectId`, `jobId`, `caseId`, `traceId`, `provider`, `model`, `purpose`（generation/discovery/execution/analysis/jira/retry/healing/other）, `promptTokens`, `completionTokens`, `cacheCreateTokens`, `cacheReadTokens`, `usageSource`（provider/estimate）, `vendorCurrency`, `vendorInputPrice`, `vendorOutputPrice`, `vendorCacheCreatePrice`, `vendorCacheReadPrice`, `fxRate`, `fxSource`, `fxAt`, `costCny`, `markupRate`, `customerAmountCny`, `priceBookVersion`, `at`.
- `price_book_entries`：`provider`, `model`, `currency`, `inputPer1M`, `outputPer1M`, `cacheCreatePer1M`, `cacheReadPer1M`, `markupRate`, `effectiveFrom`, `effectiveTo`, `version`, `updatedBy`, `updatedAt`。厂商不支持缓存计费时字段留空，计费按普通输入价并在账单标注。
- `fx_rates`：`currency`, `rateToCny`, `source`, `fetchedAt`, `effectiveAt`.
- `billing_periods`：`id`, `projectId`, `startDate`, `endDate`, `status`（open/closed）, `closedAt`, `closedBy`, `invoiceId`.
- `invoices`：`id`, `projectId`, `periodId`, `number`, `currency`（CNY）, `subtotal`, `adjustments`, `total`, `status`（draft/issued/void）, `issuedAt`, `dueAt`, `notes`.
- `invoice_lines`：项目/任务/模型/purpose 维度汇总、token、成本、加成、客户金额。
- `billing_adjustments`：`invoiceId`/`periodId`, `projectId?`（null＝全局）, `vendor`, `vendorInvoiceAmount`, `vendorCurrency`, `fxRate`, `deltaCny`, `reason`, `createdBy`。
- `vendor_invoices`（全局，不挂单一项目）：`id`, `vendor`, `periodStart`, `periodEnd`, `invoiceNumber`, `amount`, `currency`, `fxRate`, `fxAt`, `enteredBy`, `enteredAt`, `note`。一个厂商账单可覆盖多个项目；**第一版不做自动按比例分摊**：项目账单只保留计算金额，不摊入厂商差异；差额记全局 `billing_adjustments(projectId=null)` 展示。管理员若要把差额落到某项目，必须手工录入带 `projectId` 的调整项和原因，系统不按比例静默分配。

## 5. Excel 合同与写回

### 5.1 解析

- 只收 `.xlsx`；第一版只读用户选定的一个 sheet；合并单元格、公式、宏、图表区域显式拒绝或标记不可映射。
- 表头行默认第一行；允许用户指定表头行。
- 映射字段（canonical）：
  - 必填：`caseId`（用例编号）, `steps`（步骤）
  - 可选：`name`, `expected`, `preconditions`, `module`, `priority`, `testData`, `testId`
- 表头别名：沿用现有导入器的中英别名表，并允许用户手动映射。
- 重复 `caseId`：保留第一条，后续行拒绝并报告行号；文件其余行继续导入。
- 空 `caseId` / 空 `steps`：该行拒绝并报告；不静默跳过。

### 5.2 写回

- 权威文件为上传后的**工作副本**（项目资产存储内）；系统可写副本，但只允许：
  - **testcase_id 锚定**：先定位映射到 `caseId` 的「用例编号」列；从该列向右，只在**表头行**扫描到最后一个非空表头，系统列从它右侧追加。不按整表最后一个非空单元格定位，避免 Z 列孤立数据导致 A–Y 空白断层；testcase_id 左侧的列不参与定位。
  - 如果 testcase_id 右侧存在“只有数据、没有表头”的列，视为人工游离内容，不参与表头定位；系统列不会覆盖它，必要时在预览中提示。
  - 在对应 `caseId` 行的空白单元格写值；系统格允许按 journal 规则刷新（见下）；
  - 列头带 `建议｜` 或 `执行｜` 前缀与系统标记；
  - 合并单元格、公式单元格一律跳过并记录；如果锚定出的系统列与合并区重叠，拒绝写回并提示，不强行拆合并。
- **系统格 vs 人工格（K2）**：以 `excel_writeback_journal` 判定，不依赖单元格颜色/批注：
  - 当前值 === journal 最后一次系统写入值 → 系统格未被人工修改，允许刷新（重跑覆盖旧结果、重生成覆盖旧脚本路径）；
  - 当前值 !== journal 记录值，或非空且不在 journal → 人工格，**永不覆盖**，记审计事件；
  - 空且无 journal → 可写；
  - 人工清空一个系统格 → 默认视为人工修改并冻结，不自动回填；提供显式「清除并允许回填」动作（journal 记 `manual-clear-refresh` 或任务参数 `allowClearedRefresh`），只有该动作才允许下一次系统写入。**不能**因为单元格为空就自动解冻，否则用户无法通过清空表达“冻结旧结果”。
- **人工编辑入口**：工作副本的“人工格”来自下载后重上传（§3.2.4 的 inherit/human 选择）或运维直接编辑文件；“清除并允许回填”是 maintainer/admin 在面板对已确认系统格的显式动作并写审计。第一版不为普通用户做单元格编辑器。
- **单一写者**：Excel 写回只在中心服务执行，远程 runner 不回写文件；中心按项目 + 工作副本加文件锁（单进程队列 + 跨进程锁；多实例用 PG advisory lock），串行合并，避免并发覆盖。
- 写回幂等：先按表头标记查找系统列；存在则按 `caseId` + journal 规则更新，不存在才追加；重复执行/重复任务不会重复堆列。
- **写回失败**：结果仍保存在详细结果/面板，工作副本标记 `writeback-failed`，提供重试与错误原因；不能把“Excel 没写成功”当成任务成功。
- **交付物**：客户交付定义为该 assetVersion 的**最新工作副本**；面板同时提供原件与每个版本的工作副本下载、lineage（原件 sha、写回 job、最后写回时间）。
- **staleness**：按原件 sha 判断；写回工作副本不改变原件 sha，不触发脚本 stale。新 Excel 版本上传后，脚本需重新生成。
- 追加列固定 8 列，顺序：

| 列 | 内容 |
|---|---|
| `建议｜脚本文件` | 脚本相对路径 + 用例函数名；LLM 模式为 `n/a（LLM 执行）`，iOS 真机为 `n/a（iOS 真机走 LLM）` |
| `建议｜关键预期` | 原 `expected` 列为空时才写；来源为 steps（以及项目 `acceptance.json` 若存在；Excel 无验收列）的 LLM 摘要，标 `inferred`；不臆造设计文档内容 |
| `执行｜结果` | PASS / FAIL / SKIP / ERROR |
| `执行｜设备与系统` | serial + 型号 + 系统版本 |
| `执行｜安装包` | 文件名 + 包名/Bundle ID + 版本名 + build/versionCode |
| `执行｜开始时间` | ISO 8601 带时区偏移（如 `2026-10-28T13:00:12+08:00`） |
| `执行｜结束时间` | ISO 8601 带时区偏移 |
| `执行｜traceId` | 执行证据 trace |

- 列定位：按表头标记查找已有系统列；没有则按 §5.2 的 testcase_id 锚定追加。重复生成复用列，不重复堆叠。
- 新 Excel 版本上传后，系统按 `caseId` 重新定位并写空白格；旧版本结果仍保留在详细结果与面板中。

## 6. 脚本生成（Maestro）

### 6.1 单位

- 每个用例生成一个 Maestro flow 文件：`flows/<caseId>.yaml`，`appId` 来自项目包名/Bundle ID，`tags` 含 caseId。
- **用例隔离**：默认每个 flow 先 `launchApp` 并清空应用状态（`clearState: true`），不继承上一用例状态；任务可显式 `preserveAppState: true` 关闭。`preconditions` 转为 setup 步骤（登录类前置使用测试资料占位符），不满足时该用例失败并标注前置失败，不静默跳过。
- 测试资料通过 `-e key=value` 注入，脚本使用 `${key}`；secret 不写入脚本文件。Maestro 进程参数/调试输出/截图中的 secret 由 §10 的注入与 redaction 规则处理。
- 步骤到动作的转换由受控 LLM + 规则完成；输出必须是合法 Maestro 命令白名单（`launchApp`, `tapOn`, `inputText`, `assertVisible`, `assertNotVisible`, `scroll`, `swipe`, `back`, `waitForAnimationToEnd`, `takeScreenshot`）。
- 无法可靠转换的步骤不猜：写入 `建议｜关键预期` 并在脚本清单标记 `unresolved`。任务默认阻止；下发时显式勾选“排除 unresolved 用例”可部分下发，未下发用例写 `执行｜结果 = SKIP（脚本未就绪）`，任务状态 `partial`。

### 6.2 testID 自动发现

- 第一遍草稿脚本用 `text:` 定位。
- 发现执行：在指定执行机上安装包，按步骤执行；每步后读取 UI 层级（Android uiautomator / iOS Appium 或等价层级源），把当前可见文本/标签与 `resource-id`/`accessibilityIdentifier` 对齐。
- 结果写入 SelectorDictionary；第二遍脚本使用 `id:`，文本作为 fallback。
- **同文本歧义**：同一屏出现多个相同文本时，字典保存多个候选并标 `ambiguous`；生成时用 Maestro `index`/几何位置/邻近元素消歧；无法唯一确定时该步进入 `unresolved`，不静默选第一个。
- 找不到的元素进入 `unresolved`，在 Excel 建议列标记，不伪造选择器。
- 发现执行需要**Maestro 可用设备**（Android 任意 / iOS 模拟器）、安装包、测试资料；没有这类设备时只能生成草稿脚本，状态 `draft`，不能下发发现/脚本模式任务。iOS 真机不属于发现设备。
- **超时与心跳**：发现执行有全局超时（默认 15 分钟，可配）与单步超时（默认 30 秒，可配）；执行期间写心跳与当前步号，设备租约按心跳续租；超时按失败结束，不无限占用设备。
- **部分结果保留**：超时/中断时保存已完成步骤的 SelectorDictionary，状态 `partial-discovery`，在 Excel/面板标记“发现中断于第 N 步”；不清空已发现结果。
- **重试语义**：每次「重试/继续发现」创建**新的 `web-discovery` job**（新 jobId、新租约），继承上一任务的 `selectorDictId`/字典版本；旧 job 保持 `partial-discovery` 终态，不原地复活。新 job 可从中断步继续（断点续传为可选增强），面板展示父子 job 关系。

### 6.3 ready 与断言口径

- `ready` 的定义是“每一步至少有一个可执行选择器”：`id:` 优先，`text:` 也接受；完全没有选择器才是 `unresolved`。不要求所有元素都有 testID，否则无 testID 的应用无法使用脚本模式。
- Excel 原有「预期」存在时，生成硬断言；缺失时由系统补的 `建议｜关键预期` 默认是**建议/软断言**，只报告不决定 PASS/FAIL；管理员可在任务上显式开启“把建议当硬断言”。
- 重试沿用现有 suite 约定：**首跑结果决定门禁**，重跑只用于 flaky 诊断，不把重跑转绿算作首跑通过。
- 部分下发：任务 `partial` 表示“有未执行用例”，不计 PASS；面板与账单分别显示执行/跳过/未就绪计数。
- **计费按阶段**：生成/发现阶段的 LLM 调用无论用例最终是否下发都计费（成本已发生）；执行阶段的 token 只按实际执行的用例计；跳过/未就绪用例不计**执行** token，但已发生的生成/发现 token 不回退。账单按 `purpose=generation`/`discovery`/`execution` 分列，避免把“未执行”误解为“未产生成本”。

### 6.4 版本与过期

- 脚本集不可变；CAS 后原件 sha 不会“原地变化”。`stale` 定义为：脚本集引用的 `sourceExcelAssetId` / `packageAssetId` / `selectorDictId` ≠ 项目该 kind 的**最新版本**；它只是“可重新生成”的提示，不是唯一硬闸。
- 任务下发的硬闸是**精确匹配**：`job_spec.excelAssetId === scriptSet.sourceExcelAssetId ∧ job_spec.packageAssetId === scriptSet.packageAssetId ∧ 字典按同包版本隔离`。不匹配直接拒绝并说明；历史版本只要与脚本集精确匹配即可重放，不因“不是最新”被误拒。
- `allowStaleScript` 只用于“明知有新版本、仍要用旧脚本”的显式场景；使用时在结果中标注。
- 脚本文件可下载、可在项目内查看 diff；系统不把脚本写回 Excel 已有列。

## 7. 执行

### 7.1 任务与执行机

- 复用现有 runner 队列、心跳、租约、取消、优先级；`job_spec.kind=web-test` 由 runner 分支处理。
- 现有 `runners` 行是项目级（`project_id` 必填于写入路径）；远程 web 任务不要求执行机预存项目，新增 **host-level `web_runners`** 注册表（hostId/instanceId/设备/工具/最后心跳），复用同一心跳、租约、取消语义，不改旧项目 runner。web job 仍复用 `regression_tasks`（新增 `job_spec`/`device_serial`/`device_lease_id`），领取走中心全局 `claimWebJob`，不按项目 `rootPath`。
- **远程分发**：中心保存项目与资产；任务 `job_spec` 带资产版本/脚本集与下载地址。执行机领取后：
  1. 在本地工作目录 `<runnerWorkDir>/<projectSlug>/<jobId>/` 下载测试资料、安装包、脚本集、**case set/taskDesc（中心派生）**；Excel 原件仅作可选排查快照（不解析）；
  2. 校验 sha256/包名/版本；
  3. 安装并执行；
  4. 把结果 JSON、JUnit、截图、日志通过中心鉴权 HTTP 上传（主路径）；LLM 模式还必须上传 `token_usage.json`（runner 从本地 `data_engine.db`/`status.json` 抽取的 per case/step token、model、traceId）以及 `data_engine.db`/`status.json` 原件作为计费审计工件。上传失败重试并把本地结果保留到成功回传，PG 只写索引/摘要，不把“仅本地留存”当成功。
- 执行机只要求：已注册 runner、平台工具（adb / simctl / Appium / Maestro / JDK）、可访问中心下载/上传端点；不要求预存项目目录。
- **资产 CAS 缓存**：runner 本地按 `sha256` 缓存**安装包与不含 secret 的 materials 附件**（`<runnerCache>/assets/<sha256>`）；下载前先查缓存并校验，命中则硬链接/软链接到 job 工作目录，未命中才下载。同一 APK/IPA 被多个任务引用时不重复下载。**含 secret 的 materials 不进 CAS**：每任务经 TLS 下发到 0600 job 目录，job 结束/失败都删除；清理策略不得把 secret 当普通缓存保留。
- **清理**：job 工作目录按 LRU + 磁盘水位清理（默认磁盘使用率 ≥80% 触发，保留最近 N 个 job），只删已成功回传的结果目录，**保留资产 CAS 缓存**；资产缓存自身按总容量上限淘汰。清理策略可配置，操作写日志。
- **下发即选机**（`src/panel`/`src/runner`）：
  - `assignment=manual`：用户指定 host；可选指定 serial。指定 serial 时必须属于该 host、满足硬要求、当前无有效租约；不指定 serial 时在该 host 上按硬要求过滤、按型号/系统版本打分选一台空闲设备。
  - `assignment=auto`：在全部在线 runner 上先按硬要求过滤，再按软偏好打分选 host + device；同分时优先最近最少使用，最后随机。
  - 硬要求：平台、`deviceKind`（非 `any` 时）、执行方式所需工具、设备在线且无租约；软偏好：设备型号、系统版本。
  - 选中后立即写入 `job_spec.targetHostId/deviceSerial` 并创建**预占租约**；任务取消、超时未领取或机器失联时释放。
  - 无候选 → 任务保持 `pending`，面板显示「等待满足要求的执行机/设备」；不报成功、不静默换机。
  - **组合硬校验**：`platform=ios ∧ deviceKind=device ∧ executionMode=maestro` 直接拒绝（iOS 真机只走 LLM/Appium）；Maestro 发现执行要求存在 Maestro 可用设备（Android 任意 / iOS 模拟器），没有则只能生成 draft，不能下发发现任务。
- **执行机能力上报**：`RunnerDevice` 在 `serial/name/platform/kind/state` 之外增加 `model`、`osVersion`（Android `getprop ro.product.model`/`ro.build.version.release`；iOS 模拟器 `simctl list -j` 的 device/runtime；iOS 真机 `devicectl`/`ideviceinfo`）。心跳同时上报 `tools`；缺少型号/版本时软偏好不可用，只按硬要求匹配。
- **设备级并行**：runner 为每台空闲设备维护一个 worker；一台机器可并行执行多个任务，数量不超过空闲设备数。领取与执行都以 `deviceSerial` 为粒度，`device_leases` 保证同一 serial 不会被两个任务同时占用。
- **中心队列领取**：远程 web 任务不要求执行机预存项目目录。选机阶段（auto/manual）已经写好 `targetHostId + deviceSerial`；领取阶段统一只按 `targetHostId + deviceSerial + 有效租约` 原子 claim，不再重复做选机/软偏好计算。领取时校验租约仍有效并转执行租约。
- **掉线与超时（回池机制）**：自动任务在 `lease TTL` 内未领取或目标 host 离线 → 释放 lease、清空 `targetHostId` 与 `deviceSerial`、状态回到 `pending`，由中心重新执行自动选机；`assignment` 保持 `auto`，记录 `reassignCount/原因`。`reassignCount` 上限 3；超过上限进入 `failed:无法稳定分配`（或退避 pending）并告警，不无限乒乓。用户只指定 host（`devicePinned=false`）→ 保留 `targetHostId`，清空 `deviceSerial`，在同一 host 上线后重选设备。用户指定 host + serial（`devicePinned=true`）→ 保留 `targetHostId + deviceSerial` 和预占，等该设备回归；保持 pending 并告警，不静默改派；用户可显式取消/改派。执行中失联按现有 runner 失联/任务回收规则处理。
- **领取二次校验**：runner 在 claim 成功后、执行前必须重新读取本地设备真实状态（`adb devices`/`simctl list`/Appium）；设备被占用、掉线或状态不符 → 不执行，向中心返回 `device-busy`/`device-unavailable`，释放 claim 与 lease，由中心按 auto/manual 规则回池或等待。心跳快照只用于选机，不能替代领取时的真实校验。
- **资产下发**：任务携带 `assetSnapshot` 的 sha256、文件名、包名/版本与下载地址；执行机按 sha256 校验后使用本地 CAS 缓存。Excel 若下载只能是 **CAS 原件**（不含中心写回的 8 列），仅作排查快照；runner 不解析 Excel、不缓存工作副本，执行以中心派生的 case set/taskDesc 为准。
- 安装：
  - Android：`adb -s <serial> install -r <apk>`；校验包名/版本与资产一致。
  - iOS 模拟器：`xcrun simctl install <udid> <app>`；真机：`xcrun devicectl device install app`（或现有 Appium/WDA 安装路径）。
  - 安装失败 → 任务失败，记录设备/包/错误，不执行脚本。
- 运行：
  - Maestro（Android / iOS 模拟器）：`maestro test --udid <serial> --format JUNIT --output <junit.xml> --debug-output <dir> flows/`；按 caseId 映射结果。
  - iOS 真机：走 Appium/AOS 现有执行器；第一版为 LLM 执行模式（不生成 Maestro 脚本），Excel 的 `建议｜脚本文件` 标记为 `n/a（iOS 真机走 LLM）`。
  - LLM（全平台）：复用现有 `mobile_run_task` / suite 执行，将 Excel 生成的 taskDesc 提交；token 从 ARTEMIS `data_engine.db` 汇总。
- 结果聚合：全部用例 PASS → 任务 PASS；任一 FAIL/ERROR → FAIL；SKIP 不计通过但单独计数；门禁口径在任务详情展示。
- 重试：每用例可配 0–2 次；首跑结果决定门禁，重跑只做 flaky 诊断并单独展示。

### 7.2 详细结果

- 每个用例保存：动作序列（步骤、目标元素、选择器、结果）、截图（成功/失败关键步）、设备日志、Maestro debug 输出、JUnit 原始文件、traceId。
- 任务详情页可下钻到用例、步骤、截图、日志；证据链接复用现有 `/panel/artifact`。
- Excel 8 列只放摘要，不替代详细结果。

## 8. 计费

### 8.1 Token 采集

- 本服务 LLM 调用：在 chat 封装层记录每次调用的 provider/model/prompt/completion/cache tokens 与上下文（project/job/case/purpose），写入 `llm_usage_events`。
- ARTEMIS 执行：**本地项目任务**任务终态读取 `<project>/.artemis/traces/data_engine.db` 的 `steps.extra_metadata.token_usage`，按 trace 汇总；模型取 `status.json.model`。**远程 runner 任务**由 runner 在终态抽取 `token_usage.json` 并连同 `data_engine.db`/`status.json` 回传，中心只读回传工件，不读 runner 本地路径；回传缺失则记 `token-unavailable` 并阻断关账。
- Maestro 执行：不产生 LLM token；若后续接入 AI 分析，单独记 `purpose=analysis`。
- **幂等**：每个事件带 `sourceEventId`（chat call id / `traceId:stepId` / jobId:purpose），DB 唯一键 `(projectId, sourceEventId, purpose)`，重读/重试使用 upsert；重复读取 data_engine.db 不重复计费。
- 生成、发现、LLM 执行、Jira、分析、重试、修复等所有 LLM 调用都计入；`usageSource=provider` 才可计费，`estimate` 只诊断。
- **阶段计费口径**：`generation`/`discovery` 调用无论用例最终是否下发都计费；`execution` 只计实际执行的用例；跳过/未就绪用例不产生 execution token，但已发生的 generation/discovery token 不回退。账单按 purpose 分列，不把“未执行”当成“零成本”。

### 8.2 价格与汇率

- 价格表按 `provider + model` 维护：输入/输出/**缓存创建**/**缓存读取**单价（每 1M token）、币种、加成率、生效时间、版本、修改人。
- 缓存 token 按厂商语义归一：`cache_creation_tokens`（缓存写入，通常更贵）与 `cache_read_tokens`（缓存命中，通常更便宜）分开记录与计价；不把两者合并成普通输入 token。厂商只返回 `cached_tokens` 时按该厂商规则映射并在事件上标注 `cache-unsupported/source`，不猜测。
- 每次调用保存当时的价格快照与加成率；后续调价不影响历史。
- 美元计价厂商：调用时抓取实时汇率（可配置汇率 API），保存 rate/source/time；失败时用最近成功汇率并显式标注 `fx-stale`，不静默用假汇率。汇率有短 TTL 缓存（默认 60 秒，可配），同一窗口内复用同一快照，避免每次调用打爆汇率 API。
- **价格缺失/补录**：调用时价格表无该模型 → 先保存 token + FX 快照，事件状态 `pricing-pending`，不按 0 计费；管理员补价格条目后执行“重算待定价”，按事件 `at` 落入补录条目的 `effectiveFrom/effectiveTo` 区间匹配价格（补录条目必须回溯覆盖事件时间；覆盖不到则保持 pending）。账期关闭前必须清零 pending。
- 成本与客户金额保留 4 位小数计算、账单展示 2 位小数；舍入只在最终展示发生一次；舍入规则写入价格表说明。

### 8.3 账期与账单

- 每个项目由管理员设置任意 `startDate`/`endDate`；同一项目账期不得重叠。创建/修改在事务内校验新区间与现有账期无交集（冲突 409）；PG 生产库可加 `EXCLUDE USING gist (project_id WITH =, daterange(start_date,end_date,'[]') WITH &&)` 约束加固，测试覆盖区间相交/相邻/跨年。
- 账期关闭后冻结用量；迟到事件进入下一账期调整项，不回改已出账单。
- 账单行按项目/任务/模型/用途汇总；显示 token、成本、加成、客户金额。
- 管理员录入厂商账单金额与差异原因，系统生成 `billing_adjustments`；客户账单总额以计算金额 + 显式调整为准。厂商账单默认只做全局差异展示，不自动分摊到项目；项目级差异必须由管理员手工录入并写原因。
- 第一版由管理员在页面上**手动触发账期关闭**（可在 endDate 前/后），系统可提示但不对未确认账期自动出账。
- 账期关闭前必须处理所有 `token-unavailable` / 估算标记：要么补录真实 token，要么显式记 0 并写明原因；否则不能关闭。估算 token 不计费，只作诊断。
- **关账 Checklist（硬门禁）**：关闭按钮列出阻塞项并要求逐项处理——未读取 token 的任务、`fx-stale` 汇率、未录入的厂商账单、未确认的价格表版本、仍在运行/未回传的任务、未处理的 `pricing-pending`（缺价）计费事件。全部处理后才可关账；管理员可显式“忽略并记 0”，必须填写原因并写审计。
- 账单号规则固定：`INV-<projectSlug>-<YYYYMMDD>-<seq>`，项目+账期内唯一；红冲生成新号并引用原账单。
- 关账时若 `purpose=other` 占比超过阈值（默认 10%），Checklist 提示管理员确认，避免未知用途悄悄进账单。
- 第一版不自动对接厂商账单 API；不做客户自助门户；账单支持页面查看与导出（CSV/XLSX）。

### 8.4 LLM 凭证与计费范围（第一版）

- 第一版：所有手动项目共用**平台统一 LLM 条目**（管理员在平台级配置 provider/model/key）；新项目不要求单独配置 key。
- 现有 MCP 项目继续使用各自条目的 key，默认不计入本平台客户账单（后续按 `source`/key 归属扩展）。
- 逐项目 key、客户自带 key、按 key 归属计费属于后续能力；数据模型预留 `llm_credential_scope` 与 `billable` 字段，不在第一版实现。
- 平台统一 key 的费用按项目/任务/调用归属，仍按 §8.1–§8.3 记录。

### 8.5 真实金额口径

- 公司统一付款、项目共用 key 时，项目/任务的金额是**按价格表计算的客户计费金额**，不是厂商逐项目实付。
- 厂商账单是账期级真实金额；对账差异单独记录，不悄悄摊入项目。
- 若未来要求厂商级逐项目实付，需项目独立 key/子账号；本设计不承诺。

## 9. 网页与接口

### 9.1 页面（扩展现有 panel）

- **项目**：新增项目、项目详情、归档；显示平台/包名/客户/账期。
- **测试资产**：Excel 版本与映射、测试资料、安装包版本；上传/引用/下载。
- **脚本**：脚本集列表、生成/重新发现、状态（draft/ready/stale）、下载。
- **下发**：基于现有下发向导扩展，选择项目/资产版本/执行方式/用例范围；执行机可选「自动」或指定 host，指定 host 后可再选具体设备（也可让系统选）；型号/系统版本作为软偏好展示匹配分。
- **结果**：任务列表、任务详情、逐用例/步骤/截图/日志/Excel 摘要。
- **计费**（admin）：价格表、加成、汇率、账期、账单、对账调整。
- 现有「用例库」「档案」「运维」「使用统计」保持；新页面可挂到现有导航或项目详情内。

### 9.2 API（草案）

- `POST /panel/api/projects` / `PATCH /panel/api/projects/:id` / `POST /panel/api/projects/:id/archive`
- `POST /panel/api/projects/:id/assets`（multipart：excel/materials/package）
- `POST /panel/api/projects/:id/excel-mappings` / `GET`
- `POST /panel/api/projects/:id/scripts/generate` / `POST .../discover`
- `GET /panel/api/hosts` / `GET /panel/api/hosts/:id/devices`（下发选机与选设备；含在线、工具、型号/系统版本、租约状态）
- `POST /panel/api/jobs`（创建测试任务，写 `job_spec`；body 含 `assignment`、`targetHostId?`、`deviceSerial?`、`requirements`）/ `POST /panel/api/jobs/:id/cancel`
- `GET /panel/api/jobs/:id`（结果/进度）
- `GET/POST /panel/api/billing/price-book`、`/billing/periods`、`/billing/invoices`、`/billing/adjustments`
- 全部走现有鉴权、角色 scope、`X-AOS-Console`、审计；上传大小/类型白名单。

## 10. 安全与审计

- 测试账号/密码：加密存储、面板掩码、日志与错误摘要不落明文；执行时通过 0600 临时 env 文件或等价安全通道注入，**不放在命令行参数**（`-e password=…` 会进 `ps`/进程日志），脚本文件不包含 secret，跑完删除临时文件。含 secret 的 materials **不进入 runner CAS 缓存**，只落 job 级 0600 临时目录，任务结束/失败都删除。
- LLM 模式：模型只看到 `{{secret:key}}` 占位符；执行器在 `inputText` 等设备动作前替换为真实值，prompt、taskDesc、status.json、data_engine.db 与 trace 不写明文。若某平台/工具链无法做到执行器侧替换，该任务禁止使用 secret 资料并显式报错，不降级为“把密码发给模型”。
- Maestro 模式：`--debug-output`、JUnit、截图、设备日志回传前按已知 secret 值做 redaction；包含密码输入的步骤截图标记敏感并从客户可见产物排除；验收用已知 secret 值 grep 全部产物，必须 0 命中。
- 上传：只允许 `.xlsx` / `.apk` / `.ipa` / 允许的资料类型；大小上限；sha256；路径不得逃逸项目目录。
- 项目名称/路径：禁止 `..`、路径分隔符、控制字符；目录由系统创建。
- 计费数据：价格表/账单修改全审计；已出账账单不可改，只能红冲/调整。
- 所有外部动作（新增项目、上传、生成、下发、取消、出账）写审计事件。

## 11. 失败与降级

- Excel 无法解析/列缺失/重复行：显式失败或按行拒绝，列出原因与行号；不部分静默导入。
- 脚本转换失败/元素未发现：标记 unresolved，不伪造选择器；任务默认阻止。
- 执行机无设备/安装失败/脚本失败：任务失败或待定状态明确，结果保留，可重试。
- 汇率不可用：使用最近汇率并标注 `fx-stale`，账单上可见。
- 价格表缺模型：保存 `pricing-pending` 并告警，不允许 0 元静默入账；补价后重算。
- ARTEMIS token 读取失败：记录 `token-unavailable`，账单标记待补，不按 0 计。
- Excel 写回失败：结果与详细证据仍保留，工作副本标记 `writeback-failed`，提供重试/错误原因，不把写回失败当任务成功。
- Excel 往返自检：写入前检测 drawings/images/comments/图表；写回后重新打开比对 cell 值与 OOXML parts，发现静默丢失即拒绝并指引改用“单独结果文件”，不交付损坏工作簿。
- 归档项目：禁止新增任务/上传/生成；允许关账、只读查看与导出。

## 12. 验收标准

1. 管理员能在网页新增一个全局唯一项目，系统创建托管目录与配置，旧 panel/runner 能识别。
2. 能上传任意 Excel，完成列映射；缺用例编号/步骤/重复行的报告准确；能引用历史 Excel。
3. 能上传 APK/IPA 与测试资料，解析包名/版本/build；敏感资料不落日志。
4. 能生成 Maestro 草稿脚本，经真实设备发现后生成带 `id:` 的正式脚本；无法解析的元素进入建议列。
5. 能下发任务到指定执行机，或自动选 host + device；可再指定具体设备；硬要求不满足时拒绝/保持 pending，软偏好只影响同池排序；同一设备不会被两个任务同时占用；自动选中掉线超时回池重选，用户指定则等待并告警。执行机安装包、执行脚本/LLM，并回传逐用例结果。
6. 结果详情包含设备型号、系统版本、包名/版本/文件名、开始/结束时间、trace、步骤/截图/日志。
7. Excel 工作副本以用例编号列为锚追加 8 列：只填空白格/未被人工改动的系统格；人工内容不被覆盖；重复生成不重复堆列；写回后原件 sha 不变、脚本不 stale。
8. LLM token 费用按项目/任务/模型/用途记录；价格表/加成/汇率快照正确；任意账期可冻结出账；厂商账单对账调整可见。
9. 权限、审计、上传限制、secret 掩码符合本设计；已知 secret 值 grep 全部产物 0 命中。
10. 失败路径（无设备、安装失败、脚本 unresolved、汇率缺失、写回失败）均有明确状态，不静默成功。
11. 计费事件幂等：重读 `data_engine.db`/重试 chat 不重复计费；`pricing-pending` 补价后可重算；关账 Checklist 覆盖 `token-unavailable`/`fx-stale`/未录厂商账单。
12. 写回后原件 sha 不变、脚本集不 stale；系统格可刷新、人工格冻结。
13. 远程 LLM 任务回传 `token_usage.json` 与 `data_engine.db`/`status.json` 计费工件；中心从回传工件采集 token，不依赖 runner 本地路径；缺失时 fail-loud 并阻断关账。

### 12.1 测试与 fixture 清单

- 选机/租约：硬要求过滤、型号/系统版本打分、auto 无候选 pending、manual 指定设备归属校验、同 serial 并发拒绝、预占超时释放、自动回池、手动等待告警、按设备并行、心跳型号/版本缺失降级。
- 计费数学：cache create/read 分价、fx-stale、`pricing-pending` 补价重算、4→2 舍入只发生一次、缺价拒绝、账期边界、幂等唯一键。
- Excel 写回：一次追加、只填空白、journal 刷新系统格、人工改后冻结、合并/公式跳过、幽灵列锚定、写回失败重试、往返 parts 自检。
- Secret 红线：LLM 占位符替换、Maestro env 文件注入、产物 grep 0 命中、密码步截图排除。
- 远程 LLM 计费：runner 回传 `token_usage.json` + `data_engine.db`/`status.json`；中心不读本地路径即可计费；缺失工件 → `token-unavailable` 并阻断关账；fake runner 不能只报 token 数字掩盖工件路径。
- 生成安全：Maestro 命令白名单校验器、Excel 不可信输入的注入用例、超长/空/重复行。
- 隔离：clearState + preconditions 生成 setup，加一个“顺序依赖”反例 fixture。
- 测试环境：SQL 用 pg-mem、fake runner/ARTEMIS，不打外网；超时/重试/清理水位默认值集中常量模块；DESIGN.md §13.x 记录承诺。

## 13. Builder-check 结论（已并入）

独立 builder-check 对照现有 panel/runner/队列/Excel/ARTEMIS 后提出的 7 个问题及处理：

| 问题 | 结论 |
|---|---|
| 部署与项目绑定 | **远程执行机**：中心存项目/资产；runner 按 job 下载资产到本地工作目录、执行、回传；项目不预存于执行机。 |
| iOS 真机与 Maestro | **混合**：Android + iOS 模拟器 Maestro；iOS 真机 Appium/AOS LLM 执行器；第一版 iOS 真机不生成 Maestro 脚本。 |
| LLM key 与计费范围 | 第一版**平台统一 LLM 条目**；现有 MCP 项目用各自 key、默认不计客户账单；逐项目 key 后续。 |
| 计费计量缺失/估算 | 只把**厂商返回的 token**作为计费依据；估算 token 只做诊断、不计费；账期关闭前必须处理 `token-unavailable`。 |
| ready / PASS 语义 | `id:` 或 `text:` 任一可用即 ready；系统补的预期默认软断言；首跑决定门禁，重跑只做 flaky。 |
| LLM 模式敏感信息 | 模型只看占位符；执行器在设备动作前替换；做不到就拒绝，不把密码发给模型。 |
| 厂商账单对账 | 新增**全局 `vendor_invoices`**（按厂商/账期）；项目账单是计算金额 + 显式调整；管理员手动关账。 |

## 14. 外部评审吸收记录

| 反馈 | 判断 | 处理 |
|---|---|---|
| Excel 幽灵列：整表最后非空列可能被 Z 列孤立内容拉远 | 成立，高风险 | 改为 **testcase_id 锚定**：以用例编号列为起点，只在表头行向右扫描最后一个非空表头；不扫整表。 |
| Excel 并发写回覆盖/锁冲突 | 成立，高风险 | **中心单一写者** + 文件锁/PG advisory lock + 幂等列复用；runner 不回写。 |
| APK/IPA 重复下载 | 成立，中高风险 | runner **sha256 CAS 缓存**，命中硬链接；只下未命中资产。 |
| 发现执行挂死占用设备 | 成立，中风险 | 全局 15 分钟/单步 30 秒超时、心跳、部分结果保存、`partial-discovery`。 |
| 缓存 token 合并计费不准确 | 成立，低风险但财务重要 | 拆分 `cacheCreateTokens`/`cacheReadTokens` 与对应单价，按厂商语义映射。 |
| TestJob 只存资产 ID，删除后无法溯源 | 成立 | `job_spec.assetSnapshot[]` + 结果冗余 sha256/filename/包名/版本。 |
| headerFingerprint 对列顺序/错别字过敏 | 成立 | 改为语义指纹（必填列 + 别名/模糊匹配 + sheet），允许确认复用。 |
| purpose 缺 retry/healing | 成立 | 枚举增加 `retry`/`healing`；首跑与重试成本分开。 |
| unresolved 用例卡死整个 Job | 成立 | 显式 `allowPartialUnresolved`，跳过写 `SKIP（脚本未就绪）`，任务 `partial`。 |
| runner 长期堆积结果/资产 | 成立 | job 目录 LRU + 磁盘水位清理；保留资产 CAS，删除前确认已回传。 |
| 关账误操作/未处理异常 | 成立 | UI 关账 Checklist 硬门禁 + 强制忽略需原因与审计。 |
| 模块顺序：Project/Asset/Excel → Script/Runner → Billing | 合理 | 作为实施计划的默认切分顺序。 |

### 14.1 第二轮评审（K/M/L）处理

**K（必须改）**

- **K1 资产身份矛盾**：接受。原件进 CAS 且不可变；Excel 工作副本是派生物；staleness/assetSnapshot/脚本引用挂原件 sha；runner 不缓存/不下载 Excel。见 §4.2、§4.2b。
- **K2 系统格冻结**：接受。用 `excel_writeback_journal` 区分系统格/人工格：系统格未被人工改过可刷新，人工格冻结；重跑可更新 Excel，人工批注永不覆盖。见 §5.2。

**M（计划必须有落点）**

- **M1 约束/幂等**：项目名 NFKC 唯一索引、账期不重叠、invoice number 唯一、`llm_usage_events` 唯一键与 upsert。见 §4.9、§8.1、§8.3。
- **M2 补价重算**：`pricing-pending` + 补价后重算；关账前清零。见 §8.2。
- **M3 Maestro secret**：禁命令行传 secret、0600 env 文件、产物 redaction、密码步截图排除、grep 0 命中验收。见 §10、§12.1。
- **M4 发现作业模型**：`job_spec.kind=web-discovery`，复用 regression_tasks 队列/租约/心跳/取消。见 §4.7、§6.2。
- **M5 同文本歧义**：字典多候选 + `ambiguous`，几何/index 消歧，消不了进 unresolved。见 §6.2。
- **M6 隔离与前置**：默认 `clearState`，preconditions 生成 setup，顺序依赖反例 fixture。见 §6.1、§12.1。
- **M7 测试计划**：金额 fixture、Excel 幂等 fixture、secret grep、生成白名单、pg-mem/fake、常量模块、DESIGN 记录。见 §12.1。

**L（并入）**

- L1 口径同步：§1.2.3/§12.7 已改 testcase_id 锚定；§3.5 改为“到期提示、管理员确认关账”。
- L2 合并单元格：锚定重叠时拒绝写回并提示。
- L3 交付物：最新工作副本 + 每版本下载/lineage。
- L4 写回失败：`writeback-failed` + 重试，不算任务成功。
- L5 exceljs 往返：检测 drawings/images/comments/图表 + 写回后 parts 自检，丢失则拒绝。
- L6 归档不变量：禁新增任务/上传/生成；可关账/只读/导出。
- L7 文档修正：§8.5/§8.4 顺序、预期来源、LLM 模式脚本列、ISO 时间、purpose=other 提示。
- L8 回传主路径：中心 HTTP 上传为主，失败重试并保留本地结果；PG 只存索引/摘要。fx TTL 60s；invoice number 规则固定。

**第三轮评审（实施前一致性检查）**

| 反馈 | 判断 | 处理 |
|---|---|---|
| 自动选机绑定 targetHostId 后无法“回池重选” | 成立 | auto 任务租约过期/失联时清空 `targetHostId + deviceSerial` 回全局池；manual 保留 host 只清 device；记录 reassignCount/原因。见 §3.4、§7.1。 |
| 部分下发的生成/发现 token 漏计 | 成立 | 按阶段计费：generation/discovery 无论是否下发都计费；execution 只计实际执行用例；SKIP 不产生 execution token。见 §6.3、§8.1。 |
| 人工清空系统格被永久冻结 | 部分成立（产品取舍） | 默认仍冻结（保留“清空=冻结”能力）；新增显式 `allowClearedRefresh`，只有显式动作才允许回填。见 §5.2。 |
| vendor_invoices 多项目分摊数学 | 成立 | 第一版不自动分摊；差额记全局 `billing_adjustments(projectId=null)`；项目级差异必须手工录入。见 §4.9、§8.3。 |
| 发现执行 retry 语义 | 成立 | 每次重试新建 `web-discovery` job（新 jobId/租约），继承 selectorDict 版本；旧 job 保持 partial-discovery。见 §6.2。 |
| 心跳与领取之间设备被占用 | 成立 | runner 领取后二次校验本地设备；device-busy/unavailable 释放 claim/lease 并回池/等待。见 §7.1。 |
| Excel 快照是原件还是工作副本 | 成立（澄清） | runner 只能下载 CAS 原件（不含 8 列），仅排查、不解析；工作副本只在中心。见 §4.2、§4.7。 |
| §1.2.7 “Maestro 覆盖 iOS”歧义 / §8.3 unresolved 计费术语 | 成立（措辞） | 改为“Android 与 iOS 模拟器”；计费清单改为 `pricing-pending`。 |
| K1 远程 LLM token 工件未回传 | 成立（必须修） | runner 回传 `token_usage.json` + `data_engine.db`/`status.json`；中心读回传工件，不读本地路径。见 §7.1、§8.1、§12.13。 |
| M1 手动 host+serial 失联被改派 | 成立（规范矛盾） | 新增 `devicePinned`：auto 清 host+serial；manual host 清 serial 重选；manual host+serial 保留等待。reassignCount 上限 3。见 §1.2.28、§3.4、§4.7、§7.1。 |
| M2 不可变资产下 stale 语义 | 成立 | stale 仅提示“非最新”；硬闸改为脚本集与任务资产精确匹配；历史版本可重放。见 §6.4。 |
| M3 secret materials 进 CAS | 成立（安全） | CAS 只缓存 package + 非 secret materials；secret 每任务 0600 临时文件、结束删除。见 §4.2、§7.1、§10。 |
| M4 重上传工作副本冻结旧结果 | 成立（主循环退化） | 上传时检测系统列，显式 inherit/human；inherit 逐格比对 journal 后重播种，默认 human。见 §3.2.4。 |
| M5 journal 与写格非原子 | 成立（崩溃窗口） | journal 两阶段 pending→confirmed + 恢复扫描；`allowClearedRefresh` 只对 confirmed。见 §4.2b、§5.2。 |
| L1–L8 措辞/边界 | 成立 | 领取统一按 targetHostId+serial；下载清单补 case set/taskDesc；补 web-discovery spec；ios 真机×Maestro 硬拒绝；pricing-pending 按事件时间匹配；人工格入口说明；账期事务校验；关键预期来源改 steps/acceptance。 |

## 15. 留给 builder 的实现选择

- Excel 读写库（`exceljs` 已在依赖中）、合并单元格/公式检测、drawings/images/comments 往返自检。
- Excel 写回锁的具体实现（单进程队列 + 文件锁 / PG advisory lock）与多实例部署下的锁粒度。
- testcase_id 右侧“只有数据没有表头”的游离列检测与提示文案（不参与定位，但不覆盖）。
- Maestro 发现执行的具体层级抓取方式（Android uiautomator / iOS Appium page source / Maestro 自身输出），以及如何逐步对齐；同文本多候选消歧策略。
- ARTEMIS `data_engine.db` 读取的时机与失败重试；是否按 step 还是 task 聚合；`sourceEventId` 生成规则。
- 现有 `regression_tasks` 队列扩展 `job_spec` 的具体字段、`web-discovery` 分支与 runner 回传主路径。
- 汇率 API 选型与 60 秒 TTL 缓存策略；fx-stale 判定。
- 账单导出格式与模板；invoice number 序列实现。
- 测试资料加密密钥管理（宿主 key / 项目 secret store）；Maestro secret env 文件/Wrapper 实现。
- 大体量 Excel/安装包的上传分片与 CAS 清理水位默认值。
- 各厂商 cache token 字段映射表（provider adapter）。
