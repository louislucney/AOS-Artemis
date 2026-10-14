# 回归服务 P3a 实施计划（定时回归：schedules + runner 触发）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按计划自动执行回归——`schedules`（项目级：功能 keys×端×节奏）到期时由项目机 runner 自动创建回归任务（引用**实时解析最新份**），正常领取执行；面板可见调度状态与最近任务。

**Architecture:** 调度定义存中心 PG；**触发 host＝runner**（项目机常驻进程，每次主循环迭代检查到期——CAS 守卫保证多 runner 并发下每窗口恰好触发一次）；触发即 `createRegressionTask(createdBy="schedule:<name>")`，由同一（或任意）runner 的既有领取循环执行——**不新增执行路径**。补跑语义＝上线仅补一次（fire-once-on-catch-up）。面板只读展示；管理走 CLI（v1）。

**Spec:** `docs/superpowers/specs/2026-10-14-regression-service-design.md`（§5.5 下发与执行；§7 P3「定时回归」）；P2 基础见 `DESIGN.md` §13.109（本计划新增 §13.110）。

## Global Constraints

- 测试口径（仓库硬性）：pg-mem、假子进程/假执行器、不触真实 PG/设备/外网；测试跑 `dist/`（改动先 `npm run build`）；单文件 `npm run test:file -- test/xxx.test.js`。
- 相对导入一律带 `.js` 后缀；代码英文、用户文案中文；默认不加注释（仅保留解释非显然契约的 JSDoc）。
- stdout 属于 MCP stdio：runner/CLI 日志按既有约定（runner 走 `log()`，CLI 子命令输出除外）。
- 完工标准：`npm run build && npm test && npm run lint` 全绿；行为变更同步 DESIGN.md（新增 §13.110）+ README + AGENTS.md（命令表）。
- **拍板（本计划）**：
  - 节奏 v1 **仅 interval**（`--every <minutes>`，最小 5 分钟；cron/每日定点/时区列 P3+）。
  - 触发在 runner（`AOS_RUNNER_SCHEDULES=0` 关闭，默认开；`--once` 亦检查一次）；**CAS 守卫**（`UPDATE ... WHERE enabled AND (last_fired_at IS NULL OR last_fired_at <= cutoff)`）保证并发单触发。
  - **引用按 featureKey 实时解析**（触发时取该功能最新份——份重新生成后自动跟随；不冻结 caseSetId）。
  - 部分 key 不可解析 → 用可解析子集建任务并记 `last_note`；**全部不可解析 → 跳过本次**（仍推进窗口，`last_note` 如实记录；避免每 tick 重试风暴）。
  - 补跑＝**仅补一次**：CAS 推进 `last_fired_at=now`，下一窗口从 now 起算。
  - 面板**只读**展示（管理走 `suite schedule` CLI；面板动作层扩展列 backlog）。
  - 触发失败（建任务抛错）→ 告警日志 + `last_note`；不打断 runner 主循环。

## Review Focus

1. **并发双触发**：两个 runner 同时到期 → CAS 恰好一个成功（另一个静默跳过）；窗口边界（恰等于 `every` 时到期）。
2. **引用时效**：触发前重新生成份（同名 feature key 新份）→ 触发使用最新份；旧份被清理不报错。
3. **补跑风暴防护**：runner 离线跨越多个窗口 → 上线只建**一个**任务；连续窗口异常不刷屏循环。
4. **触发失败不阻断**：`createRegressionTask`/CAS 抛错 → 日志 + 继续领取主循环（runner 不退出、队列不卡）。
5. **禁用/删除语义**：`disable` 后不再触发（在途已建任务照常执行）；`remove` 后无引用残留。

---

### Task 1: store——`schedules` 表与 CRUD + 窗口 CAS

**Files:**
- Modify: `src/db/types.ts`、`src/db/postgres.ts`、`src/db/memory.ts`
- Test: `test/db-schedules.test.js`（新）

