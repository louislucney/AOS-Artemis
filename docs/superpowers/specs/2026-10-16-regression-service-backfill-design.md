# 回归服务 backfill 设计（回填扫描：从磁盘产物幂等重建登记）

> 2026-10-16 · 前置：P1–P3e 与 P2.x 加固已落地。本设计实现 spec §5.3「降级与回填」与 §8 遗留项「回填扫描命令形态」：**回填＝只读扫描命令**（从 case-sets/runs 产物**幂等重建登记**）。
> 状态：builder-check 复核后修订；实施计划另出。

## 1. 意图与背景

中心 PG 不可用时，生成/执行照常（产物落盘），登记降级到内存（如实标注）——**产物是事实源，登记可回填**（spec §5.3）。现状没有回填命令：漏登记的份/运行只能靠人去数据库补，或永远缺失。

产物形态（既有）：
| 产物 | 位置/形态 | 含登记所需维度 |
|------|-----------|----------------|
| 用例集归档 | `<configDir>/design/case-sets/<UTCstamp>_<功能>.{json,md,xlsx}`（一份功能段＝三件套同 basename） | 归档 JSON 含 `source`、`features`、`flows`（caseCount/screens 可算） |
| 批次清单（run manifest） | `<configDir>/design/runs/run-<UTCstamp>-<suffix>.json` | `runId/source/startedAt/finishedAt/summary/gate/failureDomains/cases(traceId/失败域/隔离/重试)/options.deviceSerial`；**缺** `caseSetId/featureKey/featureName/platform/appVersion/runner/regressionTaskId` |
| 触发上下文（generation） | 仅内存（`registrationFeatures`） | — |

两个缺口：① runs 回填缺血统/端维度（spec §5.8「缺 feature/端等维度，口径不齐」的同因）；② 无幂等重扫命令。

## 2. 范围

### 2.1 命令 `suite backfill [--dry-run] [--json] [--project <dir>] [--since <ISO>]`

- 只读扫描产物（**绝不改写磁盘任何文件**）；仅写 DB 登记；**幂等**（重复运行 skip 已登记）。
- 输出计数：`{ scanned: {runs, caseSets}, registered: {runs, caseSets}, wouldRegister: {runs, caseSets}, skipped, invalid, beforeSince, dryRun, warnings }`＋文本行；`--dry-run` 仅报告不写库（`registered` 恒 0、`wouldRegister`＝将登记数）。
- **登记下界（外部评审关键 1）**：默认 `--since`＝该项目 DB 中**最早登记时间**（`min(suite_runs.created_at, case_sets.created_at)`；全库为空 → 无下界并告警）；`finishedAt < since` 的 run 与 stamp `< since` 的归档**不登记**（计数 `beforeSince`）——防首跑把回归时代之前的全部历史清单导入（非目标自洽）。`--since <ISO>` 显式覆盖。
- **PG 守卫（外部评审关键 3）**：`store.kind !== "postgres"` → 报错 **exit 2**（提示配置中心 PG；沿用 `suite runner` 先例）——**禁止在降级内存库上产生「成功假象」**。

### 2.2 runs 回填（manifest → `suite_runs`/`suite_run_cases`）

- 扫描 `design/runs/*.json`（目录倒序、判别式读取：`invalid`/`newer` 计入 `invalid` 跳过）。
- **幂等键＝`manifest_path`**：新增 store 只读查询 `listRegisteredManifestPaths(rootPath): Promise<string[]>`（`SELECT manifest_path WHERE NOT NULL`）；路径已登记 → skip。
- 未登记 → 组装 `recordSuiteRun`：
  - 可得维度：`trigger = "cli"`（**与在线登记逐字一致**；manifest.source 的 run/loop 细分属清单自身语义，不写入登记列——Q2 修订）；状态/exitCode（`gate.exitCode`；`ok` 与 gate 一致）、计数（summary）、`failureDomains`、`cases`（caseId/name/status/traceId/failure/quarantined/retry.flaky→flaky 口径）、`manifestPath`、时间（startedAt/finishedAt）；`platform`＝`deviceSerial` 经 `platformOf` 分类（null 时兜底 `registration.platform`，再无 → `"unknown"`）。
  - **依赖 manifest 扩展段**（2.4）：`caseSetId/featureKey/featureName/runner/regressionTaskId`——有则填、无则 `null` **如实标注**（面板/统计按既有口径：feature 为 null 的运行不进份血统聚合）；`appVersion` **无写侧来源 → 恒 null（字段保留）**（复核 I1）。
