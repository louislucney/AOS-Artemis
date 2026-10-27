# 项目服务统一入口设计——CR / Jira 验证 / 回归（一条龙 + 双面数据）

> 2026-10-17 · 前置：五步流水线（figma/pen 提取、生成三件套、suite check/run）、Jira 工具（读取/评论/附件/证据回写）、回归服务（任务/runner/日程/报告）、usage 采集与生成反馈均已落地。
> 状态：brainstorm 定稿（用户旅程经多轮对话逐项确认）；builder-check＋外部评审（2026-10-17）均已逐条核实并入（§11）；实施计划另出。

## 1. 意图与背景

### 1.1 痛点与纠偏（用户要求归纳）

- 现状的错：五步流程的编排被做在 **MCP 之外的脚本层**（`scripts/design-to-test.mjs`、旧 `aos-call` 脚本编队（现 `scripts/mobile-testing-call.mjs`））——工具 schema 被复制到脚本层，已发生两次真实漂移 bug（`penPath` vs `path`、`vision` 字符串 vs boolean）；用户还要记旗标/退出码，方向反了。
- **用户要求**：MCP 本身提供便利、简单、易懂的服务——**人话入口、无脚本**；并且**要有数据支撑**，让**被测项目**与 **MCP 服务自身**都随使用演进完善。
- 真实场景：项目接入后，活不只有 CR——**Jira bug 修复验证**与**回归测试**同样常见；**第一次接入可能是任意一类**，可先后或叠加。

### 1.2 用户旅程（定稿画面）

- **首次**：来哪类活就配哪类前置（§4 矩阵），缺项由服务给"人话指引"；一次配好即记，后续不再问（pen 认证以**可复查状态**记录，不抄密钥）。
- **日常**：说人话 → 服务识别三类活之一 → 跑对应一条龙 → 人话总结＋产物路径；**信息不足先问不猜**（Jira 粗单一句话、回归范围说不清等）。

## 2. 名词

- **三类活**：CR（新/改设计→五步）｜Jira 验证（围绕工单）｜回归（重跑既有用例）。
- **项目档案**：项目级数据底座（设计血统、用例库、运行与证据、对账、裁决与 Jira 关联、趋势），所有活先读后写。
- **needs-setup / needs-info**：工具的结构化返回——"前置缺什么、怎么补" / "信息不够、要问什么"。

## 3. 范围（本设计）

1. 三个 MCP 一等流程工具：**`design_to_test`**（CR）、**`run_regression`**（回归，含 Excel 导入）、**`verify_jira_issue`**（Jira 验证）——schema 极简、前置内化、内部复用既有实现（**不 shell 到 CLI/脚本**）。
2. 档案读面：**`project_archive`**（只读摘要，供三流程共用与用户问询）。
3. **Excel 测试文档导入**（回归）：幂等、provenance 可追、进入用例库、可被套件跑/报告/证据复用。
4. 前置与提问协议：`needs-setup` / `needs-info` 形状化返回。
5. **脚本层退役**：`design-to-test.mjs` 职责全部迁入 `design_to_test`。

## 4. 非目标 / 反目标

- 不做黑盒"猜意图"总入口工具——识别在对话层（工具描述携带信号）。
- 不废除 `suite *` CLI（它是发动机、项目机 runner 与 CI 的接口；本轮只加"人话门面与编排层"）。
- 本轮不做：服务侧演进的全自动闭环与面板化（先人工周期汇总）；多 Jira workspace 并存；.xls 旧格式；非结构化设计图（无节点数据的截图）摄取；把五步再拆成用户可见的更多步骤。
- **反目标**：任何形式的"第二份 schema"（脚本/JSON 再编码工具入参）；错误悄跑（必须 needs-info 先问）。

## 5. 前置矩阵（定稿）

