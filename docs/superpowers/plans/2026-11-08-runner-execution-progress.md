# Runner 执行进度与异常可见性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让手机按用例执行时，面板实时显示执行百分比与当前阶段，并在 LLM/设备/应用异常时于 60 秒内显示真实原因，不再出现长期假 `running` 或必须去 Windows 翻 `stdout.log`。

**Architecture:** 复用现有 `updateRegressionTask` 控制面通道，在 `RegressionTaskRecord` 增加一个最新的 `progress` 快照；runner 在预检、应用启动、每个用例开始/结束、失败时主动上报。`case-runner` 增加短超时与 `stderr.log` 终态错误检测，避免 Artemis 异常后只留下 `running`。失败证据由 runner 上传到中心 `.artemis/remote-evidence/`，中心不再依赖反连 runner 8770。

**Tech Stack:** TypeScript ESM/NodeNext、Node `node:test`、现有 FileStore/PostgresStore、React-free server-rendered panel。

**Spec:** 本文件同时作为设计说明；实现只覆盖「预检 + 短超时 + 进度上报 + 面板百分比 + 失败证据」主链路，不改 Artemis 子模块。

## Global Constraints

- 测试先写失败用例，再实现；每次改动后 `npm run build && npm test && npm run lint`。
- runner 不持有 provider key，不知道中心项目路径，不依赖中心反连；LLM 仍走中心代理。
- 不把用户环境变量当作修复手段；runner 包默认从中心获取 LLM。
- 面板只显示百分比、当前阶段、错误摘要，不直接倾倒 stdout/stderr 全文。
- 超时后不得残留 `running`；取消时必须终止对应 Artemis 子进程。
- `artemis/` submodule 不修改；AOS 侧通过 trace 文件和 store 边界处理。

## Review Focus

- Artemis 子进程已退出但 `status.json` 仍为 `running`：必须在 60 秒内失败，而不是 15 分钟后 timeout。
- LLM 代理不可达：不得启动 App 后空等，必须在预检阶段报环境错误。
- helper/uiautomator observation 卡住：必须有阶段错误和进程终止。
- 中心短暂断线：进度上报失败不得中断设备执行，恢复后允许补报。
- 同一用例重复上报：面板进度不得倒退，错误只保留最新一条。

---

### Task 1: 任务进度数据模型与面板百分比

**Files:**
- Modify: `src/db/types.ts`（`RegressionTaskRecord.progress`、patch 类型）
- Modify: `src/db/memory.ts`
- Modify: `src/db/postgres.ts`（`progress_json` 列、migration、读写映射）
- Modify: `src/panel/overview.ts`
- Modify: `src/panel/web.ts`
- Test: `test/panel-overview.test.js`

**Interfaces:**
- Produces:
  ```ts
  export interface TaskProgress {
    seq: number;
    phase: "preflight" | "app_started" | "observing" | "thinking" | "acting" | "case_finished" | "done" | "failed" | "stalled";
    percent: number;
    caseId?: string | null;
    traceId?: string | null;
    message?: string | null;
    errorCode?: string | null;
    at: string;
  }
  ```
  `RegressionTaskRecord.progress: TaskProgress | null`；`updateRegressionTask` 接受 `progress?: TaskProgress | null`。

- [ ] **Step 1: Write failing tests**

在 `test/panel-overview.test.js` 增加：创建 `progress={seq:2,phase:"acting",percent:40,caseId:"c1",message:"正在执行第 1 个用例",at:"2026-11-08T00:00:00.000Z"}` 的任务，`updateRegressionTask` 写回后，`panel.json`/任务页包含 `40%` 与 `正在执行第 1 个用例`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/panel-overview.test.js`
Expected: FAIL（record/页面尚无 progress）。

- [ ] **Step 3: Implement progress persistence and rendering**

Postgres 用单列 `progress_json TEXT`；Memory/FileStore 用对象字段。面板任务列表把 `running/stalled` 行显示为 `<percent>% · <message/errorCode>`；详情页显示当前阶段和最近更新时间。没有 progress 时保持旧展示。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/panel-overview.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/db/memory.ts src/db/postgres.ts src/panel/overview.ts src/panel/web.ts test/panel-overview.test.js
git commit -m "feat: persist and render runner task progress"
```

### Task 2: case-runner 快速失败与真实错误摘要

**Files:**
- Modify: `src/figma/case-runner.ts`
- Modify: `src/figma/suite-runner.ts`（默认 `DEFAULT_POLL_TIMEOUT_MS` 与透传）
- Test: `test/suite-command.test.js`

**Interfaces:**
- Consumes: `Runtime.traceDir(traceId)`、`Runtime.traceStatus(traceId)`。
- Produces: `SuiteCaseResult.failureReason` 包含最近真实错误（如 `LLMExhaustedError: Connection error`），不再是笼统「轮询超时」。

- [ ] **Step 1: Write failing tests**

构造 `status.json` 一直 `running`，但同目录 `stderr.log` 含 `CRITICAL ERROR during task execution: LLMExhaustedError: Connection error.`；用例必须在短轮询周期内失败，错误摘要包含 `Connection error`。另测 `status.json.error` 非空时立即失败。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/suite-command.test.js`
Expected: FAIL（当前实现会等到 timeout 或只给通用 timeout）。

- [ ] **Step 3: Implement terminal error observer**

新增内部 `readTraceTerminalError(traceDir)`：读取 `stderr.log` 末尾 8KB，识别 `CRITICAL ERROR during task execution` / `LLMExhaustedError` / `APIConnectionError`；每次 poll 同时检查 `status.error` 与该文件。命中立即按失败返回并保留摘要。将默认 poll timeout 从 15 分钟降到 180 秒，可用 `AOS_SUITE_CASE_TIMEOUT_MS` 覆盖（缺省 180000）。不得修改 Artemis 子模块。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/suite-command.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/figma/case-runner.ts src/figma/suite-runner.ts test/suite-command.test.js
git commit -m "fix: fail fast on Artemis terminal errors"
```

