# 回归服务 backfill 实施计划（回填扫描：幂等重建登记）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `suite backfill [--dry-run] [--json] [--project <dir>]`——只读扫描 `design/runs/*.json`（manifest）与 `design/case-sets/*.json`（归档），**幂等**重建 `suite_runs`/`suite_run_cases` 与 `case_sets`/`case_set_features` 登记；并给 manifest 增可选 `registration` 段（写侧补维度）。

**Architecture:** store 增只读查询 `listRegisteredManifestPaths`（项目域）；manifest additive 扩展 `registration?`（schemaVersion 不变、读侧宽容）；扫描/登记逻辑集中 `src/tasks/backfill.ts`（返回报告对象，命令层做 IO 输出）；`suite-command.ts` 增子命令接线。

**Spec:** `docs/superpowers/specs/2026-10-16-regression-service-backfill-design.md`（D1–D9 与复核记录 §9）

## Global Constraints

- 测试口径：pg-mem/内存 store、临时目录 + 真实写产物夹具、不触网；测试跑 `dist/`；`npm run build` 后跑测试；单文件 `npm run test:file -- test/xxx.test.js`。
- 相对导入一律带 `.js` 后缀；代码英文、用户文案中文；默认不加注释（仅保留解释非显然契约的 JSDoc）。
- **只读产物**：backfill 对 `<configDir>/design/` 不写任何文件（dry-run 与实跑均如此）。
- 幂等：重复运行第二次全部 skip（计数断言）；字段缺维度**如实 null 不猜**（platform 分类除外）。
- 完工标准：`npm run build && npm test && npm run lint` 全绿；同步 DESIGN（新增 §13.117）＋ README（命令与回填段）＋ AGENTS.md（命令表）。
- **拍板（D1–D9 摘要）**：CLI-only；runs 幂等键＝manifest_path（项目域）、sets 幂等键＝features[].jsonPath；manifest `registration?`（无 trigger；保存时点可得即写）；sets 一行/归档（单 feature）；trigger 回填＝`"cli"`（与在线一致）；fingerprint＝归档 sha、createdAt＝stamp（兜底 mtime）；basename＝归档 stem（展示项）；screens＝flows[].screens 摊平去重。

## Review Focus

1. **幂等与项目域**：`listRegisteredManifestPaths` 按 `project_id` 过滤；sets 去重以 `features[].jsonPath` 集合；重复运行全 skip（计数与零新增行双断言）。
2. **只读产物**：命令不改 `design/` 任一文件（含 dry-run）；实跑只写 DB。
3. **字段如实/口径**：feature 维度缺 → null（不进份血统聚合）；platform＝deviceSerial 分类 → registration.platform 兜底 → `"unknown"`；cases 的 flaky（retry.flaky）与 quarantine 口径与在线一致。
4. **manifest 扩展兼容**：schemaVersion 不变；`loadRunManifest` 对有/无 `registration` 均 ok（既有判别式测试不回归）；三保存点（run/loop/run --task）「可得即写」。
5. **命令层**：usage/白名单/`--json` 形状/`--dry-run` 文本标注/`--project`；exit 0；invalid 计数可见。

---

### Task 1: manifest 扩展 `registration?`（写侧可得即写）

**Files:**
- Modify: `src/figma/run-manifest.ts`、`src/suite-command.ts`（三处保存调用点传参）
- Test: `test/suite-run-manifest.test.js`（追加；读侧兼容断言）

**Interfaces:**
- Produces：
  ```ts
  export interface RunManifestRegistration {
    regressionTaskId?: string | null; caseSetId?: string | null;
    featureKey?: string | null; featureName?: string | null;
    platform?: string | null; appVersion?: string | null; runner?: string | null;
  }
  // RunManifest 增：registration?: RunManifestRegistration;（schemaVersion 不变）
  // buildRunManifest 增可选入参 registration（按实际签名放置于 options/deps）
  ```