| 活 | 本流程前置（缺则 needs-setup，补齐即记） | 落点 |
|---|---|---|
| CR | Figma（项目 `.env` 的 `FIGMA_ACCESS_TOKEN`）**或** pen（认证一次；状态可复查即"记录"） | 项目 `.env` / pen 会话 |
| Jira 验证 | Jira token＋指定 workspace（站点＋工单项目） | 项目 `.env`（现有 Jira 契约） |
| 回归 | 测试文档：Excel 导入（进用例库）**或**一句话说明范围 | 项目档案（用例库） |
| **执行类**（⑤/回归/Jira 跑设备时） | **设备就绪**：真机已连接并授权、或模拟器已启动（iOS 真机另需 WDA 可达） | howTo：`scripts/adb-safe.mjs devices`／`doctor` 探活／iOS 18+ 隧道进程（`tunnel-creation`，需保持运行） |
| 三类共同 | **LLM 每次运行都要校验** | 现有条目机制（PG/`.env`） |

- **LLM 校验口径**：每次运行前对 active 条目做一次**最小真实调用**（chat ping，短超时；失败给出 `aos_configure`/`.env` 修复指引）；**不跨运行缓存"已校验"状态**；结果与耗时入日志。
- **pen"记录"口径**：记录的是**可复查状态**（运行时 `pen status` 复核；不新增状态存储、不抄密钥——避免双份凭据）。复核（子进程）发生在**流程工具首步**；`project_archive` 只做静态展示并标注"未复核"（见 D14）。
- **device 缺省策略**：唯一在线设备→自动选用并在响应回显；无设备→needs-setup（执行类前置）；多设备→needs-info（列出候选让你选）。

## 6. 关键决策（本次方案判断；可被否决/修订）

