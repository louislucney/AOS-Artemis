# Web LLM iOS P0b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `executionMode=llm` 的远程 iOS 真机任务由中心 LLM Worker 执行，复用 AOS iOS 执行器（Appium/WDA）与现有结果契约；不把 iOS 模拟器伪装成远程可执行。

**Architecture:** 中心 worker 按平台分派：Android 走 ARTEMIS，iOS 走 `Runtime` 的 AOS iOS 执行器（`src/ios/task-runner`）。runner 仍是设备网关，但新增 Appium 反向隧道；iOS 观察/输入/落盘脱敏在 Node `src/ios` 层完成，不能依赖 Android 的 Python hooks。

**Tech Stack:** TypeScript ESM + NodeNext + strict、Appium/WDA、SSH `-R`、Node test runner、fake Appium/Runtime。

**Spec:** `docs/superpowers/specs/2026-11-04-llm-execution-design.md` v3；结果契约 `src/web/results.ts`；iOS 执行器 `src/ios/tool-entry.ts`。

**Status（2026-11-04）：** Task 1–6 的离线实现与 fake 测试已完成，全量测试通过；Task 0 真机端口/bounds 样本与 Task 7 真机验收待设备接入。

## Global Constraints

- P0b 只支持**远程 iOS 真机**；iOS 模拟器仍只支持本机 Maestro/本地调试，不做“远程模拟器”。
- LLM key 只在中心；runner 不持 key。
- iOS UI 树/截图/输入/trace 的脱敏必须在 Node `src/ios` 完成；ARTEMIS Python hooks 不覆盖 iOS。
- PASS 仍需要确定性证据；无 L1/L2 → `UNVERIFIED`。
- iOS 没有 `data_engine.db`：`tokenArtifacts` 只要求 `status.json`；缺 token 写 `token-unavailable`。
- 测试不连真实 iOS 设备/Appium/LLM；用 fake Runtime/Appium/exec。
- 完成门槛：`npm run build && npm test && npm run lint` 全绿；真机验收另记。

## Review Focus

- 远程 iOS 真机 vs 模拟器：模拟器不得被当成远程目标；目标 host 必须有 Appium 端点。
- Appium URL 按 host 隔离：同一项目切 host 不得复用上一台的 Appium 会话。
- iOS 脱敏覆盖：UI 树、截图、输入、status/run 落盘；Python hooks 不能算覆盖。
- 结果契约：iOS 只回 `status.json`/`run.json`，不得因缺 `data_engine.db` 误报 `token-unavailable`。
- 安装：`.ipa` 由 Appium host 可访问的 URL/本地路径安装，不得把中心路径直接交给远程 Appium。

---

### Task 0: 半天前置验证（先于实现）

- [ ] **Appium 端口，不是 WDA 8100**：在目标 runner 上确认 Appium server 监听 `4723`（或配置端口）；中心只通过 SSH `-R` 转发 **Appium HTTP 端口**。WDA 由 Appium 经 USB/usbmuxd 管理，不属于本计划的转发对象；不要把 `tidevice relay 8100` 作为 P0b 前置。
- [ ] **bounds 样本**：用真实 iPhone 抓登录页/个人页 `run.json` 的 `steps[].texts`，统计有 `x/y/width/height` 的文本节点比例；代码侧已知 `src/ios/prompt-history.ts` 会把 `IosUiNode.rect` 渲染为 `Bounds`，但仍需设备样本确认覆盖率。离线统计：`node scripts/ios-bounds-report.mjs [--json] <trace 目录…>`（缺省扫描 `.artemis/traces`）。
- [ ] 样本结论写入计划/评审记录，再进入 Task 1（真机样本待做；代码已完成 Task 1–7 的可离线部分）。

### Task 1: iOS gateway Appium 反向隧道

**Files:**
- Modify: `src/db/types.ts`（`DeviceGatewayRecord` 已有 `appiumUrl`）
- Modify: `src/runner/gateway.ts`（第二路 `ssh -R`）
- Modify: `src/runner/control/contract.ts`/`client.ts`/`service.ts`（gateway 字段已支持）
- Test: `test/web-runner-gateway.test.js`、`test/web-runner-store.test.js`

