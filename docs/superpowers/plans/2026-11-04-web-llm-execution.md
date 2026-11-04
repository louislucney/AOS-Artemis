# Web LLM 执行 P0（远程 Android）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `executionMode=llm` 的远程 Android Web 任务由中心 LLM Worker 执行，runner 只做设备网关；敏感内容不进 LLM，证据/UNVERIFIED/计费按 v3 设计落契约。

**Architecture:** 中心新增 `web llm-worker`：按 `executionMode` 领取任务，每用例启动一个 ARTEMIS 子进程（经现有 `Runtime`/proxy），入口脱敏 + ARTEMIS hooks 注入/观察脱敏，L1 原始证据判定，结果走 center-only ingest。runner 新增 gateway 注册/SSH 反向隧道/安装控制面，不执行 LLM、不持 key。

**Tech Stack:** TypeScript ESM + NodeNext + strict、Node test runner、pg-mem、Python ARTEMIS hooks、SSH `-R`。

**Spec:** `docs/superpowers/specs/2026-11-04-llm-execution-design.md` v3；结果契约参考 `src/web/results.ts`；ARTEMIS 入口 `src/artemis/assembly.ts`。

## Global Constraints

- LLM key 只在中心/项目 `.env`；runner 不接收 key。
- 必须远程；P0 只做 Android（adb server 网关），iOS/P0b 另计划。
- 账号/密码/token 不得进 LLM prompt、日志、trace、审计；`AOS_WEB_LLM_REDACT_STRICT=1` 默认。
- 不允许伪造 PASS；无 L1/L2 确定性证据 → `UNVERIFIED`；runner HTTP 上报仍只收 PASS/FAIL/SKIP/ERROR。
- `data_engine.db`/`status.json` 必须回传；token 缺失写 `token-unavailable`，不写 0。
- 所有尝试（首跑/重试/verifier）token 计入；计费事件幂等键含 requestId/attempt。
- 测试不连真实 LLM/设备/外网；ARTEMIS 用 fake 子进程，gateway 用 fake endpoint。
- 完成门槛：`npm run build && npm test && npm run lint` 全绿；`DESIGN.md` 同步实现记录。

## Review Focus

- 领取隔离：maestro runner 不能领 LLM；LLM worker 不能领 maestro；并发领取只有一个赢家。
- 脱敏失败：H1–H4 hook 不可用/未绑定账号时必须 fail-closed，不能把原文发给模型。
- 证据：L1 必须评估原始证据；无 L1/L2 不得 PASS；预期散文无锚点不得造假 FAIL。
- UNVERIFIED：center-only ingest 接受，HTTP runner 仍拒绝；Excel 写 `UNVERIFIED`，任务 `partial`。
- 网关：端口漂移/隧道断开时在途任务失败而非静默改派；安装失败不进 LLM。

---

### Task 1: 领取隔离与 LLM 任务前置校验

**Files:**
- Modify: `src/db/types.ts`（`RegressionTaskRecord.executionMode`、`CreateRegressionTaskInput.executionMode`、`claimWebJob` 增加 `executionMode`）
- Modify: `src/db/postgres.ts`（`regression_tasks.execution_mode` 列/迁移/映射）、`src/db/memory.ts`
- Modify: `src/web/job-spec.ts`（LLM 模式 requirements/错误码）
- Modify: `src/web/jobs.ts`（创建任务写 executionMode；LLM 不生成脚本；gateway 必需）
- Modify: `src/web/task-service.ts`/回归任务创建点（默认 `maestro`）
- Test: `test/web-job-queue.test.js`、`test/db-runners.test.js`

**Interfaces:**
- `claimWebJob(input: { runnerId; hostId; deviceSerial; instanceId; executionMode: "maestro"|"llm"; nowMs? })`
- `RegressionTaskRecord.executionMode: "maestro"|"llm"`；迁移 `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'maestro'`。
- LLM 错误码：`llm-gateway-unavailable`（409）、`llm-worker-offline`（409，面板/pending 原因）。

