# 数据源 P0 移除实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 按已评审的 v2 设计落地 P0：默认允许部分下发、来源与目标主机解耦、脚本集惰性生成/过期重建、模块与用例 ID 过滤真正生效。

**Architecture:** 数据源归项目、执行归主机；脚本集是 Excel/包的派生资产，由 `createWebJob` 在缺省/过期时按 rules-only 生成；幂等由 `web_assets.dedupe_key` 唯一索引兜底；runner 从脚本 manifest 读取 `module` 与 `caseId→flow`，过滤后只把选中的 flow 传给 Maestro。

**Tech Stack:** TypeScript ESM + NodeNext + strict、Node test runner、exceljs、pg-mem、Maestro YAML。

**Spec:** `docs/superpowers/specs/2026-11-04-data-source-restrictions-design.md` v2；默认值表见 `DESIGN.md` §13.302。

## Global Constraints

- 测试先构建：改动后 `npm run build` 再 `node --test`；单文件用 `npm run test:file -- test/<name>.test.js`。
- 不依赖真实 PG/设备/外网；PG 分支用 pg-mem。
- 相对导入带 `.js` 后缀；用户可见文案中文，代码标识符英文。
- PASS 必须有断言证据；未验证只能 UNVERIFIED；secret 不落 CAS/明文；iOS Maestro 仅模拟器。
- 默认值只以 `DESIGN.md` §13.302 为准；旧平台 spec 已标 superseded。
- 完成门槛：`npm run build && npm test && npm run lint` 全绿，并更新 `DESIGN.md`。

## Review Focus

- 省略 `allowPartialUnresolved` 的调用方：必须从 409 变为创建 partial 任务；显式 false 仍严格。
- 目标主机未登记项目：来源仍可见，但确认按钮禁用；读取失败不能伪装成“没有用例集”。
- 并发/重复下发：同一 Excel/包/平台只应复用同一 scripts 资产，不能堆版本。
- 模块/中文 caseId 过滤：必须真的只执行选中的 flow，不能只过滤结果映射。
- 自动生成失败：不能建任务、不能伪造 ready；错误必须是 4xx 且带逐例原因。

---

### Task 1: 默认允许部分下发（R2）

**Files:**
- Modify: `src/panel/actions.ts`（`parseWebJobCreateForm` 的 `allowPartialUnresolved`）
- Modify: `src/web/jobs.ts`（默认值判断 + spec 写入）
- Modify: `src/console/pages.ts`（复选框默认勾选、始终提交布尔值、文案）
- Test: `test/web-job-queue.test.js`、`test/web-dispatch-ui.test.js`

**Interfaces:**
- Produces: `allowPartialUnresolved` 省略/undefined → `true`；显式 `false`/`"false"` → `false`。

- [x] 写失败测试：`createWebJob` 对 `unresolved=1` 的脚本集，省略字段 → 成功且 `jobSpec.allowPartialUnresolved===true`；显式 `false` → `script-set-incomplete` 409。
- [x] 写失败测试：`parseWebJobCreateForm` 省略 → true，`false`/`"false"` → false；面板 HTML 复选框带 `checked`，内联脚本始终发送该字段。
- [x] 跑测试确认失败。
- [x] 改 `jobs.ts`：`const allowPartial = input.allowPartialUnresolved !== false;`，spec 写 `allowPartial`；只有 `allowPartial === false && unresolved>0` 才抛 409。
- [x] 改 `actions.ts`：解析为 `!(raw === false || raw === "false")`。
- [x] 改 `pages.ts`：`<input id="web-job-allow-partial" type="checkbox" checked ...>`；脚本 `out.allowPartialUnresolved = byId(...).checked`；文案“未就绪用例写 SKIP（不计 PASS）”。
- [x] 跑测试通过，提交 `feat: default to partial web job dispatch`。

### Task 2: 模块/用例 ID 过滤真正生效（R11）

**Files:**
- Modify: `src/web/script-gen.ts`（`ScriptGenCaseInput.module`）
- Modify: `src/web/script-set.ts`（manifest summary 增加 `module`）
- Modify: `src/web/script-generation.ts`（传入 `module`）
- Modify: `src/runner/web-executors.ts`（读 manifest、过滤 flow、按 caseId 输出）
- Test: `test/web-script-set.test.js`、`test/web-executors.test.js`

**Interfaces:**
- Produces: `ScriptSetCaseSummary.module: string | null`；manifest case 形如 `{caseId, module, flow, ...}`。
- Produces: runner 过滤后 `maestro test` 参数传选中 flow 文件路径（有过滤时），无过滤时保持传目录。