- `suite_run_cases.featureKey` 取扩展段 featureKey（无 → null）。
- **路径形态（外部评审关键 2）**：`manifestPath` 在线与回填均写**同一绝对路径**（`saveRunManifest` 返回 / `loadRunManifest` 的 `read.file` 原样取用）；**不做 resolve/归一/相对化**——逐字节一致是幂等键成立的前提。
- **DB 级幂等（外部评审关键 2）**：迁移新增**部分唯一索引** `CREATE UNIQUE INDEX IF NOT EXISTS suite_runs_project_manifest_idx ON suite_runs(project_id, manifest_path) WHERE manifest_path IS NOT NULL`；回填插入命中 `23505` → 按已登记处理（skip 计数）；在线登记路径维持 best-effort（极端并发下告警但索引保证无重复行）。**实现选定**：部分索引为主选；若 pg-mem 不支持该语法，回退普通唯一索引 `(project_id, manifest_path)`（依赖 NULL 互异语义），取可实现者并以「迁移＋多条 null 行」测试锁定、报告声明。
- **引用路径桥（外部评审中 4）**：`registration` 增 `caseSetJsonPath?`/`testsPath?`（保存时点本就可得——写侧零时序变化）；回填读侧以**路径**匹配已登记归档的 `features[].jsonPath` → **重映射 `caseSetId` 并补 `featureKey/featureName`**（同源恢复；匹配不到 → 原样保留旧 id、不猜、不悬空扩面）。此机制同时消掉 D8 的 backlog（无需保存前解析 refs）。
- **登记 id 口径**：`suite_runs.id` 由 `recordSuiteRun` 生成（与在线一致）；`manifest.runId` 不复用、不落列；cases 经 `run_id` 关联新 id。**旧 `schemaVersion`** 按既有读取口径（ok）处理，无特殊分支。
- **口径声明（Q1）**：`suite run`/`suite loop` 默认路径在线登记本就 feature-null（refs 解析在登记后、且主 tests.json 不匹配）；manifest 扩展按「**保存时点可得即写**」——`run --task` 全可得维度、run/loop 写可得者（runner/deviceSerial/testsPath 等）。

### 2.3 case-sets 回填（归档 → `case_sets`/`case_set_features`）

- 扫描 `design/case-sets/*.json`（按 basename 排序）；**幂等键＝`features[].jsonPath`**（已登记集合＝`listCaseSets(rootPath)` 全量摊平 `jsonPath` 集合）；已登记 → skip。
- 未登记 → 读归档 JSON（失败 → `invalid` 跳过）：`recordCaseSet`：
  - `source`＝归档 `source`；`designName`＝**恒 null（归档不含该字段；复核 M4）**；`basename`＝**归档 stem**（`<stamp>_<功能>`；与在线登记（恒 `"tests"`）不同——basename 为展示项、非身份/聚合键，Q3 已核；口径注明）；`fingerprint`＝**该归档文件 sha256（crypto 直算；复核 M5）**（口径注明：与在线登记用的主 `tests.json` 指纹不同源——回填行以归档自身为准）。
  - `features`＝单条（本归档仅含一个功能段）：`key/name` 从归档 `features[0]`（缺失 → invalid 跳过）、`caseCount`＝`flows.length`（兜底 counts.flows）、`screens`＝**`flows[].screens` 摊平去重**（Q4：与在线 `group.screens` 可能不同——展示项、非聚合键，口径注明）、三路径＝同名 `.json/.md/.xlsx`（存在性校验，缺 md/xlsx 仍登记并告警）。
  - `createdAt`＝basename 前缀 UTCstamp 解析（`YYYYMMDDTHHMMSS`→ISO；不可解析 → 文件 mtime）。
- 一行/一归档（单 feature per row）——与在线登记「一次生成一行多 features」粒度不同，**语义等价可用**（`latestFeatureRefs`/对比键（份,功能）均以行内 feature 为准）；口径在 DESIGN 注明。

### 2.4 manifest 扩展（写侧，additive）