**Interfaces:**
- Env：`AOS_GATEWAY_APPIUM_PORT`（中心侧默认 15038）、`AOS_GATEWAY_LOCAL_APPIUM_PORT`（runner 侧 Appium HTTP，默认 **4723**）、`AOS_GATEWAY_APPIUM_URL`（外部已可达的完整 URL；设置后不建 Appium 隧道）。
- 前置：Appium server 已在 runner 启动；WDA/USB 由 Appium 管理，不直接转发 8100。
- `DeviceGatewayRecord.appiumUrl: string | null`（中心 loopback `http://127.0.0.1:<port>`）。

- [x] Test: 配置 target 后 ssh 参数含两条 `-R`（adb + appium 4723）；`snapshot().appiumUrl` 正确。
- [x] Test: Appium 未启动/端口不可达 → `appiumUrl:null`，任务 `ios-appium-unavailable`，不猜测。
- [x] Test: 未配置 `AOS_GATEWAY_APPIUM_PORT` 时 `appiumUrl:null`；端口冲突仍 409。
- [x] 实现第二路隧道/退出置 `ready:false`（任一隧道断都 false）；关闭时 kill 两个子进程。
- [x] 跑测试通过，提交 `feat: add iOS appium gateway tunnel`。

### Task 2: 平台分派与 iOS 执行适配

**Files:**
- Rename/refactor: `src/web/llm/artemis-case.ts` → `src/web/llm/case-exec.ts`（保留 Android 逻辑）
- Create: `src/web/llm/ios-case.ts`
- Modify: `src/web/llm/cli.ts`（按 `job.spec.requirements.platform` 分派）
- Modify: `src/web/llm/worker.ts`（`executeCase` 已平台无关）
- Test: `test/web-llm-ios-case.test.js`

**Interfaces:**
- `executeLlmCase(input: {platform; proxy; traceDir; testCase; deviceSerial; appPackage; appPath; secrets; signal})`
- iOS adapter：`proxy.callTool("mobile_run_task", {task_desc, device_serial, locked_app_package, app_path})` → `mobile_manage_task` 轮询 → `runtime.traceDir(traceId)`；读 `status.json`/`run.json`。
- **已核实契约**：`src/ios/tool-entry.ts` 返回 `{trace_id,status:"running",device_serial,...}`；`statusPayloadOf` 含 `test_summary`/`result`/`recent_steps`/`run_dir`；`run.json` 由 `trace-persist` 写入。
- iOS 结果：`test_summary`/`result` → PASS/FAIL/UNVERIFIED；`run.json.steps` → evidenceSteps；无 token → `undefined`。

- [x] Test: fake iOS proxy 返回 `running→completed` + `test_summary`，字段形状与 `statusPayloadOf` 一致；结果 PASS/FAIL/UNVERIFIED 三态。
- [x] Test: iOS `app_path` 传 http URL；模拟器返回 `app_path_unsupported` 时映射 ERROR（远程模拟器不做）。
- [x] Test: iOS 取消 → stop；结果 SKIP/cancelled。
- [x] 实现 `ios-case.ts`/分派；保留 Android `data_engine.db` 读取。
- [x] 跑测试通过，提交 `feat: add iOS LLM case executor`。

### Task 3: Appium URL per host / Runtime 隔离

**Files:**
- Modify: `src/runtime.ts`（`RuntimeOptions.iosAppiumUrlOverride` 或 `iosEnv` 覆盖）
- Modify: `src/web/llm/cli.ts`（按 `targetHostId` 取 gateway.appiumUrl，构建/缓存 Runtime）
- Test: `test/web-llm-ios-appium.test.js`

**Interfaces:**
- `runtimeFor(rootPath, appiumUrl: string | null)` cache key `${rootPath}\0${appiumUrl ?? ""}`.
- `Runtime` 初始化时 `AOS_APPIUM_URL` 使用 override，不污染进程 env。

- [x] Test: host-a/host-b 不同 appiumUrl → 两个 Runtime，不串会话。
- [x] Test: appiumUrl 为空 → 任务 ERROR `ios-appium-unavailable`，不猜测。
- [x] 实现 override；worker 从 `web_runners.gateway.appiumUrl` 取。
- [x] 跑测试通过，提交 `feat: route iOS appium per gateway host`。

