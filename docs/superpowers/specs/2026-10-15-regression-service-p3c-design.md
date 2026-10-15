# 回归服务 P3c 设计（跨项目对比：多项目对比视图）

> 2026-10-15 · 前置：P1（§13.106–13.108）/ P2（§13.109）/ P3a（§13.110）/ P3b（§13.111）已落地；总体设计见 `2026-10-14-regression-service-design.md`（§5.4 面板、§5.8 统计、§7 P3「跨项目对比」）。
> 状态：builder-check 复核后修订；实施计划另出。

## 1. 意图与背景

服务已覆盖**单项目**的回归全链路（生成→任务→runner→批次→归因→出口）。多项目部署（中心 PG 聚合多个项目机）后，负责人/测试主管的**运营问题**没有答案面：

- 哪些项目现在**需要关注**？（红灯、门禁连续失败、无批次、任务积压）
- 各项目的**质量水位**与**趋势**如何？（通过率、flaky、失败域构成）
- 各项目的**待办**几何？（未裁决失败、未建单应用缺陷、pending 任务、runner 在线、定时回归开关）

现状：L1「多项目总览」只给接入健康灯＋栈＋最后活跃＋最新批次摘要（§13.96/13.98）；统计下钻（§13.108）是**单项目**的功能→用例维度。P3c 补上「项目」这一层：**只读对比视图**。

## 2. 范围

### 2.1 对比视图（新视图 `?view=compare`，无 `project` 参数）

表行＝项目；数据源＝**中央 PG 台账为主**（对磁盘不可达的项目机同样成立），接入健康复用 L1 既有软读灯色。列（v1 指标集）：

| 组 | 指标 |
|----|------|
| 项目 | 名称（链接到项目页）＋ 接入健康灯（复用 L1 行） |
| 最近批次 | 时间 · 门禁（pass/fail/—）· 通过率（passed/total）——**取台账窗口（份血统）最新一批**（非 L1 软读口径，见 D8） |
| 趋势 | 最近 ≤10 批通过率序列（内联 SVG 迷你图，零依赖） |
| 质量 | flaky 计数（窗口内，见 D11）、失败域 top3（计数） |
| 待办 | 未裁决失败数（窗内**发生次数**）、应用缺陷未建单数（**按（份,用例）最新裁决去重**，与统计/建单面同源）、任务积压（pending+claimed+running）、failed 任务数 |
| 运行 | runner 在线数（TTL 90s）/设备数、定时回归 enabled 数（最近触发时间） |

- **窗口口径**：趋势/质量/待办/最近批次均取「**份血统运行**（`featureKey !== null`）最近 **20** 批」；台账读取取 `limit 40` 后 JS 过滤取前 20（窗口稀释有界；必要时计划下推查询）。更细口径以项目页/统计视图为准，视图内附口径说明行。
- **排序**：固定「关注优先」—— 无批次 → 最近门禁 fail → 通过率升序 → 项目名；不做前端排序。
- **降级**：单项目台账读取失败 → 该行如实标注（`读取失败：…`），**不整页失败**；无数据单元格显 `—`。

### 2.2 JSON 面

`GET /panel.json?view=compare` 返回稳定 JSON（`{ ok, view:"compare", generatedAt, window: {runs: 20}, projects: [{ …指标 }] }`）。HTML 与 JSON 同源构建（同一 view 对象）。

### 2.3 导航与入口

- L1 页头加「多项目对比」链接；对比页回链 L1。
- `panel --web`（独立看板）自动可用（同一 handler；无运行时缝依赖）。

## 3. 非目标

- **功能级跨项目匹配**（同名功能矩阵）：feature key 项目内独立、名称匹配为启发式——v1 不做，列 P3+（需先讨论匹配规则与误报口径）。
- 跨项目**动作**（批量建任务/建单/跑回归）：动作层保持单项目作用域；对比视图严格只读。
- 阈值告警/通知、导出 CSV、历史归档对比（快照存储）：不做（可后补）。
- 鉴权升级（P3d）；实时推送（沿用 60s 缓存与手动刷新）。
- 不改 L1 现有列语义（对比视图独立；L1 只加链接）。

## 4. 硬约束