- [x] 写失败测试：`buildScriptSetBundle` 收到 `cases:[{caseId:"TC-1",module:"登录",...}]`，manifest 对应 case `module==="登录"`。
- [x] 写失败测试：runner 工作区写 `manifest.json`（jobDir 下），`caseFilter.modules:["登录"]` 时只执行 flow-a；`caseIds:["中文 用例"]` 能匹配 manifest caseId；未知模块 → `case-filter-no-match`；无 manifest + 模块过滤 → `case-filter-modules-unsupported`。
- [x] 跑测试确认失败。
- [x] 改 `script-gen.ts` 类型与 `script-set.ts` summary（按 `input.cases[index].module` 取值）。
- [x] 改 `script-generation.ts` 传 `module: entry.module`。
- [x] 改 `web-executors.ts`：新增 `readScriptManifest(flowsDir)`；构建 `caseId→{flow,module}`；过滤 `flowFiles`；有过滤时 exec 参数用 `flowFiles` 而不是目录；JUnit 结果 `caseId` 用 manifest caseId，断言/手工步骤仍按 stem 查。
- [x] 跑测试通过，提交 `fix: apply web case filters from script manifest`。

### Task 3: 套件来源与目标主机解耦（R3）

**Files:**
- Modify: `src/console/dispatch.ts`（`DispatchPreview.sourceStore`、来源解析、失败示因）
- Modify: `src/console/pages.ts`（如需显示 tier；优先用 warnings 横幅）
- Test: `test/console-dispatch.test.js`、`test/panel-dispatch-hosts.test.js`

**Interfaces:**
- Produces: `DispatchPreview.sourceStore: { tier: "target"|"owner"|"global"; hostId: string|null; error: string|null }`。
- Produces: `resolveSourceStore` 不静默回落：owner 作用域不可用 → `sourceStore.error="source-store-unavailable"`，`setOptions=[]` 且有 warning。

- [x] 写失败测试：项目登记在 host-a、case set 也在 host-a；目标 host-b 未登记项目 → `setOptions` 仍含 case set，`hostBlocked===true`，`sourceStore.tier==="owner"`。
- [x] 写失败测试：owner store 的 `getProjectByPath`/`listCaseSets` 抛错 → warning 含“来源读取失败”，`sourceStore.error` 非空，不是静默空。
- [x] 跑测试确认失败。
- [x] 改 `dispatch.ts`：抽出 `resolveSourceStore`；target 有项目用 target；否则未作用域查 owner.hostId → owner store；owner 无 hostId → 全局；读取异常 catch 后写 warning；`listCaseSets` 改用 source store；返回 `sourceStore`。
- [x] 保持 `hostBlocked` 逻辑不变；只在 rootPath 非空时解析 owner。
- [x] 跑测试通过，提交 `feat: decouple dispatch source from target host`。

### Task 4: 生成脚本集幂等（M1）

**Files:**
- Modify: `src/db/types.ts`（`CreateWebAssetInput.dedupeKey?`）
- Modify: `src/db/postgres.ts`（表列、迁移、createWebAsset 冲突处理）
- Modify: `src/db/memory.ts`（dedupe map；`scopeHost` 共享）
- Modify: `src/web/assets.ts`（透传 dedupeKey）
- Modify: `src/web/script-set.ts`（`storeScriptSet` 传 `sha256`）
- Test: `test/web-assets.test.js`、`test/web-script-set.test.js`

**Interfaces:**
- Consumes: `storeWebAsset({..., dedupeKey: bundle.sha256})`
- Produces: 同一 `(rootPath, kind, dedupeKey)` 只保留一行；`createWebAsset` 冲突返回已有记录。

- [x] 写失败测试：pg-mem 下 `createWebAsset` 同 `dedupeKey` 两次 → 同 id、同 version、列表 1 行；不同 dedupeKey → version 递增。
- [x] 写失败测试：`storeScriptSet` 连续两次同 bundle → `created:false`、同 asset id；manifest 无时间戳字段（守卫测试）。
- [x] 跑测试确认失败。
- [x] 加列/索引：建表语句与迁移都加 `dedupe_key TEXT`、`CREATE UNIQUE INDEX ... (root_path, kind, dedupe_key)`；不加入 REQUIRED_INDEXES。
- [x] 改 `PostgresStore.createWebAsset`：有 dedupeKey 先查；插入写列；23505 时查 dedupe 行返回，否则按现有 version 重试。
- [x] 改 `MemoryStore.createWebAsset`：`webAssetDedupe` map，命中返回已有；`scopeHost` 共享。
- [x] 跑测试通过，提交 `feat: make generated script sets idempotent`。

### Task 5: 下发时惰性生成（R1）

