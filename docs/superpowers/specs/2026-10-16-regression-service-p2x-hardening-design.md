# 回归服务 P2.x 加固设计（失联领取回收 / 按端部分领取 / upsertRunner 原子化）

> 2026-10-16 · 前置：P2（§13.109 runner）、P3a（§13.110 schedules）已落地；本设计处理 §13.109 §8「剩余项」中的三项服务化加固（claimed 自动超时重置、按端部分领取、`upsertRunner` 原子性）与 P2 台账中记录的竞态/救济缺口。
> 状态：builder-check 复核后修订；实施计划另出。

## 1. 意图与背景

现状缺口（对照 §13.109/§13.110 与 P2 台账）：

| # | 缺口 | 现状 | 后果 |
|---|------|------|------|
| A | **失联领取滞留** | 救济＝runner 自身启动释放＋人工 `suite task release`（需离线判定/`--force`） | runner 崩溃且不再启动 → 任务永久停 `claimed/running`，无人接管 |
| B | **按端部分领取** | 领取要求「任务端 ⊆ 该 runner 设备端」（单机双端） | 分机部署（仅 iOS 或仅 Android 机）下双端任务**永久 pending**，仅人工约跑 |
| C | **`upsertRunner` 非原子** | SELECT→（UPDATE 或 INSERT），双开同名竞态可插重复行（README 已警告） | 心跳并发下重复 runner 行；TTL/在线判定与领取归属产生歧义 |

## 2. 范围

### 2.1 A：失联领取自动回收（D1/D2/D5）

- 新增 store 方法 `releaseStaleClaims({ rootPath, offlineBefore, claimedBefore }): Promise<number>`：
  - 命中条件（同时满足）：`status ∈ {claimed, running}`（非终态）**且** `claimed_at <= claimedBefore`（超龄）**且**（`claimed_by` 为空 **或** 该 runner `last_seen_at <= offlineBefore`）（失联）。
  - 动作：`status='pending'`、清 `claimed_by/claimed_at`；**`attempts` 保留（领取即累加——既有语义：`postgres.ts:718`/`memory.ts:314` 在领取时 `attempts+1`）**。
  - **毒丸防护（外部评审关键点 2 修订）**：crash 型循环没有「执行失败回写」，原「达上限由执行失败路径置 failed」永远不会触达——**新增领取守卫（agent 侧）**：领取成功后若 `task.attempts > maxAttempts` → 立即 `releaseRegressionTask(to:'failed')` 并日志，**不执行**（毒丸任务在 max+1 次领取处终态化；正常断电同样按领取次数计，语义与现状一致）。
  - 自洽性质：**无在线 runner 时无人回收**——回收由在线者执行，首个恢复的 runner 会先回收再领取，无需额外机制。
  - 单条 `UPDATE ... WHERE` 原子完成（无读改写窗口）；返回回收数。
- runner 主循环**每轮**在「触发 schedules → 领取」之前调用（两个时间戳由 agent 计算：`offlineBefore = now - runnerTtl`（既有 90s TTL）、`claimedBefore = now - AOS_RUNNER_STALE_CLAIM_MS`）。
- 开关：`AOS_RUNNER_STALE_CLAIM_MS`（默认 **900000**＝15min；`0` 关闭回收）；回收发生时有日志（数量）。

### 2.2 B：按端部分领取（D3/D6）

- 领取规则升级（`claimRegressionTask` 扩展）：
  1. **优先**：任务端 ⊆ 自身设备端（旧行为，完全覆盖）；
  2. **部分领取（仅当「全覆盖已不可能」时）**：任务端 ∩ 自身设备端 **≥1** 且 **不存在任一在线 runner 可全覆盖该任务**（在线＝`last_seen_at > onlineBefore`；全覆盖＝任务端 ⊆ 该 runner `platforms`）→ 领取并按**交集端**执行。