- `RunManifest` 增**可选** `registration?: { regressionTaskId?; caseSetId?; featureKey?; featureName?; platform?; appVersion?; runner?; caseSetJsonPath?; testsPath? }`（**不含 trigger**——source 已表达执行路径，登记列口径见 Q2；`caseSetJsonPath`/`testsPath` 为引用路径桥，见 §2.2）。
- 取值（保存时点可得即写）：`run --task`：`caseSetJsonPath = ref.jsonPath`（该引用归档路径）＋taskId/refs/device→platform/runner；`suite run`/`suite loop`：`testsPath = report.testsPath`（＝`--tests` 入参路径原样）＋runner/deviceSerial；`appVersion` 恒空（无来源）。
- **`schemaVersion` 不变**（可选字段、读侧宽容，符合 spec「runs 新字段向后兼容」）；`loadRunManifest` 既有判别式读取不改。

## 3. 非目标

- 修复**既有**任务/引用的历史 id（被降级丢掉的 caseSetId 无法复原；回填产生新 id）——文档注明。
- 历史（回归服务之前）run 清单回填（spec §5.8 冷启动声明不回填）与「按当前规则重算域」。
- 增量/常驻监视、文件监听、自动触发（人工命令）。
- 改写磁盘产物/补写缺失三件套；慢速深扫（regression 时代目录之外）。

## 4. 硬约束

- 测试口径：pg-mem/内存 store、临时目录+真实写产物夹具、不触网；测试跑 `dist/`。
- 相对导入 `.js`；代码英文、用户文案中文；默认不加注释。
- **只读产物**：命令对 `design/` 不写任何文件（dry-run 与实跑均如此）。
- 幂等：重复运行第二次全部 skip（计数断言）。
- 完工标准：`npm run build && npm test && npm run lint` 全绿；同步 DESIGN（新增 §13.117）＋ README（命令清单/回填段）＋ AGENTS.md（命令表）。

## 5. 关键决策（本次方案判断；可被否决/修订）

| # | 决策 | 理由 | 若否决的代价 |
|---|------|------|--------------|
| D1 | 载体＝**CLI `suite backfill`**（不挂面板/自动触发） | spec「只读扫描命令」；运维场景低频人工 | 若要自动回填，需新调度面 |
| D2 | runs 幂等键＝`manifest_path`；sets 幂等键＝`features[].jsonPath` | 两者均为登记行中已有的稳定磁盘锚点；无需新列 | 若改用 fingerprint 比对，需处理主文件重生成漂移 |
| D3 | manifest **additive 扩展 `registration?`**（写侧补维度；读侧宽容、不 bump 版本） | 否则未来回填的 runs 永远缺血统/端维度（口径不齐重演）；additive 符合既有兼容约定 | 若不做扩展，回填行 feature 恒 null、统计价值大减（需接受） |
| D4 | sets 回填**一行/归档（单 feature）** | 归档即单功能段；重生组跨功能分组需猜 stamp 边界 | 若要严格复刻原分组，需新索引文件（产物侧改动，超范围） |
| D5 | 缺维度**如实 null**、不猜（platform 除外——deviceSerial 可分类）；`invalid` 计数可见 | 不伪造数据（仓库硬口径） | 若要求「尽力猜」，产生不可信口径 |
| D6 | `fingerprint`＝归档自身 sha；`createdAt`＝basename stamp（兜底 mtime） | 磁盘为事实源；口径注明 | 若要复刻在线值，需要主 tests.json 历史（不存在） |
| D7 | 命令只处理 regression 产物目录（`design/runs`、`design/case-sets`） | 明确边界；历史/其它目录不回填（spec 冷启动口径） | 若要扩范围，另立 |
| D8 | **路径桥（修订）**：`registration` 增 `caseSetJsonPath/testsPath`；回填读侧按路径重映射 caseSetId 并补 feature 维度——「保存前解析 refs」backlog **消除**（写侧零时序变化、读侧解析） | 降级窗口内的引用悬空得以修复；且新版 run/loop 的 `--tests 归档` 路径也可恢复血统 | 若无路径字段（旧 manifest），引用保持旧 id（已有口径） |
| D9 | 回填 `trigger = "cli"`（与在线登记逐字一致）；`registration` 不含 trigger | 同列单一词汇；来源细分属 manifest.source 自身语义 | 若以「suite-run/suite-loop」作为长期 trigger 词汇，需在线侧一并迁移（另立） |
| D10 | **登记下界**：默认 `--since`＝项目最早登记时间（空库无下界＋告警）；`beforeSince` 计数；显式 `--since` 覆盖 | 防首跑导入回归时代之前的全部历史清单（非目标自洽） | 若取消下界，须论证历史 manifest 入库无害并改口径 |
| D11 | **DB 级幂等**：`suite_runs(project_id, manifest_path)` 部分唯一索引（NULL 除外）；回填 23505→按已登记；在线维持 best-effort | 应用层查重的并发窗口（双终端/与在线并发）→ 永久双行污染台账 | 若不建索引，需接受并发双行风险并可事后难察觉 |
| D12 | **PG 守卫**：`store.kind !== "postgres"` → exit 2（`suite runner` 先例） | 降级内存库上「成功假象」违反如实标注红线 | 若无守卫，用户会在 PG 未恢复时得到虚假 registered 数 |

