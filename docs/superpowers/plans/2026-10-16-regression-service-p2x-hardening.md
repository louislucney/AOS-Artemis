# 回归服务 P2.x 加固实施计划（失联领取回收 / 按端部分领取 / upsertRunner 原子化）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三项服务化加固：① runner 主循环自动回收「超龄＋失联」的 claimed/running 任务（attempts 保留）；② 可选（默认关）按端部分领取——仅当无在线 runner 可全覆盖时，按交集端领取执行并明示缺端；③ `upsertRunner` 原子化（唯一索引＋23505 回退）。

**Architecture:** store 增 `releaseStaleClaims` 与 `claimRegressionTask` 可选扩展（缺省严格旧行为）；`runners` 增 `UNIQUE (project_id, name)`（新库 DDL＋存量库迁移先去重再建索引，迁移专项测试锁定）；agent 主循环在 schedules 触发前回收、领取时透传 `onlineBefore`/`allowPartial`（`AOS_RUNNER_PARTIAL_CLAIM=1` 开）。

**Spec:** `docs/superpowers/specs/2026-10-16-regression-service-p2x-hardening-design.md`（D1–D7 与复核记录 §9）

## Global Constraints

- 测试口径：pg-mem/内存 store、假 runner、不触网；测试跑 `dist/`；`npm run build` 后跑测试；单文件 `npm run test:file -- test/xxx.test.js`。
- 相对导入一律带 `.js` 后缀；代码英文、用户文案中文；默认不加注释（仅保留解释非显然契约的 JSDoc）。
- **默认配置零行为回归**：回收仅作用于「超龄＋失联」（健康流程零变化）；部分领取**默认关**（`runner-agent:163` 缺端不领用例为锁）；既有 runner-agent/suite-task/runner-artifact/db-runners 测试全绿。
- 迁移口径：MIGRATIONS 维持 best-effort 包装；以**迁移专项测试**锁定「去重＋唯一索引＋upsert 单行」；新库 DDL 直接含唯一索引。
- 完工标准：`npm run build && npm test && npm run lint` 全绿；同步 DESIGN（新增 §13.116）＋ README（runner 段）＋ AGENTS.md（runner 行）。
- **拍板（D1–D7 摘要）**：回收＝agent 主循环每轮（回收→触发→领取），双条件（`claimed_at<=claimedBefore` 且 runner 失联/悬空），置 pending、attempts 保留；`AOS_RUNNER_STALE_CLAIM_MS` 默认 900000、`"0"` 关闭（勿回退默认）；部分领取默认关、`AOS_RUNNER_PARTIAL_CLAIM=1` 开、仅「无在线全覆盖」时按交集领取、不缺端补跑、领取日志明示缺端；upsert＝INSERT→23505→UPDATE；TTL 复用既有 90s。

## Review Focus

1. **回收误伤面**：在线 runner 的 claimed/running 不动（含长跑心跳存活）；未超龄不动；悬空 `claimed_by`（runner 行缺失）按失联回收；终态（completed/partial/failed）不动；attempts 保留。
2. **部分领取判定**：完全覆盖优先（旧逻辑不变）；存在任一在线 runner 全覆盖（他者或自身）→ 等待；`allowPartial`/`onlineBefore` 缺省 → 严格旧行为；交集 0 → null；领取仍走 `status='pending'` CAS 守卫。
3. **upsert 原子性**：唯一索引存在下同名双写单行不变量；23505 回退路径可达；迁移去重（保留 last_seen_at 最新）幂等；跨项目同名互不影响。
4. **默认零回归**：无 env 时两条增强均不生效（锁用例 `runner-agent:163` 等全绿）；`"0"` 解析不回退默认。
5. **时间戳与比较**：ISO 字符串比较一致；`offlineBefore/claimedBefore` 由 agent 显式计算（store 不做时钟假设）；env 透传路径清晰。

---

### Task 1: store——`releaseStaleClaims` ＋ `upsertRunner` 原子化

**Files:**
- Modify: `src/db/types.ts`、`src/db/postgres.ts`、`src/db/memory.ts`
- Test: `test/db-runners.test.js`（追加；含迁移专项）

**Interfaces:**
- Produces：
  ```ts
  // types.ts（ProjectStore 新增）
  releaseStaleClaims(input: {
    rootPath: string; offlineBefore: string; claimedBefore: string;
  }): Promise<number>;
  ```
- 语义（postgres）：
  ```sql
  UPDATE regression_tasks
     SET status = 'pending', claimed_by = NULL, claimed_at = NULL
   WHERE project_id = $1
     AND status IN ('claimed', 'running')
     AND claimed_at IS NOT NULL AND claimed_at <= $2
     AND (claimed_by IS NULL OR claimed_by NOT IN (
           SELECT id FROM runners WHERE project_id = $1 AND last_seen_at > $3))
  RETURNING id
  ```
  （`$2=claimedBefore`、`$3=offlineBefore`；悬空 `claimed_by` 自然命中；单条原子；**返回 `rows.length`**（`RETURNING id` 风格，与 `releaseRegressionTasks` 一致；勿用 `rowCount`——pg-mem 适配层不可靠）。）memory 同语义（遍历判定）。