**Files:**
- Modify: `src/web/script-generation.ts`（`timeoutMs`/deadline、`ScriptGenerationTimeoutError`）
- Modify: `src/web/script-gen.ts`（`options.deadlineMs`，逐例检查）
- Modify: `src/web/script-set.ts`（bundle 透传 deadline）
- Modify: `src/web/jobs.ts`（缺脚本/生成失败/审计结果字段）
- Modify: `src/web/job-spec.ts`（新增错误码与状态）
- Modify: `src/panel/actions.ts`（响应透传 + 审计）
- Modify: `src/console/pages.ts`（去掉前端拦截 + 提示）
- Test: `test/web-job-queue.test.js`、`test/web-dispatch-ui.test.js`、`test/web-script-set.test.js`

**Interfaces:**
- Produces: `CreateWebJobResult.script: { id; autoGenerated; rebuiltFrom; ready; partial; unresolved; runnable } | null` 与 `warnings: string[]`。
- Produces: 错误码 `script-generation-failed` 400、`script-generation-timeout` 400、`script-set-rebuild-failed` 409。

- [x] 写失败测试：真实 xlsx + 假包，`scriptSetId:null`/maestro → 自动生成 scripts 资产、任务 `jobSpec.scriptSetId` 非空、`result.script.autoGenerated===true`。
- [x] 写失败测试：Excel 损坏 → `script-generation-failed` 400，不建任务。
- [x] 写失败测试：假生成器超过 `AOS_WEB_SCRIPT_GEN_TIMEOUT_MS` → `script-generation-timeout` 400。
- [x] 写失败测试：前台 HTML 不再含“Maestro 执行需要脚本集”，含“不指定时自动生成”。
- [x] 跑测试确认失败。
- [x] 加 deadline：`generateScriptSet` 每例检查 `Date.now() > deadlineMs` 抛 `ScriptGenerationTimeoutError`；`generateScriptSetForProject` 接收 `timeoutMs`（默认 env `AOS_WEB_SCRIPT_GEN_TIMEOUT_MS` 30000）并传 deadline。
- [x] 改 `createWebJob`：`let script`；`executionMode=maestro && script===null` 时调用生成（bestEffort true、precondition auto、inferNavigationTap true、rules-only、appId=webProject.appPackage）；成功加载 `result.asset`；失败映射错误码；返回 `script`/`warnings`。
- [x] 改 `actions.ts`：响应加 `autoGeneratedScript`/`script`/`warnings`；成功生成时写审计 `web.scripts.generate`，summary 带 `trigger=dispatch`。
- [x] 改 `pages.ts`：删除 `if(out.executionMode==="maestro"&&!out.scriptSetId){...}`；脚本集旁提示；flash 带自动生成信息。
- [x] 跑测试通过，提交 `feat: generate web scripts on dispatch`。

### Task 6: 过期脚本自动重建（R4）

**Files:**
- Modify: `src/web/jobs.ts`（匹配失败 → 重建/允许旧脚本）
- Modify: `src/panel/actions.ts`（响应 `rebuiltScriptSet` + 审计）
- Modify: `src/console/pages.ts`（提示重建）
- Test: `test/web-job-queue.test.js`、`test/web-dispatch-ui.test.js`

**Interfaces:**
- Consumes: Task 5 的生成入口与 deadline；Task 4 的幂等。
- Produces: `CreateWebJobResult.script.rebuiltFrom: string | null`；`warnings` 含 `stale-script` 或 `script-set-rebuilt`。

- [x] 写失败测试：脚本集绑定 v1 Excel，任务用 v2 → 自动生成绑定 v2 的新脚本集，`jobSpec.scriptSetId !== 旧 id`，`script.rebuiltFrom===旧 id`，审计 `trigger=rebuild`。
- [x] 写失败测试：显式 `allowStaleScript:true` → 仍用旧 id，warning `stale-script`。
- [x] 写失败测试：重建失败（假 Excel）→ 409 `script-set-rebuild-failed`。
- [x] 跑测试确认失败。
- [x] 改 `createWebJob`：`try assertScriptSetMatch`；捕获 `script-set-mismatch`/`script-set-unverified`；`allowStaleScript` 为 true 保留旧；否则调用 Task 5 生成并替换；失败抛 `script-set-rebuild-failed`。
- [x] 改 action 响应与审计 `web.scripts.generate`（trigger=rebuild、from/to）。
- [x] 跑测试通过，提交 `feat: rebuild stale web scripts on dispatch`。

### Task 7: 文档与全量验证

**Files:**
- Modify: `DESIGN.md` §13.302（状态改为已实现 + 实现记录）
- Modify: `README.md`（如命令/默认值有变化）
- Test: 全量

- [x] 更新 `DESIGN.md` §13.302 状态、错误码、默认值；补实现记录与测试数。
- [x] 如 README 提到脚本集必选/unresolved 默认拒绝，改为新行为。
- [x] 跑 `npm run build && npm test && npm run lint`，记录结果。
- [x] 提交 `docs: record data source p0 implementation`。