- **D1 识别在对话层**：三类活的信号写入各工具描述（设计引用→CR；Jira 单号→验证；回归意图→回归；无信号且无用例→提问）。无黑盒路由工具。
- **D2 三个一等工具＋一个只读档案面**：名字 `design_to_test` / `run_regression` / `verify_jira_issue` / `project_archive`（命名可在计划微调）。
- **D3 前置内化**：每个流程工具第一步自查本流程前置；缺失→`{ ok:false, needs:"setup", target, missing[], howTo[] }`（**非 isError**——这是预期状态而非错误）。
- **D4 needs-info 协议**：信息不足→`{ ok:false, needs:"info", questions[], context[] }`，由对话层转问用户；**绝不带猜测开跑**。
- **D5 Excel 导入——形态＝一等 case-set（登记进用例库）**：只收 `.xlsx`（`.xls` 明确拒绝＋转换指引）；首工作表；表头自动识别（用例名/步骤/预期/前置/模块等中英别名）＋`columns` 覆盖。**按模块拆分归档**：每个模块一份标准三件套 `<UTCstamp>_<模块名>.{json,md,xlsx}`（落入既有 `case-sets/`，md/xlsx 由最小渲染器同批补齐以满登记 NOT NULL）＋**源文件副本仅一份**（`<UTCstamp>_<源文件名>.source.xlsx`，各模块登记 provenance 指向同一副本）；JSON 保持 tests.json（flows[]）兼容形态，现有执行链可直接加载。**登记 PG `case_sets/case_set_features`**：`source=imported:<文件名>@<sha8>`；feature＝模块列（缺省单功能＝文件 stem）；feature key＝`imp-<slug>-<sha8>`（前缀避免与设计特征 `f-` 撞车）→ 由此**参与"最新份"解析、runner/日程/报告/证据与 `suite backfill`**（＝"进入用例库"的应有意涵）。幂等＝文件内容哈希（重复导入 skip 并指向既有份）；caseId＝`imp-<sha8(内容)>-<行号>`、名称冻结；`excelPath`＋`scope` 同给＝导入后仅在该导入集内按 scope 过滤（缺省该集全量）。
- **D5b 导入用例的可执行化与门禁分档**：导入器按列合成 `taskDesc`（步骤/预期/前置 组装，注入 `【真实数据】` 条款＋前置假设）、`steps`（有"预期"→assert；否则 explore 计入弱断言）、`preconditions`。门禁把 `coverageGateIssue` 拆成**可组合纯函数**（artifacts／dataPolicy／coverage）：生成集＝三闸全开；**导入集＝三件套闸（自身 xlsx 同批生成）＋真实数据闸；覆盖闸标注 `n/a (imported)`**；`suite check --tests <导入集>` 同分档。
- **D6 xlsx 读取实现约束**：优先**最小内建解析**（zip 中央目录＋`node:zlib` inflateRaw＋XML 文本扫描，仅取 cell 值）；引入运行时依赖需单独评审。**fail-loud**：合并单元格布局、共享字符串索引越界、行数与 sheet 声明维度不符等无法可靠识别的情形**显式失败＋转换指引**，**禁止 best-effort 部分读取**；解析后做健全性断言（行数/列数）。
- **D7 `project_archive`（只读）**：汇总——项目与栈；设计血统（flows 来源/日期/屏数/provenance 构成）；用例库（各集：生成/导入来源、功能、条数、时间）；最近运行（近 N 批清单摘要：gate/通过率/失败域）；裁决与 Jira 关联摘要；前置状态（figma/pen/jira/llm 就绪与否，masked）。无网络、无子进程、不写盘。
- **D8 Jira 细致度分档**：有测试步骤/模块字段→优先从档案**映射候选用例**（LLM 辅助但约束"只能从清单中选或答没有"）；一句话粗单→needs-info（模板：哪个功能/页面？触发条件？期望结果？）。
- **D8b 无可用映射的保底——"单子即用例"**：详细单在库内无匹配（或库为空）时，**按单子步骤直接合成 taskDesc 执行**并在回写注明来源＝单子；粗单提问清楚后同样可直跑——保证"第一次接入就是 Jira 验证"也有出路。
- **D9 证据回写（外部副作用，默认执行）**：跑完复用 `jira_evidence_post`（traceId 幂等）＋结论评论；**聚合规则：任一强断言失败→FAIL**；**全弱/全探索时必须披露构成**（"N 强/M 弱；弱断言仅记录路径，不代表验证通过"）——避免"没崩"被读成"验证通过"。**同单复验复用同一评论**（marker `AOS-VERIFY:<issueKey>` 幂等追加，避免刷屏）。**不自动写 `verdict`**（裁决是人工语义，自动写会覆盖人工审阅）——只写 `jira_issue_key` 关联＋note（标注"自动验证"）；提供 `dryRun`。
- **D10 内部复用而非 shell**：直接复用既有实现（提取/生成/suite check 闸/`runGeneratedTests` 等）；`coverageGateIssue` 等函数按需**小幅重构导出**（计划列出）；**禁止 shell 到 `dist/cli.js` 或脚本**。
- **D11 脚本退役**：`design-to-test.mjs` 从仓库删除（CI 如需非对话调用，用 3 行 stdio 薄壳，计划定案）；`audit-legacy-tests.mjs` 属运维扫描器，暂留。
- **D12 双面数据**：项目档案写侧 provenance 贯穿（生成/导入来源、映射选择、裁决、对账升权沿用）；服务侧＝usage/降级/失败＋生成反馈的**人工周期汇总**（工具化后置）。**每工具最小事件集（随工具实现即落埋点，扩展现有 usage 信号提取）**：通用＝`needsSetup.target/missing[]`、`needsInfo.category`、各步耗时与中断点；`run_regression`＝`import.outcome(imported|skipped|invalid)`、`scope.match.hits`、门禁结果；`verify_jira_issue`＝`ticket.detailTier`、`mapping.selected|none`、`writeback(dryRun|sent)`。
- **D13 映射持久化（v1 取舍）**：不新增映射存储；同 issue 复验默认重新映射，可用 `scope` 覆盖；复验时把**上次该单的映射**（读自上次评论/运行记录，非新增存储）作为上下文传入，降低 LLM 重映射的非确定性；映射与被采纳的选择随该次运行记录/评论可见（独立映射资产后置）。
- **D15 长跑与拆步姿态**：`design_to_test` **缺省止于 ④**（响应含 `nextAction` 指向运行；`run:true` 为显式"一次到底"，注明客户端超时风险）；执行类调用（⑤/`run_regression`/`verify_jira_issue`）**开始前回显将跑的用例（数量＋来源＋设备）**；**中断/超时恢复语义＝事实源在磁盘**（批次清单 `design/runs/`、trace 目录），工具可安全重跑（幂等/追加），不产生"无从判断的半成品"；每步失败返回结构化 `{failedStep, detail, suggestions}`（人话，非裸 gate 输出）；LLM 校验 ping 短超时、仅探活不复用会话。
- **D16 scope 匹配基准与回显**：v1 基准＝对**功能名/模块名/用例名**做归一化关键词匹配（大小写/全半角/空白归一；LLM 辅助仅用于候选排序）；响应**回显命中集合摘要（功能×条数＋来源：导入自 x / 生成自 y）**——缺省"最新份全量"同口径回显，防止"跑的是导入集"不可见；0 命中→needs-info。
- **D14 `project_archive` 的"就绪"口径**：archive **无网络、无子进程**——只做**静态存在性**（`.env` 键/条目/CLI 解析）并显式标注「未复核」；真实复核（`pen status` 子进程、LLM ping）发生在**流程工具首步**；不新增状态存储。pen CLI 缺失/未登录→needs-setup（howTo：`pen login`／自动托管安装／`AOS_PEN_CLI_PATH`）。