- `upsertRunner`：**DDL 不加表约束**；MIGRATIONS 追加两条（顺序固定）：①去重 `DELETE FROM runners WHERE id IN (SELECT r1.id FROM runners r1 JOIN runners r2 ON r1.project_id = r2.project_id AND r1.name = r2.name WHERE r1.last_seen_at < r2.last_seen_at OR (r1.last_seen_at = r2.last_seen_at AND r1.id < r2.id))`（**pg-mem 3.0.14 实测唯一可行形态**——窗口函数/`DELETE…USING`/相关 EXISTS/`NOT IN`+GROUP BY 均不可用；`project_id IS NULL` 行不参与，报告说明）②`CREATE UNIQUE INDEX IF NOT EXISTS runners_project_name_idx ON runners(project_id, name)`（幂等，新库/存量库一体覆盖）。实现改为：先 `INSERT ... RETURNING *`，捕获 `code === "23505"` → 按 `(project_id, name)` `UPDATE ... RETURNING *`；不再 SELECT 预检。
- [ ] **Step 1: 写失败测试**（`test/db-runners.test.js`；memory+pg-mem 双跑沿用该文件模式）
  - `releaseStaleClaims：超龄+失联→pending（清 claimed_by/at、attempts 保留、返回 1）；runner 在线→0 不动；未超龄→0；claimed_by 空且超龄→回收；running 同判；终态→0；跨项目隔离`。
  - `upsert：同名二次调用单行（id 不变、字段更新）；跨项目同名两行；23505 回退（同名已存在时 upsert 仍单行）`。
  - `迁移专项：pg-mem 建旧表（无唯一索引，夹具沿用 test/db-runners.test.js:400 的 noAstCoverageCheck: true 形态）＋插入重复行 → init() 后重复仅剩 last_seen_at 最新、唯一索引存在、二次 upsert 单行`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/db-runners.test.js`。
- [ ] **Step 3: 实现**（按「语义」；去重 SQL 以 pg-mem 可执行优先——若 pg-mem 不支持相关 EXISTS 写法，改用等价可执行写法并在报告说明）。
- [ ] **Step 4: 跑测试确认通过** + `npm run build`。
- [ ] **Step 5: 提交**：`git commit -m "feat(db): stale claim reclaim + atomic runner upsert (unique index)"`

### Task 2: store——`claimRegressionTask` 按端部分领取

**Files:**
- Modify: `src/db/types.ts`、`src/db/postgres.ts`、`src/db/memory.ts`
- Test: `test/db-runners.test.js`（**claim 语义测试确定落点**——既有 claim 语义/memory+pg-mem 双跑/无候选窗截断均在此文件；suite-task 的 claim 为 CLI 集成不承载 store 语义）

**Interfaces:**
- `claimRegressionTask(input)` 增可选字段：`onlineBefore?: string; allowPartial?: boolean`（缺省＝严格旧行为逐字）。
- 判定顺序（单次调用内拉一次在线 runner 列表：`SELECT platforms FROM runners WHERE project_id=$1 AND last_seen_at > $2`）：
  1. 候选中找「任务端 ⊆ 自身 platforms」的最早者（旧逻辑）→ CAS UPDATE 领取；
  2. 无则若 `allowPartial === true && onlineBefore provided`：对候选（按 created_at 升序）逐个：`intersection = taskPlatforms ∩ selfPlatforms`，若 `intersection.length >= 1` **且不存在他者在线 runner**（在线列表中排除 self——self 由 `input.platforms` 直接判定，避免心跳落库滞后；M3）满足 `taskPlatforms ⊆ runner.platforms` → 领取该候选（同一 CAS UPDATE）；否则继续下一个；全部不满足 → null；
  3. 否则 null。
- CAS 语句不变（`... AND status='pending'`）；memory 实现同语义。
- [ ] **Step 1: 写失败测试**
  - `旧行为回归：无新参数 → 严格子集（含 runner-agent:163 场景在 store 层等价断言）`。
  - `完全覆盖优先：双候选（完全覆盖的较新 vs 部分可领的较旧）→ 领完全覆盖者`。
  - `部分领取：无在线全覆盖（他者/自身均不覆盖）→ 领最早交集≥1 候选；有在线全覆盖 runner（他者）→ null 等待；有全覆盖自身 → 走完全覆盖路径`。
  - `allowPartial:false / onlineBefore 缺省 → null；交集 0 → null；CAS（预置 concurrent 领取後）→ 不重复领取`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过** + build。
- [ ] **Step 5: 提交**：`git commit -m "feat(db): optional partial-platform claim (wait when full coverage available)"`

### Task 3: runner agent——主循环回收＋部分领取接线

**Files:**
- Modify: `src/runner/agent.ts`
- Test: `test/runner-agent.test.js`（追加）

**Interfaces:**
- 主循环每轮（schedules 触发之前）：
  - `staleClaimMs`：**新写专用解析器**（`undefined/非法→900000`；`"0"→0`；正数→该值——**勿复用 `intFromEnv`**，其 `<=0` 回退默认会破坏关闭语义）；`>0` 时 `store.releaseStaleClaims({ rootPath, offlineBefore: new Date(now - runnerTtlMs).toISOString(), claimedBefore: new Date(now - staleClaimMs).toISOString() })`；返回 `>0` 日志 `[runner] 回收失联领取：N 条`。
  - `partial = env.AOS_RUNNER_PARTIAL_CLAIM === "1"`；领取调用传 `onlineBefore: new Date(now - runnerTtlMs).toISOString(), allowPartial: partial`。
  - `runnerTtlMs` 复用既有 helper（`src/runner/status.js` 的 `runnerTtlFrom`）＋当前 env。
  - 部分领取命中时日志明示缺端：`[runner] 领取任务 X（部分端 android，缺 ios——在线无全覆盖执行机）`。
- [ ] **Step 1: 写失败测试**（runner-agent 既有 harness：假 store 记录调用参数）
  - `回收：主循环调用 releaseStaleClaims 且参数 = now-TTL / now-900000（注入 now）；env "0" → 不调用；回收数>0 产生日志；顺序为 回收→触发→领取`（**顺序断言方法**：包一层 store——`releaseStaleClaims`/`createRegressionTask`（触发）/`claimRegressionTask` 各自 push 到共享 sequence 数组，断言出现序；注入 now 使触发真实发生）。
  - `部分领取：无 env → allowPartial=false 且 runner-agent:163 用例仍绿；env=1 → allowPartial=true 透传；部分命中日志含「部分端」与缺端平台`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过** + `npm run test:file -- test/runner-agent.test.js` 全绿 + `test/suite-task.test.js` 不回归 + build。
- [ ] **Step 5: 提交**：`git commit -m "feat(runner): reclaim stale claims each loop + opt-in partial claim"`

### Task 4: 文档＋全量回归

**Files:**
- Modify: `DESIGN.md`（§13.116）、`README.md`、`AGENTS.md`

- [ ] **Step 1: 全量回归**：`npm run build && npm test && npm run lint` → 全绿（记录新增测试数与总数）。
- [ ] **Step 2: 文档**
  - DESIGN §13.116：P2.x 实施记录（回收双条件与开关/attempts 保留/悬空口径；部分领取规则与默认关、缺端可见性；upsert 原子化与迁移去重；迁移 best-effort 残余口径；D1–D7 口径收束）。
  - README：runner 段补两项（回收语义与 `AOS_RUNNER_STALE_CLAIM_MS`；部分领取 `AOS_RUNNER_PARTIAL_CLAIM=1` 与缺端说明）。
  - AGENTS.md：runner 行补一句。
- [ ] **Step 3: 提交**：`git commit -m "docs: regression service P2.x hardening"`

---

## 独立复核修订记录（2026-10-16）

计划评审（deepseek/deepseek-v4-pro#high，只读，含 pg-mem 实测）结论「需先修订（1 Critical）」；发现已全部并入：

- **C1（Critical）**：迁移去重 SQL——相关 EXISTS/窗口函数/`DELETE…USING`/`NOT IN`+GROUP BY 在 pg-mem 3.0.14 **均不可用**；计划已钉死**实测唯一可行形态**（`id IN (自 JOIN 子查询)`，含并列 id 规则），并同步修订设计稿。
- **I1**：`releaseStaleClaims` 返回口径＝`rows.length`（`RETURNING id` 风格；勿用 `rowCount`）。
- **I2**：迁移专项夹具沿用 `test/db-runners.test.js:400` 的 `noAstCoverageCheck: true` 形态。
- **M1**：唯一索引**仅经 MIGRATIONS 建**（幂等覆盖新库/存量；DDL 不加表约束，避免双索引）——设计 §2.3/§4/D4 同步修订。
- **M2**：`project_id IS NULL` 行不参与去重（upsert 未注册即抛错，无实际影响，报告说明）。
- **M3**：部分领取「他者全覆盖」判定**排除 self**（self 用 `input.platforms` 直接判定）。
- **M4**：顺序断言方法写明（包 store 方法 push sequence 数组）。
- **M5**：`AOS_RUNNER_STALE_CLAIM_MS` 用**专用解析器**（勿复用 `intFromEnv` 的 `<=0` 回退）。
- **M6**：去重自 JOIN O(N²)/每次 init 可接受（`runners` 行数极小；顺序保持先去重后建索引）。

---

## 范围外（另立）

- claim 下推 SQL、并发领取执行级测试、多实例并发迁移、任务页/结果表级缺端标记、自动补跑缺端、回填扫描、真机 iOS 自动发现、artifact TOCTOU。