- 执行与终态：复用既有 `suite run --task`「缺端设备 → 该端标注未执行」路径；任务按原有状态机回写（完成/部分失败）；**不自动补跑缺端**（需要补齐时人工新建任务；本规则保证双端 runner 在场时绝不部分抢占；缺端可见性见下）。
- 开关：**`AOS_RUNNER_PARTIAL_CLAIM=1` 显式开启**（默认关＝严格子集，旧行为逐字）；开启时按 D3 规则部分领取。
- 可见性（v1）：部分领取时 runner 日志明示「部分端执行（缺 X——在线无全覆盖执行机）」；执行侧沿用既有控制台缺端标注；**不新增任务状态/结果表字段**（列非目标 backlog）。
- **端覆盖审计口径（外部评审中 4）**：历史任务「completed 但缺端」在 DB 层无标记；反推口径＝任务 `runIds` 关联的 `suite_runs.platform` 集合 vs 任务 `platforms`（统计下钻的分母按实际已跑端）。
- 回归面：默认配置（部分领取关）逐字旧行为；不带新参数的 store 调用＝严格旧行为（`onlineBefore`/`allowPartial` 均为可选且缺省关闭增强路径）。

### 2.3 C：`upsertRunner` 原子化（D4）

- DDL/MIGRATIONS：`runners` 增 **UNIQUE (project_id, name)**——**统一由 MIGRATIONS 建唯一索引**（`CREATE UNIQUE INDEX IF NOT EXISTS runners_project_name_idx`，幂等、新库/存量库一体覆盖；DDL 不加表约束以避免新库双索引）；迁移**先去重再建索引**（存量库可能已有竞态重复行；去重为必要前置，防索引创建被 best-effort 跳过致指数静默缺失，见 Q3 修订说明）。**去重 SQL 形态（pg-mem 3.0.14 实测）**：仅「`id IN (自 JOIN 子查询：保留 last_seen_at 最大、并列取 id 最大)`」可行（窗口函数/`DELETE…USING`/相关 EXISTS/`NOT IN`+GROUP BY 均不可用）；`project_id IS NULL` 行不参与去重（无实际影响：upsert 未注册项目即抛错）。
- `upsertRunner` 实现改为：INSERT → 命中唯一冲突（`23505`）→ 回退 UPDATE（与 `createSchedule` 的 23505 归一先例同款）；语义＝单行 upsert，双写并发下最多一次回退重试，不产生重复行。**去重 tie-break 口径（外部评审低优先）**：并列取 `id` 最大＝UUID 字符串比较（确定性）；`last_seen_at` 文本比较依赖统一 ISO 格式（同格式字典序＝时间序；勿引入带时区偏移格式）。
- 无签名变化；离线测试可在 pg-mem 上以「连续/交错调用」验证单行不变量与回退路径。

## 3. 非目标

- claim 平台过滤下推 SQL（暂不做：`platforms` 为 JSON 文本、pg-mem 承载 JSON 包含判定易漂移；pending 全量扫描有界，收益低——记 backlog）。
- 「并发领取」执行级并发测试（结构守卫已有；pg-mem 串行语义下不可真并发——记 backlog）。
- 多实例并发迁移（advisory lock）、回填扫描、真机 iOS 自动发现、artifact TOCTOU（各自独立事项）。
- 自动补跑部分领取后的缺端（明确不自动化；人工路径）。
- **任务状态/结果表/面板级缺端显式标记**（v1 仅日志＋控制台标注；Q2 定案，另立小票）。
- 面板/CLI 新命令（`suite task release` 维持人工救济语义不变）。

## 4. 硬约束

- **前置声明（外部评审关键点 1）**：回收正确性依赖「**执行期间心跳持续**」——P2 已实现（`agent.ts` 心跳循环与主循环解耦，约 39/107-122 行；§13.109 记录；结构测试 `test/runner-agent.test.js:425`「执行期间心跳持续：长跑不再失联」）。本设计复核确认该修复在场；回收的失联判定以 `runners.last_seen_at` 为准，长跑任务只要心跳在跳就不会被判失联。
- **部署约束（外部评审中 3）**：失联判定用**回收者自身**的 TTL；多机队须统一配置且各机心跳间隔 ≤ TTL/3（默认 30s/90s 满足）。混配（他机心跳间隔 > 本机 TTL）会把健康但慢心跳的执行机误判失联。
- 测试口径：pg-mem/内存 store、假 runner、不触网；测试跑 `dist/`。
- 相对导入 `.js`；代码英文、用户文案中文；默认不加注释（仅保留解释非显然契约的 JSDoc）。
- **默认配置零行为回归**（Q1 修订）：回收仅作用于「超龄＋失联」（健康流程与在线 runner 的领取/执行零变化）；部分领取**默认关**（严格旧行为逐字，`runner-agent:163` 缺端不领用例为锁）；既有 runner-agent/suite-task/runner-artifact 测试全绿。
- **迁移口径**（Q3 修订）：`MIGRATIONS` 维持仓库既有 best-effort 包装（多实例并发迁移已声明 out-of-scope）；本项以**迁移专项测试**（pg-mem，夹具沿用 `test/db-runners.test.js:400` 的 `noAstCoverageCheck: true` 旧表形态）锁定「存量重复行去重 + 唯一索引存在 + upsert 单行不变量」；**唯一索引仅由 MIGRATIONS 建**（幂等覆盖新库/存量库；DDL 不加表约束）。索引生效时 `upsertRunner` 保证单行；残余风险（迁移未生效且并发插入）与现状同级，文档注明。
- 完工标准：`npm run build && npm test && npm run lint` 全绿；同步 DESIGN（新增 §13.116）＋ README（runner 段）＋ AGENTS.md（runner 行）。