- 只读：无子进程/无网络/无写盘（沿用 `/panel` 语义）；全部输出 `escapeHtml`。
- 数据来源：中央 store（`listSuiteRuns`/`listRegressionTasks`/`listRunners`/`listSchedules` 按项目 bounded 调用）＋ L1 既有软读（灯色）。**不读取批次清单**（磁盘不可达项目也要有数）。
- 性能：每项目 **DB 往返 ≤3**（project 解析＋运行＋用例批量，见 D10）；跑数上限一并入缓存（`PanelWebCache`，TTL 沿用 `AOS_PANEL_TTL_MS`）。输出**封顶 50 行**——**先关注优先排序、后截断**（避免红灯项目被 overview 的最后活跃序误丢）并如实标注。
- 测试口径：pg-mem/内存 store、假目录、不触网；测试跑 `dist/`。
- 文案中文、代码英文；默认无注释；相对导入 `.js`。
- 完工同步：DESIGN.md 新增 §13.112、README（面板章节）、AGENTS.md（面板行）。

## 5. 关键决策（本次方案判断；可被否决/修订）

| # | 决策 | 理由 | 若否决的代价 |
|---|------|------|--------------|
| D1 | 对比**维度＝项目级**；功能级跨项目匹配留 P3+ | feature key 项目内独立；名称匹配误报率高，需先定义规则 | 若 v1 就要功能矩阵，需增加匹配规则设计与误报口径 |
| D2 | 数据源＝**台账为主**（PG），不用批次清单 | 磁盘不可达项目机（中心部署的远端项目）必须可比；清单仅在项目本机 | 改用清单会退回「可达才可比」 |
| D3 | 载体＝**面板新视图** `?view=compare` ＋ `/panel.json?view=compare`；不新增 CLI 子命令 | 统计/面板是既定承载面；`panel --web` 自动复用 | 若需 CLI 文本导出（如 `suite stats --all`），另立小票 |
| D4 | 窗口＝最近 **20** 批（趋势/质量/待办同窗，两列待办语义见 D9）；精确待办以归因队列为准（近 10 次口径），视图注明 | 扇出 bounded；与归因队列窗口**故意不同**并如实标注 | 改用 10 次与队列全对齐 → 趋势样本少 |
| D5 | 排序＝固定「关注优先」；不加前端排序/筛选 | 视图目的＝找问题，不是 BI | 需要列排序时后续加 |
| D6 | 迷你图＝**内联 SVG**（服务端渲染，零依赖零前端构建） | 与既有零依赖面板一致 | 换 Canvas/JS 图会引入前端复杂度 |
| D7 | 单项目降级＝**行内标注**、不整页失败；无数据 `—` | 对比面容忍部分项目缺数 | 整页失败会因一个远项目不可读而全灭 |
| D8 | 「最近批次」列与排序键**取台账窗口（份血统）最新一批**（D8 修订——原「复用 L1 软读」对磁盘不可达项目恒空、排序失效）；L1 自身的「最新批次」列**不改**；「接入健康」灯仍复用 L1 软读行 | 对比视图的使命是「哪些项目需要关注」，远端项目必须可排序；台账口径与 D2 一致 | 与 L1 列语义存在差异（对比视图独立视图，可接受） |
| D9 | **口径统一**：窗口＝份血统运行最近 20 批（趋势/flaky/域/最近批次同窗）；两列待办语义不同并如实标注——`pendingVerdicts`＝窗内发生次数（同归因队列「出现次数」精神）、`unissuedAppDefects`＝按（份,用例）**最新裁决去重**后 app-defect 且未建单（与统计/建单面同源） | 与单项目统计/归因队列各自对齐；避免同一 pin 两套数 | 若要求两列同口径，需改归因队列或统计面之一 |
| D10 | **读取路径**：`listSuiteRuns` 内部由「逐 run 装载 cases」改为**单查询批量装载**（动态占位 `IN`；输出行为逐字不变，既有测试为锁）→ 对比视图直接复用，每项目 ≤3 次 DB 往返；不新增 store 方法 | N+1 在 20 批×N 项目下往返数过大；批量装载对全部既有调用方同为提速、零语义变化 | 若不动共享方法，则需新增专用查询/聚合方法（接口面更大） |
| D11 | flaky 计数＝**窗口内运行级 `run.flaky` 之和**（等价于逐用例 flaky 计数；计划核对登记口径） | 运行级字段免读 cases，且与运行摘要一致 | 若登记口径有偏差，改用逐用例计数（需读 cases） |

## 6. 接口草案（细节留给计划）