**Interfaces:**
- Produces：
  ```ts
  // db/types.ts
  export interface ScheduleRecord {
    id: string; projectId: string | null; name: string;
    featureKeys: string[]; platforms: string[]; baseline: "latest" | "none";
    everyMinutes: number; enabled: boolean;
    lastFiredAt: string | null; lastNote: string | null;
    createdAt: string; createdBy: string | null;
  }
  export interface CreateScheduleInput {
    rootPath: string; name: string; featureKeys: string[]; platforms: string[];
    baseline: "latest" | "none"; everyMinutes: number; createdBy?: string | null;
  }
  // ProjectStore 接口新增：
  createSchedule(input: CreateScheduleInput): Promise<ScheduleRecord>;
  listSchedules(rootPath: string, limit?: number): Promise<ScheduleRecord[]>;   // createdAt 新→旧
  getSchedule(rootPath: string, id: string): Promise<ScheduleRecord | null>;
  updateSchedule(rootPath: string, id: string, patch: {
    enabled?: boolean; everyMinutes?: number; lastNote?: string | null;
  }): Promise<boolean>;                                                          // 键缺省不动
  deleteSchedule(rootPath: string, id: string): Promise<boolean>;
  /** 窗口 CAS：仅当 enabled 且（从未触发或 last_fired_at <= cutoff）时推进 last_fired_at=firedAt。 */
  claimScheduleWindow(input: {
    rootPath: string; scheduleId: string; firedAt: string; cutoff: string;
  }): Promise<boolean>;
  ```

- [ ] **Step 1: 写失败测试**（`test/db-schedules.test.js`；pg-mem + memory 双跑）
  - `createSchedule/listSchedules：落库（enabled=true、lastFiredAt/lastNote=null）+ createdAt 新→旧 + limit`。
  - `create/get/update（enabled/everyMinutes/lastNote；键缺省不动）/delete（再查 null；删除不存在 → false）`。
  - `claimScheduleWindow：首次触发（lastFiredAt null）→ true 并落 firedAt；未到期（firedAt 推进后立即再领）→ false；恰等于窗口（cutoff 边界）→ true；disabled → false；不同项目 id → false`。
  - `契约定型：claimScheduleWindow 返回 false 时 last_fired_at 不变`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/db-schedules.test.js`。
- [ ] **Step 3: 实现**
  - DDL（postgres SCHEMA 数组内，新表无需 MIGRATIONS）：
    ```sql
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      name TEXT NOT NULL, feature_keys TEXT NOT NULL, platforms TEXT NOT NULL,
      baseline TEXT NOT NULL DEFAULT 'latest', every_minutes INTEGER NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE, last_fired_at TEXT, last_note TEXT,
      created_at TEXT NOT NULL, created_by TEXT
    )
    ```
    （`feature_keys/platforms` 为 JSON 文本；`enabled` 真值用 1/0 兼容 pg-mem：实现里写 `TRUE/FALSE` 均可，读出用 `Boolean(...)` 宽容。）
  - CRUD：`getProjectByPath` 校验（未注册项目 → create 抛「未注册」、其余返回 null/[]）；`deleteSchedule`＝DELETE 返回 rowCount>0；memory 同语义（`cloneSchedule` 深拷贝数组）。
  - `claimScheduleWindow`（postgres）：`UPDATE schedules SET last_fired_at=$3 WHERE project_id=$1 AND id=$2 AND enabled AND (last_fired_at IS NULL OR last_fired_at <= $4) RETURNING id`；memory 同逻辑（`entry.enabled && (entry.lastFiredAt === null || entry.lastFiredAt <= cutoff)`，ISO 字符串比较即可）。
- [ ] **Step 4: 跑测试确认通过** + `npm run build`。
- [ ] **Step 5: 提交**：`git commit -m "feat(schedule): schedules table with CRUD + window CAS (store)"`

### Task 2: 引用解析共享化 `src/tasks/feature-refs.ts`

**Files:**
- Create: `src/tasks/feature-refs.ts`
- Modify: `src/suite-command.ts`（删除本地实现改 import）
- Test: `test/feature-refs.test.js`（新）

**Interfaces:**
- Produces：
  ```ts
  export interface ResolvedTaskRef {
    caseSetId: string; featureKey: string; featureName: string; caseCount: number; jsonPath: string;
  }
  /** 每个 feature key 取最新一份（listCaseSets 新→旧首次出现）。 */
  export function latestFeatureRefs(sets: Array<{
    id: string;
    features: Array<{ key: string; name: string; caseCount: number; jsonPath: string }>;
  }>): Map<string, ResolvedTaskRef>;
  ```
- Consumes：`src/suite-command.ts` 的既有私有 `latestFeatureRefs`/`ResolvedTaskRef`（原样迁移；`suiteTaskCreate` 改 import，行为零变化）。

- [ ] **Step 1: 写失败测试**：`两队份同 key → 取含新份；不同 key 各自取最新；空集 → 空 Map`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/feature-refs.test.js`。
- [ ] **Step 3: 实现**（从 suite-command.ts 迁移原实现与接口；suite-command 改为 `import { latestFeatureRefs, type ResolvedTaskRef } from "./tasks/feature-refs.js";` 并删除本地定义——**逐字迁移、不改逻辑**；`test/suite-task.test.js` 既有「解析最新份」测试作为行为回归锁）。
- [ ] **Step 4: 跑测试确认通过** + `npm run test:file -- test/suite-task.test.js`（既有 21 条不回归）。
- [ ] **Step 5: 提交**：`git commit -m "refactor(tasks): extract latestFeatureRefs to shared module"`