- [ ] Test: 同 host 两个设备，分别建 maestro/llm 任务；`claimWebJob(executionMode:"maestro")` 只拿 maestro，`llm` 只拿 llm；两个 worker 并发领取同任务只有一个成功。
- [ ] Test: 旧行无 execution_mode → 迁移后默认 maestro；普通套件任务/现有 createTask 不回归。
- [ ] Test: `createWebJob({executionMode:"llm", scriptSetId:null})` 不触发生成；requirements.tools 缺省补 `["adb"]`（Android）；无 gateway 的 host 返回 `llm-gateway-unavailable`。
- [ ] 加列/迁移/索引 `regression_tasks_execution_mode_idx(status, execution_mode, target_host_id, device_serial)`；`createWebJob`/`createTask` 写值；claim 用 `rt.execution_mode = $6`。
- [ ] `web-runner` 调用点传 `executionMode:"maestro"`；LLM worker 传 `"llm"`。
- [ ] 跑测试通过，提交 `feat: isolate web llm job claiming`。

### Task 2: 设备网关注册与 SSH 反向隧道

**Files:**
- Modify: `src/db/types.ts`（`WebRunnerRecord.gateway`）
- Modify: `src/db/postgres.ts`（`web_runners.gateway` JSON 列/迁移）、`src/db/memory.ts`
- Modify: `src/runner/control/client.ts`、`src/runner/web-runner.ts`（gateway 字段/端口配置）
- Create: `src/runner/gateway.ts`（端口占用检查、SSH `-R` 启动/保活/退出）
- Test: `test/web-runner-store.test.js`、`test/web-runner-gateway.test.js`

**Interfaces:**
- `DeviceGatewayRecord { adbServer: string|null; appiumUrl: string|null; tunnelPort: number|null; ready: boolean; reportedAt: string }`
- Runner env：`AOS_GATEWAY_ADB_PORT`（默认 15037）、`AOS_GATEWAY_APPIUM_PORT`（默认 15038）、`AOS_GATEWAY_SSH_TARGET`（可选）。
- `upsertWebRunner` 接收 `gateway`；`listWebRunners` 返回。

- [ ] Test: upsert/store 往返 gateway；两个 runner 同端口注册冲突 → 409/`gateway-port-conflict`。
- [ ] Test: fake ssh 子进程参数含 `-R <port>:127.0.0.1:5037`、`ExitOnForwardFailure=yes`、保活；退出后 `ready:false`。
- [ ] Test: 端口漂移后注册刷新；在途任务 endpoint 变化 → `llm-gateway-endpoint-changed`。
- [ ] 实现 gateway 注册/心跳/ready；P0 单实例、端口唯一；不实现 WSS/HA。
- [ ] 跑测试通过，提交 `feat: add web runner device gateway`。

### Task 3: Center LLM Worker（领取/预算/取消）

**Files:**
- Create: `src/web/llm/worker.ts`
- Create: `src/web/llm/worker-loop.ts`（轮询/租约/取消/预算）
- Modify: `src/cli.ts`/`src/web-command.ts`（`web llm-worker` 子命令）
- Modify: `src/web/jobs.ts`（LLM 任务 pending 原因/心跳）
- Test: `test/web-llm-worker.test.js`

**Interfaces:**
- `runLlmWorkerOnce(input: {store; nowMs; runnerId; instanceId; executeCase: (caseInput)=>Promise<LlmCaseResult>; maxCases?}): Promise<{claimed; completed; failed}>`
- `runLlmWorkerLoop(input & {pollMs; signal}): Promise<void>`
- `LlmCaseResult {caseId; status:"PASS"|"FAIL"|"SKIP"|"ERROR"|"UNVERIFIED"; durationMs; evidenceSteps; verification; traceId?; failureReason?}`
- 预算：`AOS_WEB_LLM_CASE_TIMEOUT_MS` 默认 900000；`AOS_WEB_LLM_JOB_MAX_MS` 默认 28800000；`AOS_WEB_LLM_MAX_STEPS` 80；超出 `budget-exceeded`。