## 5. 关键决策（本次方案判断；可被否决/修订）

| # | 决策 | 理由 | 若否决的代价 |
|---|------|------|--------------|
| D1 | 失联回收＝**runner 主循环内自动执行**（每轮先回收→触发→领取），双条件（超龄＋失联）同时满足才回收 | 无需新增守护进程/中心动作；双条件防误伤长跑执行 | 若改由中心/CLI 巡检，需新的调度面与部署配置 |
| D2 | 回收后置 `pending`、`attempts` 保留（领取即累加）；任何 runner 均可执行回收（单条 UPDATE 原子）；**新增领取守卫：attempts > maxAttempts → 置 failed 不执行（毒丸防护，关键点 2 修订）** | 重试上限语义不变；crash 型循环必须能被上限终止（原失败路径不覆盖 crash） | 若不做守卫，毒丸任务会以回收节奏跨 runner 传播（15min 一轮） |
| D3 | 部分领取＝**「全覆盖已不可能」时才启用**（存在任一在线 runner 可全覆盖则继续等待）；**且默认关闭**（见 D6 修订） | 保留「双端齐备优先」语义，同时为分机部署提供显式解锁 | 若直接允许部分抢占，双端 runner 在场时也会丢端执行 |
| D4 | `upsertRunner`＝唯一索引（**仅经 MIGRATIONS 建，幂等；DDL 不加表约束**）＋23505 回退 UPDATE；迁移**先去重再建索引**（自 JOIN 去重写法，pg-mem 实测唯一可行） | 与 `createSchedule` 先例一致；去重防存量脏数据；统一入口避免双索引 | 若不做去重，存量重复行可能致迁移语句失败（best-effort 跳过→指数缺失，见 Q3 修订说明） |
| D5 | 回收阈值默认 15min、0 关闭；TTL 用既有 90s | 15min 覆盖「领取→启动执行」正常窗口；长跑执行由心跳失联条件保护 | 阈值过长滞留久、过短可能误回收 |
| D6 | 部分领取**默认关**（`AOS_RUNNER_PARTIAL_CLAIM=1` 显式开启；开启后按 D3 规则） | **修订（builder-check Q1）**：缺端标注当前仅日志级（Q2），默认开会静默降覆盖；opt-in 保住「默认零行为回归」（`runner-agent:163` 缺端不领用例默认仍成立） | 若要求默认开，需先补任务页/结果表级缺端标注（见非目标 backlog） |
| D7 | 缺端**不自动补跑**；v1 可见性＝领取日志明示「部分端执行（缺 X）」＋ `suite run --task` 既有控制台标注＋文档；**不新增任务状态/结果表字段**（Q2 定案） | 自动化补跑需跨 runner 协同；新增状态面改动过大；opt-in 下风险可控 | 若要求「完成后仍显著可见缺端」（面板/结果表字段），需状态机与新字段（另立小票） |

## 6. 接口草案（细节留给计划）

- **store**：
  ```ts
  // 新增
  releaseStaleClaims(input: {
    rootPath: string; offlineBefore: string; claimedBefore: string;
  }): Promise<number>;
  // 扩展（均为可选；缺省＝严格旧行为）
  claimRegressionTask(input: {
    rootPath: string; runnerId: string; platforms: string[];
    onlineBefore?: string;      // 提供时启用「全覆盖在线 runner 存在则等待」判定
    allowPartial?: boolean;     // 默认 false（严格）；true 时按 D3 规则部分领取
  }): Promise<RegressionTaskRecord | null>;
  ```