## 7. 接口草案（细节留计划）

```ts
// design_to_test —— CR 一条龙（前置内化；缺前置→needs-setup）
{ figmaUrl?, nodeId?, penPath?, vision?, reuseExistingFlows?, device?, run? /* 缺省 false：止于④，响应含 nextAction */ }

// run_regression —— 回归（excelPath 先导入后跑；scope 一句话匹配；缺省＝库内最新份全量并明示条数）
{ excelPath?, scope?, all?, device? }

// verify_jira_issue —— Jira 验证（细致度分档；粗单→needs-info；无匹配→"单子即用例"）
{ issueKey, device?, scope?, dryRun? }

// project_archive —— 只读摘要
{}

// 通用返回
{ ok: true, steps: [...摘要], artifacts: {...}, run?: {...} }
{ ok: false, needs: "setup" | "info", target?, missing?, howTo?, questions?, context? }
```

## 8. 与既有模块的映射（复用清单）

| 能力 | 复用 |
|---|---|
| 设计提取 | `figma_extract_flows` / `pen_extract_flows`（含 vision） |
| 用例生成 | `figma_generate_tests`（三件套＋case-sets＋真实数据条款） |
| 校验闸 | `suite check` 的 `coverageGateIssue`（重构导出） |
| 执行 | `runGeneratedTests`（suite run 内核）＋`suite report` 产物 |
| Jira | 既有 client（get/search/comment/attach）＋`jira_evidence_post` |
| 数据 | 项目 `.artemis/design/*`＋PG 台账（suite_runs/case_sets/verdicts/usage）＋对账资产 |

## 9. 测试口径（映射，具体随计划）