- [ ] Test: worker 只领 llm；按用例循环；单例超时 kill 子进程并写 `ERROR`/`budget-exceeded`（fake executeCase 抛 timeout）。
- [ ] Test: 取消信号 → 已完成保留、未完成 `SKIP（未执行）`；任务 `partial`。
- [ ] Test: 总预算按 `cases × caseTimeout × (1+retry)` 派生，不被固定 2h 截断；20 例可跑。
- [ ] Test: worker 心跳过期 → 面板/pending 原因 `llm-worker-offline`；worker 恢复后可领取。
- [ ] 实现 worker/loop/CLI；每任务一个 per-case execute；释放租约/回写状态；写 worker 心跳。
- [ ] 跑测试通过，提交 `feat: add center web llm worker`。

### Task 4: ARTEMIS 执行适配与 artifacts/token

**Files:**
- Create: `src/web/llm/artemis-case.ts`
- Modify: `src/artemis/assembly.ts`（注入 hooks env；不改执行协议）
- Modify: `src/web/results.ts`（token attempt/phase/requestId 可选解析）
- Test: `test/web-llm-artemis.test.js`、`test/web-result-tokens.test.js`

**Interfaces:**
- `executeAndroidLlmCase(input: {runtime; taskDesc; caseId; deviceSerial; timeoutMs; secretMap}): Promise<LlmCaseResult & {traceId; statusPath; dataEngineDbPath; tokenUsage}>`
- ARTEMIS 调用：`runtime.proxy.callTool("mobile_run_task", {task_desc, device_serial})` → `mobile_manage_task` 轮询 → `runtime.traceDir(traceId)`；读 `status.json`；`data_engine.db` 复用 `readAndroidTraceObservations`（`src/artemis/android-trace.ts`），不新写 SQLite 解析。
- token 提取：status/trace/usage 适配器；缺失 → `token-unavailable`；每 token 行带 `attempt`/`phase`/`requestId`。

- [ ] Test: fake proxy 返回 trace/status/db；适配器产出 PASS/FAIL/ERROR/UNVERIFIED + tokenUsage；缺 db/status → `token-unavailable`。
- [ ] Test: per-case 子进程隔离：两个 case 的 trace/token 不串；timeout kill。
- [ ] 实现 adapter；`buildChildEnvForEntry` 加 `PYTHONPATH`/`AOS_LLM_HOOKS=1`/`AOS_LLM_CASE_ID`。
- [ ] 跑测试通过，提交 `feat: execute web llm cases through artemis`。

### Task 5: 脱敏、注入与 ARTEMIS hooks（K1）

**Files:**
- Create: `src/web/llm/secrets.ts`（inventory/redact/unbound）
- Create: `src/web/llm/redact.ts`
- Create: `scripts/artemis-llm-hooks/sitecustomize.py`、`aos_llm_hooks/{provider,observe,act,trace}.py`
- Modify: `src/web/llm/artemis-case.ts`（入口脱敏/注入映射）
- Test: `test/web-llm-redact.test.js`、`test/web-llm-hooks.test.js`（Node spawn fake Python hook selftest）

**Interfaces:**
- `loadWebSecrets({store, rootPath, env}): SecretEntry[]`（materials secret + `AOS_WEB_SECRET_*`）
- `redactText(text, secrets): {text; hits; unbound: string[]}`
- `resolvePlaceholders(value, map): string`（仅执行动作瞬间）
- Python hook env：`AOS_LLM_HOOKS=1`、`AOS_LLM_SECRET_MAP`（0600 文件，不允许进 prompt）、`AOS_LLM_STRICT=1`。

- [ ] Test: taskDesc/UI 树含邮箱/手机号/密码 → 输出无原文；未绑定 account-like → `llm-secret-unbound`，不调用模型。
- [ ] Test: 占位符只在动作执行时替换；trace/log/status/db 对 secret grep 0；截图注入区遮罩。
- [ ] Test: hook 未加载/H1–H4 不可用 → `llm-secret-hook-unavailable`（fail-closed）。
- [ ] 实现 Node redactor + Python hooks；优先 `PYTHONPATH`/sitecustomize，不改 submodule；缺 hook 才按 AGENTS 打 `PATCH (aos-mcp)`。
- [ ] 跑测试通过，提交 `feat: redact and inject web llm secrets`。