## 6. 接口草案（细节留给计划）

- **store**：
  ```ts
  // ProjectStore 新增（只读）
  listRegisteredManifestPaths(rootPath: string): Promise<string[]>;   // SELECT manifest_path FROM suite_runs WHERE project_id=$1 AND manifest_path IS NOT NULL（**项目域过滤**，Q5；memory 同）
  getEarliestRegistrationCreatedAt(rootPath: string): Promise<{ runs: string | null; caseSets: string | null }>;
  // 两条 MIN(created_at) 查询（无行 → null；memory 摊平取 min）——供「默认 --since」判定
  ```
- **迁移**：MIGRATIONS 增部分唯一索引（D11；形态与回退见 §2.2）。
- **manifest**：`RunManifest` 增 `registration?: {...}`（§2.4）；保存调用点（suite-command 的 run/loop/run-task 三处）补上下文传参；`buildRunManifest` 增可选入参 `registration?: RunManifestRegistration`。
- **命令**：`suite-command.ts` 白名单/usage 增 `backfill`；实现模块建议 `src/tasks/backfill.ts`（纯逻辑可单测：`scanRuns/utils` 返回动作列表，命令层执行写库）；`--dry-run` 返回同一形状但 `registered=0` 且列出将登记项计数。
- **platform 分类**：复用 `platformOf`（`src/tasks/run-registry.js` 导出）。

## 7. 测试口径（映射，具体用例随计划）

| 面 | 覆盖点 |
|----|--------|
| store | `listRegisteredManifestPaths`（memory+pg-mem；含 null 过滤与项目隔离）；**迁移：部分唯一索引（或回退普通唯一索引）＋多条 `manifest_path IS NULL` 行共存** |
| runs 回填 | 临时目录写 2 份 manifest（含 registration 扩展/不含）＋既有 1 份已登记（**以真实在线登记路径预置**——`recordSuiteRun` 含 manifestPath）→ 回填登记 1、skip 1、invalid 1（坏 JSON）；登记行字段（计数/gate/平台分类/扩展维度/feature null 如实）；cases 行数/失败域/隔离；**重复运行第二次全 skip（幂等）**；**并发/重复插入命中 23505 → 按已登记 skip（追加直插同名 manifest_path 触发）**；dry-run 不写库 |
| since 下界 | 默认＝最早登记时间（预置 1 条新登记＋1 份远古 manifest → 远古进 `beforeSince`、不登记）；空库 → 无下界＋warning；`--since` 显式覆盖生效 |
| 路径桥 | manifest 带 `caseSetJsonPath`（指向未登记归档）＋归档未登记 → 先 sets 回填产生新 id → runs 回填**重映射新 id 且 featureKey/featureName 从归档恢复**；匹配不到 → 原样保留旧 id（不猜） |
| sets 回填 | 写 1 归档三件套（缺 xlsx 告警仍登记）＋1 已登记（预置 jsonPath）＋1 坏 JSON → 计数与字段（basename/fingerprint=sha/createdAt=stamp/features 单条/caseCount/screens）；幂等复跑 |
| manifest 扩展 | `suite run`（或最小调用点）保存的 manifest 含 `registration` 字段（有上下文时）；无上下文旧路径字段缺省；读侧（loadRunManifest）对有/无字段均 ok |
| 命令层 | usage 列出 `suite backfill`；`--json` 形状（含 `beforeSince`/`wouldRegister`）；`--project`/`--since` 生效；exit 0；`--dry-run` 文本标注；**内存 store → exit 2（PG 守卫）** |
| 回归 | `suite` 既有子命令与 manifest 既有测试不回归（schemaVersion/字段兼容） |