### Task 3: runner 预检与进度上报

**Files:**
- Create: `src/runner/progress.ts`
- Modify: `src/suite-command.ts`
- Modify: `src/llm/center.ts`
- Modify: `src/figma/suite-runner.ts`（用例开始/结束回调）
- Test: `test/runner-progress.test.js`

**Interfaces:**
- Produces:
  ```ts
  reportTaskProgress(runtime, task, progress: TaskProgress): Promise<void>
  probeCenterLlm(entry: LlmEntry, env: NodeJS.ProcessEnv): Promise<string | null>
  ```
  `runGeneratedTests` 支持 `onCaseEvent?: (event: { phase: "start" | "finish"; caseId: string; traceId: string | null; status: string; error?: string }) => void | Promise<void>`。

- [ ] **Step 1: Write failing tests**

Mock 一个任务（3 个用例）和中心 store，验证进度序列包含 `preflight`、`app_started`、用例 1 的 `33%`、用例 2 的 `67%`、最终 `100%`；mock LLM 预检失败时，任务直接 `failed/stalled` 且没有 `mobile_run_task` 调用。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/runner-progress.test.js`
Expected: FAIL（尚无 reporter/preflight/case 回调）。

- [ ] **Step 3: Implement preflight and progress reporter**

`probeCenterLlm` 对 `${entry.baseUrl}/chat/completions` 发 1-token、15 秒超时的最小请求，返回 null 或错误摘要。`suiteRunTask` 顺序：`refreshCenterLlm` → 预检（LLM、appPackage、设备）→ 上报 `app_started` → 用例事件上报。上报失败仅记日志，不中断执行；进度 `seq` 单调递增，百分比不倒退。预检失败直接写 `failed/stalled`，不启动应用。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/runner-progress.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/runner/progress.ts src/suite-command.ts src/llm/center.ts src/figma/suite-runner.ts test/runner-progress.test.js
git commit -m "feat: report suite execution progress from runner"
```

### Task 4: 失败证据上传与取消终止子进程

**Files:**
- Create: `src/runner/evidence-upload.ts`
- Modify: `src/runner/control/suite-routes.ts`
- Modify: `src/runner/control/suite-service.ts`
- Modify: `src/runner/control/suite-client.ts`
- Modify: `src/runner/agent.ts`
- Modify: `src/panel/web.ts`
- Test: `test/runner-evidence.test.js`

**Interfaces:**
- Produces: `POST /panel/api/runners/suite/tasks/:id/evidence`，body 为 `{rootPath, taskId, caseId, traceId, files: [{name, contentBase64}]}`；中心写 `<rootPath>/.artemis/remote-evidence/<taskId>/<traceId>/<safe-name>`，只允许 `status.json`、`stderr.log`、`stdout.log`、`error.txt`，单文件 ≤ 256KB，总包 ≤ 1MB。

- [ ] **Step 1: Write failing tests**

上传失败用例的 `status.json` 与 `stderr.log`，断言中心保存且任务详情页出现对应 artifact 链接；越界文件名/超限被拒绝。另测 cancel 时 runner 对活动子进程调用停止/清理。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/runner-evidence.test.js`
Expected: FAIL（尚无上传路由/清理）。

- [ ] **Step 3: Implement bounded evidence upload and cancellation cleanup**

`case-runner` 失败时 best-effort 上传 status/stderr，不阻塞结果写回；中心经 `suite` 控制面保存并做路径白名单。runner cancel/stop 时清理当前 Artemis 子进程，避免旧进程继续持有设备。任务详情只显示「查看失败证据」链接，不直接展开大日志。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/runner-evidence.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/runner/evidence-upload.ts src/runner/control/suite-routes.ts src/runner/control/suite-service.ts src/runner/control/suite-client.ts src/runner/agent.ts src/panel/web.ts test/runner-evidence.test.js
git commit -m "feat: upload failure evidence and stop cancelled children"
```

### Task 5: 0.2.3 包、文档与单用例验收

**Files:**
- Modify: `package.json`、`package-lock.json`、`src/util.ts`
- Modify: `README.md`、`DESIGN.md`、`docs/windows-runner-quickstart.md`
- Test: `test/http-server.test.js`

**Interfaces:**
- Produces: `aos-artemis-runner-0.2.3-win32-x64.zip` / `-offline.zip` / `darwin-arm64.tar.gz`，面板显示 0.2.3。

- [ ] **Step 1: Update version and design docs**

记录：进度协议字段、预检顺序、180 秒默认用例超时、证据上传白名单、取消终止子进程；说明不再需要手工修改 `NO_PROXY`/`AOS_LLM_FROM_CENTER` 作为常规操作。

- [ ] **Step 2: Build and run full verification**

Run: `npm run verify`
Expected: build/test/lint/type-tests/bundle/contract 全部通过（lint 仅历史 warning）。

- [ ] **Step 3: Rebuild runner bundles and verify**

Run: `npm run bundle:mcp-runner && npm run check:runner-bundle`
Expected: 三个包校验通过，manifest 记录 SHA256。

- [ ] **Step 4: Run one-case real smoke**

只派发 `imp-4ee495af-19`（不重跑三条），观察面板出现预检、App 启动、百分比推进；若失败，60 秒内出现具体原因与证据链接，不再长期 `running`。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/util.ts README.md DESIGN.md docs/windows-runner-quickstart.md test/http-server.test.js
git commit -m "chore: release runner 0.2.3 execution progress"
```
