# design_to_test 实施计划（统一服务 ①：CR 一条龙 + 脚本退役）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 MCP 工具 `design_to_test`——一句话走完 CR 流程（前置自检 → 读设计 → 懂交互 → 出用例 → 校验 → 可选执行），把编排从脚本层收进服务内部，并**退役 `scripts/design-to-test.mjs`**。

**Architecture:** 新增 `src/workflow/`（`setup.ts` 前置检查＋`design-to-test.ts` 编排，全部依赖注入、可离线测试）；门禁函数从 `suite-command.ts` **原样提取**到 `src/figma/gate.ts` 供复用；执行复用 `runGeneratedTests`；工具定义按域放 `src/tools/native-tools/workflow.ts` 并在 `src/server.ts` 装配。

**Tech Stack:** TypeScript（ESM/NodeNext/strict）、zod、node:test（测试跑 `dist/`，改动先 build）。

**Spec:** `docs/superpowers/specs/2026-10-17-unified-project-service-design.md`（本计划实施其 ① 阶段：§3.1、§5 矩阵、§7 接口、D2/D3/D4/D10/D11/D14/D15；② 回归＋Excel / ③ Jira / ④ 档案 另出计划）。

## Global Constraints

- 每任务收尾：`npm run build` ＋该任务测试全绿；最终全量 `npm run build && npm test && npm run lint` 全绿。
- `needs-setup` / `needs-info` 为**非 isError 的结构化返回**（预期状态，不是错误）；用法错误（参数冲突等）才用 isError。
- 复用而非 shell：**禁止 shell 到 `dist/cli.js` 或任何脚本**（spec 反目标）；测试不依赖真实设备/网络/PG，全部 stub 注入。
- 新增原生工具按域放 `src/tools/native-tools/`，`server.ts` 只加装配行。
- 中文文案；ESM 相对导入带 `.js`；代码默认无注释（解释非显然契约的 JSDoc 例外）。

## Review Focus（最可能咬人的输入类；测试已归入各任务）

1. **needs-setup 的纯净边界**：探测失败不得抛裸错、不得写盘；`howTo` 必须可执行（人话指引）。
2. **LLM ping 降级**：超时/异常→needs-setup（含修复指引）；结果**不缓存**；ping 与真实调用分离。
3. **门禁提取零回归**：suite check/loop/run --fail-on-uncovered 行为逐字不变（既有测试全绿）。
4. **run:true 姿态**：执行前回显将跑用例（数量/来源/设备）；失败结构化 `failedStep`；中断后事实源（`design/runs/`、trace）可查、重跑安全。
5. **参数语义**：`figmaUrl`/`penPath` 互斥或 `reuseExistingFlows`；冲突/全缺给明确用法错误；`vision`/`device` 透传正确。

---

### Task 1: 门禁函数提取（`src/figma/gate.ts`，零行为变化）

**Files:**
- Create: `src/figma/gate.ts`
- Modify: `src/suite-command.ts`（删本地函数，改导入）
- Test: `test/figma-gate.test.js`

**Interfaces:**
- Produces（② 阶段拆分打底、① 阶段仅原样搬迁）:

```ts
export function coverageGateIssue(
  preflight: PreflightReport | null,
  options?: { strict?: boolean }
): string | null;
```

- Consumes: `PreflightReport` 类型（`src/figma/preflight.ts` 既有）。