## 8. 留给实现/计划的（不阻塞）

- 模块划分（`src/tasks/backfill.ts` vs suite-command 内联）；扫描顺序与限流（无需）；输出文案；`features[0]` 缺失的 invalid 判定细节；md/xlsx 缺失告警形态。

## 9. builder-check 复核记录（2026-10-16）

独立 subagent（只读文档＋相关代码）提出 5 个实质问题，全部在文档内定案、无遗留待用户问题：

1. **run/loop 的 registration 维度与保存时序** → D8：保存时点可得即写（与在线登记保真等同）；「`--tests <归档>` 保存前解析 refs」列 backlog。§2.2 增口径声明。
2. **trigger 词汇冲突（在线恒 `"cli"`）** → D9：回填写 `"cli"` 与在线逐字一致；`registration` 去掉冗余的 trigger 字段。
3. **case_sets.basename 不对称（在线恒 `"tests"`）** → 回填写归档 stem；basename 为展示项、非身份/聚合键（复核已核代码），口径注明（§2.3）。
4. **screens 计算来源歧义** → §2.3：`flows[].screens` 摊平去重；展示项、与在线 `group.screens` 可能不同，口径注明。
5. **`listRegisteredManifestPaths` 未按项目域过滤** → §6：SQL 补 `project_id` 过滤（与 store 惯例一致）。

## 10. 外部复核评审批注（2026-10-16，逐条核实后处置）

| 评审点 | 核实结论 | 处置 |
|--------|----------|------|
| 关键 1：扫描无截止线（首跑导入全部历史清单，与非目标自相矛盾——`design/runs/` 早于回归服务存在且 schemaVersion 不变无法区分新旧） | 成立 | §2.1 增**登记下界**（D10）：默认＝项目最早登记时间（空库无下界＋告警）；`beforeSince` 计数；`--since` 覆盖 |
| 关键 2：幂等仅应用层（DB 无约束；双终端/与在线并发可产生永久双行）＋路径形态未声明 | 成立 | §2.2/§4 增**部分唯一索引**（D11）＋23505→已登记；**路径形态钉死**（同源绝对路径、不 resolve）；测试改为**以真实在线登记路径预置** |
| 关键 3：缺 PG 守卫（降级内存库上产出「成功假象」） | 成立 | §2.1 增**PG 守卫**（D12）：`store.kind !== "postgres"` → exit 2（`suite runner` 先例） |
| 中 4：降级窗口引用悬空；建议存 `caseSetJsonPath/testsPath` 并在读侧重映射（同时消 D8 backlog） | 成立且高价值 | D8 修订为**路径桥**：registration 增两路径字段（写侧零时序变化）；回填读侧按路径重映射 id 并补 feature 维度；匹配不到原样保留 |
| 中 5：`recordCaseSet` 需参数化（basename/fingerprint 两套值） | **误判**：输入接口本就含 `basename/fingerprint/designName/createdAt`（`src/db/types.ts` `RecordCaseSetInput`）——无需签名变化，两套值由调用方传入；计划已钉死取值 | 在计划中显式注明（无需改动接口） |
| 低优先：dry-run 输出形状 | 已在计划修订（`registered`/`wouldRegister` 拆分） | 无需再改 |
| 低优先：runs 回填的 `runId` 采用与 cases 关联 | 未见声明 | §2.2 增钉死：`id` 由 `recordSuiteRun` 生成；`manifest.runId` 不复用/不落列；cases 经新 id 关联 |
| 低优先：`older` schemaVersion 行为 | 未见声明 | §2.2 增：按既有读取口径（ok）处理，无特殊分支 |
| 低优先：D4 粒度致「生成次数」统计膨胀 | 已注口径 | 保留（消费侧提醒已在 D4 行） |
- 低优先（复核者自决，认可）：`features[0]` 缺失 → invalid；md/xlsx 缺失 → 告警仍登记；fingerprint=归档 sha；createdAt=stamp＋mtime 兜底；platform 以 deviceSerial 分类为主、registration.platform 为兜底。