### Task 3: 触发逻辑 `src/runner/schedules.ts`

**Files:**
- Create: `src/runner/schedules.ts`
- Test: `test/fire-schedules.test.js`（新；MemoryStore + 假 io）

**Interfaces:**
- Consumes：Task 1（schedules store 方法）、Task 2（`latestFeatureRefs`）。
- Produces：
  ```ts
  export interface FireSchedulesOptions {
    store: ProjectStore;
    rootPath: string;
    now?: () => number;
    io?: { log: (line: string) => void; errorLog: (line: string) => void };
  }
  /** 检查到期调度：CAS 赢窗口 → 实时解析最新份 → createRegressionTask；返回新建任务数。
   * best-effort：任何异常仅告警，不抛出。 */
  export async function fireDueSchedules(options: FireSchedulesOptions): Promise<number>;
  ```
- 语义：`listSchedules`（enabled）→ `now - lastFiredAt >= everyMinutes*60_000`（`lastFiredAt null` → 到期）→ `claimScheduleWindow(claim…)`（**先 CAS 后建**）→ 成功者：`listCaseSets` + `latestFeatureRefs` 解析 featureKeys：
  - 全部命中 → `createRegressionTask({ refs, platforms, baseline, createdBy: \`schedule:${name}\` })` + `updateSchedule({ lastNote: null })` + 日志「触发 <name> → 任务 <id>」；
  - 部分命中 → 用子集建任务 + `updateSchedule({ lastNote: \`缺 ${missing.join(",")}\` })` + 告警；
  - 全miss → **不建任务** + `updateSchedule({ lastNote: "引用份均不可用" })` + 告警；
  - CAS 败（他 runner 赢）→ 静默跳过；建任务抛错 → 告警 + `lastNote: "触发失败：…"`（窗口已消费，下窗口重试）。