- [ ] **Step 1: 写失败测试**（`test/figma-gate.test.js`）：从 `../dist/figma/gate.js` 导入；手造最小 preflight 字面量断言两态——缺 xlsx→含 `缺少配套 tests.xlsx`；`null`→`预检数据缺失`；`--strict` 弱断言路径保留原判。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/figma-gate.test.js`（模块不存在）。
- [ ] **Step 3: 实现**：把 `suite-command.ts` 的 `coverageGateIssue` 与其私有依赖（`PreflightReport` 访问面）**原样搬**到 `src/figma/gate.ts`（仅加 export），`suite-command.ts` 改从新模块导入；**不改任何逻辑与文案**。
- [ ] **Step 4: 绿**：`npm run test:file -- test/figma-gate.test.js test/suite-command.test.js` 零回归。
- [ ] **Step 5: 提交**：`git commit -m "refactor(figma): extract coverage gate for reuse (no behavior change)"`

---

### Task 2: 前置检查 `src/workflow/setup.ts`

**Files:**
- Create: `src/workflow/setup.ts`
- Test: `test/workflow-setup.test.js`

**Interfaces:**
- Produces:

```ts
export type SetupTarget = "figma" | "pen" | "llm" | "device";   // "device" 的检查在 Task 3 用 listDevices 实现
export interface SetupNeed { target: SetupTarget; missing: string[]; howTo: string[]; note?: string }
export interface SetupDeps {
  exec?: PenExecFn;                 // 复用 src/pen/cli.ts 类型
  env?: NodeJS.ProcessEnv;
  chat?: (messages: ChatMessage[], signal?: AbortSignal) => Promise<string>;
  penTimeoutMs?: number;            // 默认 10_000
  llmTimeoutMs?: number;            // 默认 15_000
}
export async function checkFigma(runtime: Runtime): SetupNeed | null;
export async function checkPen(runtime: Runtime, deps?: SetupDeps): Promise<SetupNeed | null>;
export async function checkLlm(runtime: Runtime, deps?: SetupDeps): Promise<SetupNeed | null>;
```

- 行为钉死（D3/D14）：
  - `checkFigma`：项目 `.env` 或进程 env 有 `FIGMA_ACCESS_TOKEN` → `null`；缺 → `{target:"figma", missing:["FIGMA_ACCESS_TOKEN"], howTo:["aos_configure(figmaToken=…) 或写项目 .env"]}`。
  - `checkPen`：项目 `.env`/进程 env 有 `PEN_CLI_KEY` → `null`（**不跑子进程**）；否则 `resolvePenCliPath`（`src/pen/cli.ts`）——未解析→need（howTo：自动托管安装说明／`AOS_PEN_CLI_PATH`／`AOS_PEN_NO_INSTALL=1` 时需预装）；解析→执行 `pen status`（exec 注入，`penTimeoutMs`）——exit≠0 或输出匹配 `/not logged in|未登录|please (run )?["'`]?pen login/i` → need（howTo：`pen login` 或 `.env` 写 `PEN_CLI_KEY`）；否则 `null`，`note` 记录状态摘要（如 `pen status：Active`）。
  - `checkLlm`：`runtime.activeEntry()` 为 null → need（howTo：`aos_configure`／`.env` 的 `AOS_LLM_MODEL/API_KEY/BASE_URL`）；否则发 `[{role:"user",content:"ping"}]`（`deps.chat ?? makeChatFn(entry)`，`AbortSignal.timeout(llmTimeoutMs)`）——异常/空回→need（howTo：核对 key/model/base_url 与网络代理）；成功→`null`（**不缓存**；ping 与后续真实调用分离）。
- [ ] **Step 1: 写失败测试**（注入桩）：figma 有/无 token；pen 四态（`PEN_CLI_KEY` 短路不触 exec／CLI 缺失／`pen status` 退出 0 且 Active／退出 0 但 "Not logged in"／超时）；llm 三态（无条目／ping 成功／ping 超时或抛错）；断言 `missing/howTo` 内容与"未触网/未写盘"（桩计数）。
- [ ] **Step 2: 红**。`npm run test:file -- test/workflow-setup.test.js`
- [ ] **Step 3: 实现**（全部依赖注入；子进程默认 `execFile` 包装参照 `src/pen/cli.ts` 现有 exec 形参）。
- [ ] **Step 4: 绿**＋build。
- [ ] **Step 5: 提交**：`git commit -m "feat(workflow): setup checks (figma/pen/llm) with structured needs"`

---

### Task 3: 编排 `src/workflow/design-to-test.ts`

**Files:**
- Create: `src/workflow/design-to-test.ts`
- Test: `test/workflow-design-to-test.test.js`

**Interfaces:**
- Consumes: `checkFigma/checkPen/checkLlm`（Task 2）；`figmaExtractFlows`/`penExtractFlows`/`figmaGenerateTests`（既有）；`coverageGateIssue`（Task 1）；`preflightGeneratedTests`（既有）；`runGeneratedTests`（`src/figma/suite-runner.ts`，`SuiteRunOptions`）；`collectRunnerInventory`（`src/runner/inventory.ts`，设备清单）。
- Produces:

```ts
export interface DesignToTestArgs {
  figmaUrl?: string; nodeId?: string; penPath?: string;
  vision?: "auto" | boolean; reuseExistingFlows?: boolean;
  device?: string; run?: boolean;              // run 缺省 false（止于④）
}
export interface DesignToTestDeps {
  extractFigma?: typeof figmaExtractFlows; extractPen?: typeof penExtractFlows;
  generate?: typeof figmaGenerateTests; gate?: typeof coverageGateIssue;
  listDevices?: () => Promise<Array<{ serial: string; platform?: string }>>;
  execute?: (runtime: Runtime, options: SuiteRunOptions) => Promise<SuiteRunReport>;
  setup?: SetupDeps;
}
export async function designToTest(runtime: Runtime, args: DesignToTestArgs, deps?: DesignToTestDeps): Promise<CallToolResult>;
```

- 行为钉死（D2/D3/D4/D15）：
  1. 参数：`figmaUrl` 与 `penPath` 互斥；两者皆无且 `reuseExistingFlows!==true` → `isError` 用法错误；`nodeId` 仅 figma、`vision` 仅 pen（冲突→用法错误）。
  2. 前置：按参数需 `figma|pen` ＋ `llm` 检查；任一 need → `{ ok:false, needs:"setup", checks:[SetupNeed…] }`（**非 isError**）。
  3. 提取：`reuseExistingFlows===true` 跳过（steps 标 `reused`；`flows.json` 不存在→`{ ok:false, needs:"info", questions:["还没有设计流程——给 Figma 链接或 .pen 路径，或先跑一次设计提取"] }`）；否则调对应提取；失败→`{ ok:false, failedStep:"extract", detail, suggestions }`。
  4. 生成：`figmaGenerateTests({})`；失败→`failedStep:"generate"`。
  5. 校验：`gate(preflightGeneratedTests(configDirAbs))`；issue→`{ ok:false, failedStep:"check", detail:issue, suggestions:["按提示用 figma_generate_tests 修正后重跑"] }`。
  6. 执行（仅 `run===true`）：设备解析＝`args.device` ?? 唯一在线设备（`listDevices`）；无设备→`needs:"setup"`（执行类，target `"device"`，howTo 含 `scripts/adb-safe.mjs devices`／`doctor`）；多设备→`needs:"info"`（候选列表）；**执行前回显** `{ step:"run", cases:N, source, device }`；`execute` 默认封装 `runGeneratedTests(runtime, { testsPath: <configDir>/design/tests.json, … })`（options 构造参照 `src/suite-command.ts` 的既有组合）；返回 report 摘要（gate/计数/traceIds）。
  7. 完成 payload：`{ ok:true, steps:[…], artifacts:{flows?, tests, savedTo?}, run?, nextAction? }`；`run!==true` 时 `nextAction = { tool:"design_to_test", args:{ reuseExistingFlows:true, run:true, device? } }`。
- [ ] **Step 1: 写失败测试**（全桩）：happy（figma：提取→生成→校验→nextAction）；happy（pen＋vision 透传）；参数冲突/全缺；figma 缺 token→needs-setup；llm ping 失败→needs-setup；`reuseExistingFlows` 无 flows→needs-info；gate 失败→failedStep:"check"；`run:true` 无设备→needs-setup(device)；多设备→needs-info；`run:true` happy→回显 steps 含 run（cases/device）且 execute 桩收到正确 options。
- [ ] **Step 2: 红**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 绿**＋build。
- [ ] **Step 5: 提交**：`git commit -m "feat(workflow): design_to_test orchestration (extract → generate → check → optional run)"`

---

### Task 4: 工具接线与注册（`design_to_test`）

**Files:**
- Create: `src/tools/native-tools/workflow.ts`
- Modify: `src/server.ts`（import ＋ `...WORKFLOW_NATIVE_TOOLS` 装配行）
- Test: `test/native-workflow-tool.test.js`（可并入既有 server 工具清单测试）

**Interfaces:**
- Produces: `export const WORKFLOW_NATIVE_TOOLS: NativeToolDefinition[]`（一个工具）。

- [ ] **Step 1: 写失败测试**：
  - 工具清单包含 `design_to_test`（经 `createServerForRuntime` 或既有工具清单测试同路径）；
  - zod：`reuseExistingFlows`/`run` 布尔、`vision` 联合（`"auto"|boolean`）、`device` 字符串；非法类型被拒；
  - 描述包含关键协议句（"needs-setup/needs-info"、"run 缺省 false"、适用信号"设计稿/CR"）——按字面断言，防描述漂移。
- [ ] **Step 2: 红**。
- [ ] **Step 3: 实现**：工具描述写明——适用信号（用户给出设计稿/要做 CR 并验证）＋一条龙步骤＋**run 缺省 false（止于校验，响应含 nextAction）**＋needs 协议；schema 极简（见 Task 3 参数）；`server.ts` 加两行装配。
- [ ] **Step 4: 绿**＋`npm run test:file -- test/server-smoke.test.js` 不回归。
- [ ] **Step 5: 提交**：`git commit -m "feat(tools): expose design_to_test native tool"`

---

### Task 5: 脚本退役＋文档＋全量回归

**Files:**
- Delete: `scripts/design-to-test.mjs`、`test/design-to-test.test.js`
- Modify: `AGENTS.md`（删「设计→测试（一条链）」行；设计流水线段落补一句"一句话入口＝`design_to_test`（缺前置给 needs-setup 指引；run 缺省止于校验）"）、`README.md`（工具表加 `design_to_test` 行）、`DESIGN.md`（新增 §13.119 实施记录：① 阶段范围、决策落点、测试数）

- [ ] **Step 1: 删除脚本与测试**（`git rm`），`grep -rn "design-to-test" --include="*.md" --include="*.mjs" --include="*.ts" .` 确认除本计划/设计稿的历史提及外无残留引用。
- [ ] **Step 2: 文档更新**（要点见 Files）。
- [ ] **Step 3: 全量回归**：`npm run build && npm test && npm run lint` 全绿（记录测试数变化）。
- [ ] **Step 4: 提交**：`git commit -m "docs: design_to_test tool; retire the wrapper script (phase ① of unified service)"`

---

## Self-Review 记录（写稿人自查）

- **Spec 覆盖**：§3.1（`design_to_test`＋脚本退役）→ T3/T4/T5；§5 矩阵（figma/pen/llm/执行类）→ T2/T3；§7 接口与 needs 形状 → T3/T4；D2/D3/D4/D10/D14/D15 → T1–T4；②③④ 阶段不在本计划。`project_archive` 不属 ①。
- **类型一致性**：`SetupNeed`/`SetupDeps`/`DesignToTestArgs`/`DesignToTestDeps` 跨任务同名；`needs:"setup"|"info"` 字面量一致。
- **比例**：5 任务，先红后绿逐任务提交；无整段实现转写。
- **留白**：`SuiteRunOptions` 的字段组合以 `src/suite-command.ts` 既有构造为参照；`pen status` 输出匹配式以本机实测文案（`● Active`／`Not logged in`）为准并可随真实输出微调（行为测试钉在桩文案上）。

## Execution Handoff

计划就绪。建议 **Native（executing-plans）**：5 个任务接口逐一钉死、强顺序依赖、每任务独立测试、最终全量兜底。请审阅计划——确认后选择执行方式（Native／Subagent-driven）。