### Task 6: L1 判定、center-only UNVERIFIED、Excel

**Files:**
- Create: `src/web/llm/verify.ts`（L1 原始证据；L2 接口；预期抽取）
- Modify: `src/web/results.ts`（`parseCase`/`normalize` 增加 centerOrigin 选项）
- Modify: `src/web/llm/worker.ts`（ingest 传 centerOrigin）
- Test: `test/web-llm-verify.test.js`、`test/web-results-unverified.test.js`

**Interfaces:**
- `checkDeterministic(input: {expected; uiTree; screenshot; errorDialog}): {passed; failed; skipped; reasons}`
- `ingestWebJobResult({..., centerOrigin?: boolean})`；centerOrigin=true 时 `status:"UNVERIFIED"` 允许，HTTP 路径仍拒绝。
- `parseExpectedAssertions(text): {anchored: string[]; unanchored: boolean}`；无锚点不产 L1。

- [ ] Test: 期望文本命中/未命中/无锚点；L1 失败 + verifier pass 仍 FAIL；无 L1/L2 → UNVERIFIED。
- [ ] Test: reference pack 存在 → L2 比对 pass/fail；缺失 → `reference:"missing"`，无 L1 时 UNVERIFIED；P0 verifier 固定 `not-run`。
- [ ] Test: centerOrigin ingest 接受 UNVERIFIED，HTTP runner 仍 400；Excel 写 UNVERIFIED；任务 partial。
- [ ] Implement verify + centerOrigin；不改 runner HTTP 枚举；L2 只接 reference 图（materials `reference` 类型 P1 可先用手工路径）。
- [ ] 跑测试通过，提交 `feat: verify web llm results deterministically`。

### Task 7: 安装控制面与面板/CLI

**Files:**
- Modify: `src/runner/web-job-workspace.ts`/`installWebPackage` 或新增 `src/runner/gateway-install.ts`
- Modify: `src/panel/actions.ts`/`src/console/pages.ts`（LLM 选项、gateway 状态、警告）
- Modify: `src/web-command.ts`（`web llm-worker` help/默认值）
- Test: `test/web-runner-gateway-install.test.js`、`test/web-dispatch-ui.test.js`

**Interfaces:**
- `installOnGateway({hostId, asset, sha256, platform}): Promise<{packageName; version}>`
- 面板：LLM 选中时显示“由中心执行，runner 只做设备网关”；gateway 离线禁用；无预期列警告。

- [ ] Test: gateway 下载/校验/安装/版本返回；sha 不匹配失败；安装失败不进 LLM。
- [ ] Test: 面板 LLM 选项/警告/gateway 状态；无预期列确认（`allowUnverified:true` 显式放行，否则 400 `llm-no-expectation`）。
- [ ] Test: OTP/验证码用例标 `not-automatable` 时拒绝 LLM；未脱敏证据仅 admin/maintainer 可下载。
- [ ] 实现安装控制面与 UI；P0 Android 安装走 runner adb；`deviceHosts` 不参与 Web LLM 路由。
- [ ] 跑测试通过，提交 `feat: add llm gateway install and panel wiring`。

### Task 8: 文档与全量验证

**Files:**
- Modify: `DESIGN.md` §13.306（状态/实现记录）、`README.md`（`web llm-worker`/环境变量）
- Test: 全量

- [ ] 更新 DESIGN/README：命令、默认值、限制（P0 Android、无 verifier）。
- [ ] `npm run build && npm test && npm run lint` 全绿并记录。
- [ ] 手动 `scripts/e2e-device.mjs` 远程 Android smoke（需真实设备/ARTEMIS）。
- [ ] 提交 `docs: record web llm p0 implementation`。