- **视图**：`buildPanelCompare(deps): Promise<PanelCompareView>`（新模块或 `overview.ts` 内；`PanelView` 增 `kind:"compare"`；`toJsonView` 增分支；`buildView` 在无 `project` 且 `view=compare` 时路由）。
- **形状草案**：
  ```ts
  interface PanelCompareProject {
    name; rootPath; lamp; lampReasons: string[];
    latestBatch: { at: string; gate: "pass"|"fail"|null; passRate: number|null } | null;
    trend: Array<{ at: string; passRate: number|null }>;        // 时间升序 ≤10
    flaky: number; domains: Array<{ domain: string; count: number }>;  // top3
    pendingVerdicts: number; unissuedAppDefects: number;
    taskBacklog: { pending; claimed; running; failed };
    runners: { online; devices };
    schedules: { enabled; lastFiredAt: string|null };
    error: string|null;                                          // 行级降级
  }
  ```
- **每项目查询**：`listSuiteRuns(rootPath,{limit:40})`（D10 批量装载；JS 过滤 `featureKey !== null` 取前 20，派生趋势/flaky/域/最近批次/待办）、`listRegressionTasks(rootPath,200)`（仅计数）、`listRunners(rootPath)`、`listSchedules(rootPath)`。项目集合与灯复用 `buildPanelOverview` 行。
- **待办口径（D9）**：`pendingVerdicts`＝窗内 `status !== "passed" && verdict === null` 的**条目数**（发生次数）；`unissuedAppDefects`＝窗内按（`caseSetId ?? ""|caseId`）取**最新裁决**后 `app-defect && jiraKey === null` 的**去重条数**（复用 `collectVerdictExits` 的裁决人/备注字段语义；实现可复用其分组逻辑）。
- **渲染**：`web.ts` 新 `renderCompare(view)`；SVG 迷你图函数（纯字符串拼接，`escapeHtml` 不需要——数值来源受控，仍做数值钳制）；口径说明行；L1↔compare 互链。

## 7. 测试口径（映射，具体用例随计划）

| 面 | 覆盖点 |
|----|--------|
| 聚合 | 窗口口径（limit 40 取前 20、趋势升序 ≤10、域 top3、flaky＝Σ run.flaky、待办按 D9 两口径）；**份血统过滤**（adhoc 运行不入窗、稀释场景）；跨项目行序（关注优先）；**磁盘不可达但有台账的项目**排序与最近批次成立（D8）；单项目抛错 → 行级 error 不整页失败；无数据 → null/`—`；项目数 >50 截断 |
| 路由/JSON | `?view=compare` 无 project 参数命中；`/panel.json?view=compare` 形状；未知参数组合回退（`project` 存在时不命中 compare） |
| 渲染 | 表格与迷你图标记；口径说明行；降级行/空态；L1 链接互链；escape |
| 回归 | L1/L2/L3/统计视图既有测试不回归；`listSuiteRuns` 批量装载改造后输出逐字不变（既有测试为锁） |

## 8. 留给实现/计划的（不阻塞）

- 模块划分（新文件 `src/panel/compare.ts` vs `overview.ts` 扩展）；迷你图 SVG 细节；列分组渲染版式；`PanelWebCache` 与 compare 的 TTL 默认值核对；任务计数是否需要按状态过滤下推（`listRegressionTasks` 上限）；文本措辞。

## 9. builder-check 复核记录（2026-10-15）

独立 subagent（只读文档＋相关代码）提出 5 个实质问题，全部在文档内定案、无遗留待用户问题：

1. **磁盘不可达项目的「最近批次」/排序失效（D8 与 D2 矛盾）** → D8 修订：对比视图的最近批次与排序**取台账窗口**（L1 列不变，灯仍软读）。
2. **趋势/质量/待办是否过滤份血统** → D9：窗口＝份血统运行（与统计/出口口径一致）；adhoc 不入窗。
3. **待办两列去重语义未定** → D9：`pendingVerdicts`＝发生次数（队列精神）；`unissuedAppDefects`＝（份,用例）最新裁决去重（与统计/建单面同源）。
4. **「≤5 查询」与 listSuiteRuns N+1 冲突** → D10：`listSuiteRuns` 内部改批量装载（输出不变），每项目 ≤3 往返。
5. **flaky 计数来源未定** → D11：Σ `run.flaky`（计划核对登记口径）。