- **agent 主循环**（`src/runner/agent.ts`）：每轮 `schedulesEnabled` 触发之前：
  `staleClaimMs` 解析 `env.AOS_RUNNER_STALE_CLAIM_MS`（缺省 900000；`"0"` 解析为 0 关闭、**勿回退默认**）；`>0` 时 `releaseStaleClaims({ offlineBefore: iso(now-runnerTtlMs), claimedBefore: iso(now-staleClaimMs) })`，`>0` 条则日志；`partial = env.AOS_RUNNER_PARTIAL_CLAIM === "1"`（默认关）；领取调用传 `onlineBefore: iso(now-runnerTtlMs), allowPartial: partial`（部分领取时领取日志明示缺端）。
- **领取守卫（毒丸防护）**：领取成功后（attempts 已累加）若 `task.attempts > maxAttempts` → `releaseRegressionTask({ taskId, runnerId: me.id, to: "failed" })` ＋ 日志「超上限（毒丸防护）」；**不进入执行**。
- **claim 参数组合语义表（外部评审中 5）**：仅第四行分叉到部分领取，其余三行＝严格旧行为（旧行为本就返回 null 隐式等待，非新行为）：
  | `allowPartial` | `onlineBefore` | 行为 |
  |---|---|---|
  | 缺省/false | 任意 | 严格子集（旧行为逐字） |
  | 缺省/false | 提供 | 严格子集（无部分路径） |
  | true | 缺省 | 严格子集（无在线快照，不做全覆盖等待判定） |
  | true | 提供 | 完全覆盖优先；无则「无他者全覆盖」时按交集领取 |
  参数拆两半的理由：`onlineBefore` 为可注入的时间快照（测试与 agent 各自显式提供），避免 store 内取 `Date.now()`。
- **claim 判定顺序**（store 内、单次调用内拉一次在线 runner 列表）：先按「完全覆盖」取最早候选（旧逻辑）；无则当 `allowPartial === true && onlineBefore provided` 时：对每个候选算交集，若无他者在线 runner 全覆盖该候选且交集≥1 → 领最早者；否则返回 null。
- **upsertRunner**：迁移语句（顺序固定）：①去重 `DELETE FROM runners WHERE id IN (SELECT r1.id FROM runners r1 JOIN runners r2 ON r1.project_id = r2.project_id AND r1.name = r2.name WHERE r1.last_seen_at < r2.last_seen_at OR (r1.last_seen_at = r2.last_seen_at AND r1.id < r2.id))`（pg-mem 3.0.14 实测唯一可行形态）②`CREATE UNIQUE INDEX IF NOT EXISTS runners_project_name_idx ON runners(project_id, name)`；实现主体：INSERT 捕获 `code === "23505"` → UPDATE（按 project_id+name）；**返回口径沿用 `RETURNING *`/`rows.length` 既有风格**。

## 7. 测试口径（映射，具体用例随计划）

| 面 | 覆盖点 |
|----|--------|
| `releaseStaleClaims` | 超龄＋失联 → pending（清 claimed_by/at、attempts 保留）；**超龄＋在线 → 不回收（定向用例：防把「心跳持续」前置测漏）**；未超龄＋失联 → 不动；`claimed_by` 空且超龄 → 回收；终态（completed/partial/failed）不动；memory/pg-mem 同口径；返回值=回收数 |
| `claimRegressionTask` | 旧行为回归（无新参数字段时严格子集）；完全覆盖优先于部分（双 runner 场景）；部分：无在线全覆盖时交集≥1 领取＋最早候选；有他者在线全覆盖 → 等待（null）；`allowPartial:false` → 等待；`onlineBefore` 缺省 → 等待；交集 0 → null；**注：部分领取的快照竞态窗口（双端 runner 恰在快照后上线）不覆盖测试**（与既有并发测试 backlog 口径一致） |
| upsertRunner | 同名二次 upsert 单行不变量（不产第二行）；23505 回退路径（先插后 upsert）；**迁移专项**：存量重复行 → init 后去重且唯一索引存在（pg-mem）、新库经迁移建索引；跨项目同名互不影响 |
| agent | 回收调用参数计算（offlineBefore=now-TTL、claimedBefore=now-staleMs；env 0 关闭不调用）；**默认（无 env）不启用部分领取**（`runner-agent:163` 缺端不领用例仍绿）；`AOS_RUNNER_PARTIAL_CLAIM=1` 时参数透传与「部分端执行（缺 X）」日志；**领取守卫：预置 attempts=3（max 默认 3）任务 → 领取后置 failed、不执行（毒丸防护）**；回收数>0 有日志；既有循环行为不回归 |
| 回归 | `test/runner-agent.test.js`/`test/suite-task.test.js`/`test/suite-runner*.test.js`/`test/db-runners.test.js` 全绿（默认路径逐字） |