### Task 4: iOS Node 侧脱敏

**Files:**
- Create: `src/ios/redaction.ts`
- Modify: `src/ios/observation.ts`/`step-observe.ts`（截图/节点进模型前脱敏）
- Modify: `src/ios/run-loop.ts`（input/type 动作注入 `<secret:alias>`）
- Modify: `src/ios/trace-persist.ts`/`trace-store.ts`（status/run 落盘前脱敏）
- Test: `test/ios-redaction.test.js`

**Interfaces:**
- `redactIosNodes(nodes, secrets)`：按 `texts` 的 bbox 遮罩；无 bbox 严格模式丢弃截图。
- `resolveIosInput(text, secrets)`；`redactIosRun(record, secrets)`。

- [x] Test: UI 树/节点文本脱敏；截图 bbox 遮罩；无 bbox → 严格模式丢弃；**混合节点**（部分有 bbox/部分无）→ 严格模式丢弃整图并告警，非严格模式保留截图 + warning。
- [x] Test: input 动作占位符替换；status/run JSON 落盘无 secret。
- [x] 实现；复用 `secrets.ts` 的 `SecretEntry/redactText`（不要复制正则）；`IosUiNode.rect` 已是现成 bbox 来源（`prompt-history.ts` 已渲染 Bounds）。
- [x] 跑测试通过，提交 `feat: redact iOS LLM observations and traces`。

### Task 5: iOS 安装与 artifact 契约

**Files:**
- Modify: `src/web/llm/ios-case.ts`（`app_path` 传 http/URL 或 Appium 可访问路径）
- Modify: `src/web/results.ts`（LLM token 校验按平台：iOS 只要求 statusJson）
- Modify: `src/web/llm/ingest.ts`（iOS artifacts/verification）
- Test: `test/web-llm-ios-ingest.test.js`、`test/web-result-ingest.test.js`

**Interfaces:**
- iOS `tokenArtifacts`：`statusJson` 必需；`dataEngineDb` 不要求。
- `verification.deterministic` 从 `test_summary`；`reference` 从 job `referenceAssetId`（有则 `missing`，比对 P1）。

- [x] Test: iOS 结果缺 `data_engine.db` 不报 token-unavailable；缺 statusJson 才报。
- [x] Test: iOS test_summary → 门禁/Excel/UNVERIFIED 正确。
- [x] 实现平台分支；更新 `ingestLlmResults`。
- [x] 跑测试通过，提交 `feat: ingest iOS LLM results without android artifacts`。

### Task 6: token usage（iOS）

**Files:**
- Modify: `src/llm/chat.ts`（`ChatFn` 增加 usage 回调或返回 `{content,usage}`）
- Modify: `src/ios/run-loop.ts`/`tool-entry.ts`（累计 usage）
- Modify: `src/ios/types.ts`（`IosTaskRecord.tokenUsage`）
- Test: `test/ios-token-usage.test.js`

**Interfaces:**
- `ChatUsage {promptTokens, completionTokens, cacheCreateTokens, cacheReadTokens}`；**不修改 `ChatFn` 类型**，在 `ChatOptions` 增加可选 `onUsage?: (usage: ChatUsage) => void`；`makeChatFn` 解析 `usage` 后调用；所有现有调用方零修改。
- `run.json`/status 带 per-step usage；`ingestLlmResults` 映射 `tokenUsage`。

- [x] Test: fake chat 返回 usage → status/run 记录；缺 usage → `token-unavailable`；现有 `makeChatFn` 调用方（figma/pen/ios/panel）不因新可选参数变化。
- [x] 实现；不改 Android 的 token 读取。
- [x] 跑测试通过，提交 `feat: capture iOS LLM token usage`。

### Task 7: 文档与真机验收

- [x] 更新 `DESIGN.md` §13.306/§13.307、`README.md`（iOS 仅真机、Appium gateway、token 契约）。
- [x] `npm run build && npm test && npm run lint` 全绿。
- [ ] 手动真机：Appium 隧道、`.ipa` 安装、登录/个人页脱敏、取消/超时、Excel 写回（真机验收待做）。