- 语义：保存调用点「保存时点可得即写」——`suite run --task` 传可得者（refs/taskId/device→platform 分类/runner）；`suite run`/`suite loop` 传可得者（runner/deviceSerial 等）；**feature 维度保持缺省**。**钉死（复核 I1/I4/M1）**：`buildRunManifest` 为单入参 `BuildRunManifestInput`——`registration?` 加在该接口；**`appVersion` 无可得来源 → 恒不写（字段保留、值 null）**；写侧 `runner` 取 `io.runnerName ?? os.hostname()`（与在线登记 `input.runner ?? os.hostname()` 对齐）。`loadRunManifest` 不变（可选字段天然宽容）。
- [ ] **Step 1: 写失败测试**
  - `buildRunManifest(registration) 单测：带 registration → manifest 含字段；不带 → 无字段`。
  - `save/load roundtrip：含/不含 registration 均 load ok；既有 schemaVersion 判别不回归`（最小集成点即可，不必全链路 run --task——复核 M9；保存点唯一为 `persistRunManifest`）。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/suite-run-manifest.test.js`。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过** + `test/suite-task.test.js` 不回归 + build。
- [ ] **Step 5: 提交**：`git commit -m "feat(manifest): optional registration block (write-side dimensions)"`

### Task 2: store——`listRegisteredManifestPaths`

**Files:**
- Modify: `src/db/types.ts`、`src/db/postgres.ts`、`src/db/memory.ts`
- Test: `test/db-suite-runs.test.js`（追加）

**Interfaces:**
- Produces：`listRegisteredManifestPaths(rootPath: string): Promise<string[]>`——postgres：`SELECT manifest_path FROM suite_runs WHERE project_id = $1 AND manifest_path IS NOT NULL` → `rows.map(r => r.manifest_path)`；memory：本项目 runs 过滤非 null；项目不存在 → `[]`。
- [ ] **Step 1: 写失败测试**：`双跑：登记 2 条（1 条 manifest_path null）→ 返回仅非 null；跨项目隔离；未注册项目 → []`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过** + build。
- [ ] **Step 5: 提交**：`git commit -m "feat(db): listRegisteredManifestPaths (project-scoped)"`

### Task 3: `suite backfill` 命令

**Files:**
- Create: `src/tasks/backfill.ts`
- Modify: `src/suite-command.ts`（子命令白名单/usage/接线）
- Test: `test/suite-backfill.test.js`（新）

**Interfaces:**
- Consumes：Task 1（registration）、Task 2（`listRegisteredManifestPaths`）、`loadRunManifest`/`runManifestFileNames`、`platformOf`、`caseSetsDir`。
- Produces：
  ```ts
  export interface BackfillReport {
    scanned: { runs: number; caseSets: number };
    registered: { runs: number; caseSets: number };     // 实际写库数（dry-run 恒 0）
    wouldRegister: { runs: number; caseSets: number };  // 将登记数（dry-run 下有值；复核 I3）
    skipped: number; invalid: number; dryRun: boolean; warnings: string[];
  }
  export async function runBackfill(runtime: Runtime, options?: { dryRun?: boolean }): Promise<BackfillReport>;
  ```
- 语义：
  - **runs**：`runManifestFileNames`（已倒序＝时间倒序）→ `loadRunManifest`：ok → `manifest_path`（**取 `read.file`**，与落盘/`artifactUrl` 口径同源；复核 M2）已在 `listRegisteredManifestPaths` 集合 → `skipped++`；否则 `recordSuiteRun`（字段按设计 §2.2：trigger="cli"、gate.exitCode→status/exitCode、summary 计数、failureDomains、cases（flaky 口径＝retry.flaky===true；quarantined；traceId/failure）；**`createdAt = manifest.finishedAt`（保历史时序，防回填行聚集在扫描时刻）**；**`platform＝deviceSerial ? platformOf(deviceSerial) : (registration.platform ?? "unknown")`**（复核 I2：platformOf 恒有返回，勿写 `??` 链））；扩展维度有则填（appVersion 恒 null）；`registered.runs++`。`invalid`/`newer`/**`missing`** → `invalid++`＋warning（复核 M6）。**登记失败 → warning＋invalid++（best-effort 继续，不中断整体）**。
  - **caseSets**：readdir `*.json` **按 basename 升序**（钉死；复核 M7）→ parse（失败 invalid++）；**`!features[0] || !features[0].key || !features[0].name` → invalid++**（复核 M3）；jsonPath 已在（`listCaseSets(rootPath)` 全量摊平）集合 → skipped++；否则 `recordCaseSet`（§2.3：basename＝stem、**fingerprint＝`crypto.createHash("sha256")` 对该归档直算**（复核 M5；勿复用 `testsFingerprint`）、createdAt＝stamp 解析（**按首个 `_` 切分**；复核 M7）兜底 mtime、**designName 恒 null**（归档不含该字段；复核 M4）、features 单条、caseCount＝flows.length ?? counts.flows、screens＝flows[].screens 摊平去重；md/xlsx 缺失 → warning 仍登记）。
  - `dryRun` → 不写库（`registered` 计为 0，另以 `warnings`/文本列出「将登记 N 项」？**钉死**：dryRun 时 `registered` 填**将登记数**并置 `dryRun:true`，文本标注（不写库））。hmm——为可断言性：dryRun 下 `registered` 记录「将登记数」。
  - 命令：`suite backfill [--dry-run] [--json] [--project <dir>]`；文本输出计数行；`--json` 输出报告；exit 0（命令级异常 → 1；invalid>0 不改变退出码）。
- [ ] **Step 1: 写失败测试**（`test/suite-backfill.test.js`；临时目录写真实产物夹具）
  - `runs 回填：2 份 manifest（1 含 registration、1 不含）＋1 份已登记（预写 manifest_path）＋1 份坏 JSON → registered.runs=2、skipped=1、invalid=1；登记行字段（trigger="cli"/gate/计数/平台分类/扩展维度/缺维度 null）；cases 行与 flaky 口径`。
  - `sets 回填：1 归档三件套（缺 xlsx → warning 仍登记）＋1 已登记（预置 jsonPath）＋1 坏 JSON → 计数与字段（stem/fingerprint=sha/stamp/caseCount/screens）`。
  - `幂等：连跑第二次 → registered=0、skipped=全部`；`dry-run → 不写库（store 行数不变）、registered=0 且 wouldRegister=将登记数`；**各夹具同时断言 `scanned.runs/caseSets` 总数**（复核 M8）。
  - `命令层：usage 列出 backfill；--json 形状；--project；exit 0`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过** + build。
- [ ] **Step 5: 提交**：`git commit -m "feat(suite): backfill subcommand (runs + case sets, idempotent)"`

### Task 4: 文档＋全量回归

**Files:**
- Modify: `DESIGN.md`（§13.117）、`README.md`、`AGENTS.md`

- [ ] **Step 1: 全量回归**：`npm run build && npm test && npm run lint` → 全绿（记录新增测试数与总数）。
- [ ] **Step 2: 文档**
  - DESIGN §13.117：实施记录（命令/幂等键/两域扫描与字段口径/registration 扩展与兼容/只读产物/局限（既有任务 refs 不可复原、run/loop 默认 feature-null、「--tests 归档」backlog、无效产物计数）；D1–D9 口径收束）。
  - README：命令段补 `suite backfill`（用法、幂等、dry-run、局限一句）；AGENTS.md 命令表补。
- [ ] **Step 3: 提交**：`git commit -m "docs: regression service backfill"`

---

## 独立复核修订记录（2026-10-16）

计划评审（deepseek/deepseek-v4-pro#high，只读）结论「可执行，但需先修订 4 处 Important 口径」；已全部并入：

- **I1**：`appVersion` 无写侧来源 → 恒 null（字段保留）；T1 语义与设计 §2.2 同步。
- **I2**：platform 兜底表达式修正为 `deviceSerial ? platformOf(deviceSerial) : (registration.platform ?? "unknown")`（`platformOf` 恒有返回）。
- **I3**：dry-run 语义拆字段——`registered`＝实际写库数（dry-run 恒 0）、新增 `wouldRegister`＝将登记数。
- **I4**：写侧 `runner` 取 `io.runnerName ?? os.hostname()`（与在线对齐）。
- **M1/M2/M3/M4/M5/M6/M7/M8/M9**：registration 落点为 `BuildRunManifestInput`；`manifestPath` 取 `read.file`；`features[0]` 三缺判定；`designName` 恒 null；sha256 用 crypto 直算；`missing` 计入 invalid；sets 排序与 stamp 切分钉死；测试补 `scanned` 断言；T1 集成断言减负（build/roundtrip 即可）。

---

## 范围外（另立）

- 既有任务/引用的历史 id 修复；历史（regression 前）产物回填；增量监视/自动触发；产物改写/补全三件套；`--tests <归档>` 保存前 refs 解析（D8 backlog）。