- 三工具×三态：前置缺失→needs-setup（不触网、不写盘）；前置齐全→全链（子流程 stub）；信息不足→needs-info（粗单/无范围）；**设备前置**：无设备→needs-setup（执行类）、多设备→needs-info、唯一设备自动选用并回显。
- 拆步与恢复：`design_to_test` 缺省不带 ⑤（`run:true` 才执行）；执行类调用开始前回显将跑用例（数量＋来源＋设备）；模拟中断（超时）后事实源（批次清单/trace）可查、重跑安全。
- Excel 导入：幂等（同内容二次导入 skip）、坏文件/缺列降级与提示、`columns` 覆盖、provenance 落档；**导入集门禁分档**（三件套＋真实数据通过、覆盖闸标注 `n/a`）；`suite check --tests <导入集>` 同口径；`suite backfill` 可重建导入集登记。
- Jira：详细单映射命中→跑；库空/无匹配→"单子即用例"直跑并注明来源；**聚合规则**（任一强断言失败→FAIL）与**弱断言披露**（全弱时评论明示 N 强/M 弱）；**自动写回不得覆盖人工 `verdict`**（断言仅写 `jira_issue_key` 关联与 note）；**同单复验更新同一评论**（不新增）；`dryRun` 不触外网。
- 任意顺序：先 Jira 后回归等序列不假设前置状态（各工具独立自查）。
- usage 事件：`needsSetup.target/missing[]`、`needsInfo.category`、`import.outcome`、`scope.match.hits`、`mapping.selected|none` 按 D12 落事件断言。
- additive 回归：既有工具/CLI 测试全绿不受影响；脚本退役后 `test/design-to-test.test.js` 相应迁移/删除。

## 10. 留给实现/计划的

- Excel 解析器细节（日期格式等最小处理；fail-loud 判据的实现）；Jira 映射的启发式与提问模板措辞；`project_archive` 字段定稿；三工具命名终审；脚本退役对 CI 的兼容决策；`coverageGateIssue` 等重构的落点；usage 事件与现有 capture 的接线点。

## 11. builder-check 复核记录（2026-10-17）

独立复核（fresh subagent，读文档＋核对 `suite-command/preflight/case-runner/case-sets/run-registry/verdict-exits/jira/pen` 等代码）提出 5 个 Important 级问题，逐条裁决并入（无遗留「用户裁决」项）：

1. **导入集形态**（本地目录 vs 一等登记；关联悬空会让报告/统计/证据退化）→ D5 终稿：**按模块一等 case-set 登记**（标准三件套＋源文件副本、`imp-` 前缀 feature key、满 NOT NULL、天然纳入最新份/backfill/runner）。
2. **可执行化与门禁**（无 taskDesc 会跑 0 条；三件套/标记/覆盖三闸对导入集的处理）→ D5b：合成 taskDesc（注入【真实数据】）；门禁拆成可组合纯函数、**按来源分档**（导入集＝三件套＋真实数据，覆盖闸标注 n/a）。
3. **archive 的"就绪"与 pen 记录落点**（archive 无子进程 vs pen status 需子进程）→ D14：archive 静态＋「未复核」标注；真实复核在流程工具首步；不新增状态存储。
4. **Jira 写回口径**（verdict 是人工语义；外部副作用默认值）→ D9：不自动写 verdict（仅 `jira_issue_key` 关联＋note）；默认写回＋`dryRun`；D13：v1 不新增映射持久化。
5. **无库/映射全落空出口** → D8b"单子即用例"直跑保底（保证"第一次接入即 Jira"有出路）。

**第二轮：外部评审**（判「设计合理、小修后出计划」；含"简单易用"专项走查）。逐条核实处置——① **设备前置缺席矩阵**：成立（§5 补"执行类"行＋device 缺省策略）；② **长跑/中断语义**：成立（新增 D15：缺省止于④的拆步姿态＋磁盘事实源恢复语义）；③ **新表面 usage 事件**：成立、前提微调（现有采集已含 warning/降级/错误类信号，并非"仅调用级计数"；但新表面字段确需枚举）→ D12 增最小事件集；④ **Jira 聚合与弱断言披露**：成立 → D9（任一强断言失败→FAIL；全弱披露 N 强/M 弱）；⑤ **最新份 provenance 回显**：成立 → D16；⑥ **scope 匹配基准与命中回显**：成立 → D16；⑦ **xlsx fail-loud**：成立 → D6（禁 best-effort 部分读取＋健全性断言）。低注全部采纳：同单评论复用（D9）、映射上下文降非确定性（D13）、ping 短超时（D15）、源文件副本单份（D5）、`excelPath＋scope` 组合语义（D5）。