- [ ] **Step 1: 写失败测试**
  - `到期（lastFiredAt null / 超过 every）→ 建任务：refs 为最新份、createdBy=schedule:<name>、platforms/baseline 原样；lastFiredAt 推进、lastNote null`。
  - `未到期 → 不建、不变`；`disabled → 不建`；`窗口边界（恰等于 every）→ 触发`。
  - `引用时效：触发前写入新份（同 key）→ 任务 refs 指向新份 id`。
  - `部分引用缺失 → 子集建任务 + lastNote 记缺项`；`全缺失 → 不建 + lastNote=引用份均不可用 + 窗口已推进`。
  - `跨多窗口仅补一次：lastFiredAt 推进到很久以前（如 10×every）→ 一次触发并推进到 now；紧接着再 fire → 不再触发（不风暴）`。
  - `CAS 竞争：预先把 lastFiredAt 推到 now（另一 runner 已领）→ 不建任务、由该函数不重复消费`。
  - `store 抛错（listSchedules / createRegressionTask 桩抛错）→ 返回 0、不抛、io.errorLog 有事由`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/fire-schedules.test.js`。
- [ ] **Step 3: 实现**（按「语义」；整体 try/catch；`io` 默认用 console）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(schedule): due-window firing (CAS + latest-case-set resolution)"`

### Task 4: agent 集成（主循环触发 + `AOS_RUNNER_SCHEDULES`）

**Files:**
- Modify: `src/runner/agent.ts`
- Test: `test/runner-agent.test.js`（追加）

**Interfaces:**
- Consumes：Task 3（`fireDueSchedules`）。
- 语义：主循环每轮迭代**先触发再领取**：`if (schedulesEnabled) await fireDueSchedules({ store, rootPath, now, io })`——`schedulesEnabled`＝`options.schedulesEnabled ?? (env.AOS_RUNNER_SCHEDULES ?? "").trim() !== "0"`（新增选项 `schedulesEnabled?: boolean`，测试注入）；`--once` 同样触发一次；触发在 try/catch 内（`fireDueSchedules` 自身不抛，仍兜底）。

- [ ] **Step 1: 写失败测试**
  - `once：到期调度 → 触发建任务且本轮即被领取执行（假执行器置终态；argv 指向新任务）`。
  - `schedulesEnabled:false（或 env AOS_RUNNER_SCHEDULES=0）→ 不触发（无任务创建）`。
  - `跨窗口连续触发：now 推进触发一次后，再推进超过 every → 第二轮再触发（fire 计数 2）`。
  - `未到期不触发；触发失败（store.createRegressionTask 桩抛错 → fireDueSchedules 内部兜底）不打断领取循环（后续可领任务照常执行）`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/runner-agent.test.js`。
- [ ] **Step 3: 实现**（按「语义」；日志前缀 `[runner]`）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(runner): fire due schedules in main loop (AOS_RUNNER_SCHEDULES=0 off)"`

### Task 5: CLI `suite schedule`

**Files:**
- Modify: `src/suite-command.ts`（子命令路由/白名单、usage、实现）
- Test: `test/suite-schedule.test.js`（新）

**Interfaces:**
- Consumes：Task 1（store）、Task 2（`latestFeatureRefs`）。
- 用法：
  ```
  aos-mcp suite schedule add --ref <featureKey>… [--platform ios|android]… [--baseline latest|none]
                            --every <minutes> [--name <n>] [--project <dir>] [--json]
  aos-mcp suite schedule list|show <id>|enable <id>|disable <id>|remove <id>
  ```
  - `add`：key 解析校验（取最新份；未知 key → exit 2 列可用项，复用 suiteTaskCreate 口径）；`--platform` 白名单+去重；`--every` 整数 ≥5 否则 exit 2；`--name` 缺省＝第一个 featureKey；成功输出 id/简要（`--json` 全量）。
  - `list`：文本（`id · name · every · enabled · lastFiredAt · lastNote`）或 `--json`。
  - `show/enable/disable/remove`：未知 id → exit 2；enable/disable 幂等（已是目标值输出提示仍 0？**定：仍 0 并提示已启用/停用**，与「无需释放」相反——避免脚本误判，语义上幂等成功）。
  - `suite schedule` 加入子命令白名单与 `printSuiteUsage`（含参数一行）。