## 8. 留给实现/计划的（不阻塞）

- 迁移去重的具体 SQL 写法（已在 §6 钉死）；`runnerTtlFrom` 复用点；日志措辞；测试夹具组织；`AOS_RUNNER_STALE_CLAIM_MS` 用**专用解析小函数**（`intFromEnv` 的 `<=0` 回退语义不适用——`"0"` 必须解析为 0）。

## 9. builder-check 复核记录（2026-10-16）

独立 subagent（只读文档＋相关代码）提出 3 个实质问题，全部在文档内定案、无遗留待用户问题：

1. **D6「部分领取默认开」与「默认配置零行为回归」/锁用例（`runner-agent:163`）矛盾** → **D6 修订为默认关**（`AOS_RUNNER_PARTIAL_CLAIM=1` 显式开启）；§4 回归口径按「回收仅涉超龄+失联、部分领取默认关」重述。
2. **缺端标注现状仅控制台日志级（任务可能 `completed` 且无存储标记）** → **Q2 定案**：v1 接受复用（领取日志明示缺端＋控制台标注＋文档），不新增状态/结果表字段；「面板/结果表级缺端标记」列入非目标 backlog（opt-in 后风险可控）。
3. **MIGRATIONS 为 best-effort（失败仅 warn），去重/唯一索引可能静默未生效** → §4 迁移口径修订：保持 best-effort 包装（多实例并发迁移 out-of-scope），以**迁移专项测试**锁定落地；残余风险与现状同级并文档注明。
- 低优先（复核者自决，认可）：`AOS_RUNNER_STALE_CLAIM_MS=0` 解析需返回 0（勿落回默认）；悬空 `claimed_by`（runner 行缺失）按失联回收（与 `suite task release` 口径一致）；部分路径保留 `status='pending'` CAS 守卫；循环顺序＝回收→触发→领取。

## 10. 外部复核评审批注（2026-10-16，逐条核实后处置）

| 评审点 | 核实结论 | 处置 |
|--------|----------|------|
| 关键点 1：回收依赖「执行期间心跳持续」未声明 | **基座已存在**：心跳循环与主循环解耦（`agent.ts:39/107-122`）＋结构测试（`runner-agent.test.js:425`）；设计未声明该依赖属实 | §4 增前置声明；测试矩阵补「**超龄＋在线** → 不回收」定向用例（防把该洞测漏）。P2 无需先修（修复在场） |
| 关键点 2：毒丸循环、attempts 不累计 | **机制描述有误**：`attempts` 在**每次领取时累加**（`postgres.ts:718`/`memory.ts:314`）；真正缺口＝**无 claim 侧上限守卫**（crash 型循环触达不到 failed） | 采纳修复方向：§2.1/D2/§6 增「领取守卫：attempts > maxAttempts → failed 不执行」（毒丸在 max+1 次领取终态化）；原「达上限仍由失败路径置 failed」措辞修正 |
| 中 3：TTL 混配误回收 | 成立 | §4 增部署约束（统一配置、心跳间隔 ≤ TTL/3） |
| 中 4：端覆盖审计口径缺失 | 成立 | §2.2 增反推口径（runIds→suite_runs.platform vs platforms） |
| 中 5：claim 参数组合语义不清 | 成立 | §6 增四组合语义表（仅 `true+提供` 分叉） |
| 低优先：部分领取快照竞态不覆盖 | 成立 | §7 测试映射注明「该并发窗口不覆盖」（与既有并发测试 backlog 口径一致） |
| 低优先：去重 tie-break/ISO 口径 | 成立 | §2.3 增口径句 |
| 低优先：「无在线则无人回收」自洽性质 | 成立 | §2.1 增一句点明 |