- [ ] **Step 1: 写失败测试**
  - `add：落库（name/every/platforms/baseline/enabled=true）+ 输出 id；未知 ref → exit 2；--every 3 → exit 2；--platform windows → exit 2`。
  - `list：文本与 --json`。
  - `enable/disable/remove：状态变化与幂等提示；未知 id → exit 2`。
  - `usage 列出 suite schedule`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（按「用法」）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(suite): schedule subcommand (add/list/show/enable/disable/remove)"`

### Task 6: 面板——定时回归区块 + 任务来源

**Files:**
- Modify: `src/panel/overview.ts`、`src/panel/web.ts`
- Test: `test/panel-overview.test.js`、`test/panel-web.test.js`

**Interfaces:**
- Produces：
  ```ts
  export interface PanelScheduleView {
    id: string; name: string; featureKeys: string[]; platforms: string[];
    baseline: "latest" | "none"; everyMinutes: number; enabled: boolean;
    lastFiredAt: string | null; lastNote: string | null;
    lastTaskId: string | null; lastTaskStatus: string | null;
  }
  // PanelProjectDetail 增 schedules: PanelScheduleView[]
  ```
  `lastTask`：在既有 `listRegressionTasks(rootPath, 20)` 结果（buildPanelProjectDetail 已取，为 tasks 行复用——需保留 `createdBy`）中按 `createdBy === \`schedule:${name}\`` 取最近一条。
- 渲染（web.ts）：
  - 项目页 section「定时回归（schedule）」：名称/功能 keys/端/节奏（`每 N 分钟`）/启用状态/上次触发（含 `lastNote` 标注）/最近任务链接（`taskHref`）；空态提示 `node dist/cli.js suite schedule add …`。
  - 任务页：status 行追加 `· 来源 <createdBy>`（createdBy 非空时；`schedule:<name>` 更醒目可加 `<code>`）。
- [ ] **Step 1: 写失败测试**
  - `panel-overview: schedules 聚合（含 lastTask 匹配 schedule:<name> 最近一条；无匹配 → null；无调度 → []）`。
  - `panel-web: 项目页定时回归区块（节奏/启用/上次触发/lastNote/最近任务链接）`。
  - `panel-web: 任务页来源显示（schedule: 前缀）`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（单次 listRegressionTasks 复用；全字段 escapeHtml）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): schedule section + task source badge"`

### Task 7: 文档 + 全量回归

**Files:**
- Modify: `DESIGN.md`（新增 §13.110）、`README.md`、`AGENTS.md`
- [ ] **Step 1: 全量回归**：`npm run build && npm test && npm run lint` → 全绿（记录新增测试数与总数）。
- [ ] **Step 2: 文档**
  - DESIGN §13.110：P3a 实施记录（schedules 表/CAS 窗口/runner 触发/实时份解析/补跑一次/`AOS_RUNNER_SCHEDULES`/面板只读/CLI 清单；口径 bullet：interval-only、min 5、部分缺失子集+fnote、全缺失跳过仍推进窗口）。
  - README：runner 小节补「定时回归」段（CLI 示例、语义、与手动/面板路径关系）；面板章节补 schedule 区块与任务来源。
  - AGENTS.md：命令表「测试闭环（CLI）」行加 `suite schedule`；关键机制速查 runner 行补触发一句。
- [ ] **Step 3: 提交**：`git commit -m "docs: regression service P3a (scheduled regression)"`

---

## 范围外（另立计划）

- **P3b**：改进出口接线（裁决 → 一键建单/重生成联动；需先方案讨论）。
- **P3c/P3d**：跨项目对比；动作层与产物服务鉴权升级。
- 调度增强（cron/每日定点/时区、错峰、面板管理动作、schedule 编辑/改名、失败自动重建任务、多项目共享模板）列 P3+。
- P2.x 加固遗留（§13.109）：claimed 自动超时重置、按端部分领取、`upsertRunner` 原子性、claim 平台过滤下推 SQL。
