# CMS 开放服务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增独立 `cms-open` HTTP 服务：接收静态 Figma/.pen 设计源与 per-request LLM/Figma 凭证，异步生成 `design.md` + `cases.xlsx` + `screens/` 的 zip。

**Architecture:** 独立进程内跑 job 队列；`DesignRuntimeLike` 显式注入凭证，禁止 env 回落；Figma 静态稿用「原型边 > 箭头/连线 > 文字注释 > 画布顺序」合成 `INFERRED` 流程；复用现有线性化/用例模型，Web 文案改写；Excel 支持占位符与表头映射两种模版。

**Tech Stack:** TypeScript ESM + Node 22、Node 内置 `http`/`fetch`/`Response.formData`、exceljs、现有 `src/figma`/`src/pen` 模块、Node 内置 `node:test`。

**Spec:** `docs/superpowers/specs/2026-10-21-cms-open-design-to-tests-design.md`

## Global Constraints

- 命令名 `cms-open`，默认端口 `8780`，默认只监听 `127.0.0.1`。
- 无鉴权；CORS 默认拒绝跨源；写请求校验 `Origin`/`Host`。
- 凭证只在请求/任务生命周期内存在：不写日志、不落盘、不写 PG。
- JSON body ≤ 1 MB；multipart 单文件 ≤ 50 MB；并发 3、队列 20、单任务 10 分钟、产物 TTL 2 小时。
- 不改现有 MCP 工具行为；所有测试不依赖真实 PG/设备/外网。
- 每步完成先 `npm run build`；最终 `npm run build && npm test && npm run lint` 全绿；DESIGN.md 增实施记录。
- 修改 `src/vendor/design-context-bridge/` 必须带 `PATCH (aos-mcp)` 并同步 `NOTICE`。

## Review Focus

1. 两个并发 job 使用不同 LLM key / Figma token 时，请求头与产物不得互串。
2. 静态稿只有文字注释、没有箭头时，仍能合成流程；完全无注释时回退画布顺序。
3. 只有表头的普通 Excel 模版不得静默错位；缺必需列必须报 `template_invalid` 并列出缺失列。
4. 跨源 `multipart/form-data` 请求（CORS 安全清单类型，可绕预检）必须在 `Origin` 不在白名单时 403。
5. 服务重启后未知 job 必须返回 404 + 可行动提示，客户端不能无限轮询。

---

### Task 1: DesignRuntimeLike + per-request Figma token + LLM 注入

**Files:**
- Create: `src/figma/design-runtime.ts`
- Modify: `src/figma/flows.ts`（`figmaExtractFlows` 签名与 `fetchFile` 调用）
- Modify: `src/figma/test-gen.ts`（`figmaGenerateTests` 签名与 `fetchFile` 调用）
- Modify: `src/figma/render.ts`（`fetchNodes`/`fetchImages` 增加 token 参数）
- Modify: `src/pen/flows.ts`（`penExtractFlows` 签名接受 `DesignRuntimeLike`）
- Modify: `src/vendor/design-context-bridge/figma-rest/client.ts`（token 显式参数）
- Modify: `src/vendor/design-context-bridge/NOTICE`
- Test: `test/open-credentials.test.js`

**Interfaces:**
- Produces:
  ```ts
  // src/figma/design-runtime.ts
  export interface DesignRuntimeLike {
    configDirAbs: string;
    project: { rootDir: string; dotenvValues?: Record<string, string> };
    store: ProjectStore;
    activeEntry?: () => Promise<unknown>;
  }
  export interface DesignDeps { chat?: ChatFn; figmaToken?: string | null; }
  ```
- `figmaExtractFlows(runtime: DesignRuntimeLike, args, deps?: FigmaFlowsDeps & DesignDeps)`
- `figmaGenerateTests(runtime: DesignRuntimeLike, args, deps?: GenerateTestsDeps & DesignDeps)`
- `penExtractFlows(runtime: DesignRuntimeLike, args, deps?: PenFlowsDeps & DesignDeps)`
- Vendored: `fetchFile(fileKey: string, depth?: number, token?: string)`、`fetchNodes(fileKey, nodeIds, token?)`、`fetchImages(fileKey, nodeIds, format?, scale?, options?, token?)`。

- [ ] **Step 1: Write failing test** — `test/open-credentials.test.js`：stub `globalThis.fetch` 记录每次请求的 `X-Figma-Token`；并发调用两次 `figmaExtractFlows`（同一 temp project，deps.figmaToken 分别为 `tok-a`/`tok-b`），断言两次请求头分别匹配、`process.env.FIGMA_ACCESS_TOKEN` 未被改写。
- [ ] **Step 2: Run it** — `npm run build && node --test test/open-credentials.test.js`；预期 FAIL（token 参数不存在/读到 env）。
- [ ] **Step 3: Implement** — 在 vendored client 增加可选 `token` 参数（`getToken(override?)` 优先 override），逐层透传；`flows.ts`/`test-gen.ts`/`render.ts` 从 `deps.figmaToken` 传入；把三个入口的 `Runtime` 类型改为 `DesignRuntimeLike`，`activeEntry` 仅在 `deps.chat` 缺失时调用。
- [ ] **Step 4: Run test** — 同上；预期 PASS。
- [ ] **Step 5: Commit** — `git add src/figma src/pen src/vendor test/open-credentials.test.js && git commit -m "feat: inject per-request figma token and design runtime"`。

---

### Task 2: 静态 Figma 流程合成

**Files:**
- Create: `src/open/figma-static.ts`
- Test: `test/open-figma-static.test.js`
- Test fixture: `test/fixtures/open-figma-static.json`（3 个 frame、1 条带箭头 LINE、1 条画板旁 TEXT、无原型交互）

**Interfaces:**
- Produces:
  ```ts
  export interface StaticSynthesisResult { graph: FlowGraph; warnings: FlowWarning[]; }
  export function synthesizeStaticFlows(file: unknown, options?: {
    screens?: boolean;
    chat?: ChatFn;
    maxScreens?: number;
  }): Promise<StaticSynthesisResult>;
  ```
- 复用 `FlowGraph`/`FlowScreen`/`FlowEdge`（`src/figma/flows.ts`）。

- [ ] **Step 1: Write failing test** — 断言：3 个 screen 按 y/x 排序；A→B 来自 LINE 箭头（`provenance=inferred`、`confidence=low`）；B→C 来自注释“点击登录进入首页”；无箭头/注释时按顺序串链；空文档返回 `no_screens` warning。
- [ ] **Step 2: Run it** — 预期 FAIL（模块不存在）。
- [ ] **Step 3: Implement** — 遍历 `document.children` 收集顶层 FRAME；几何端点映射（点在 bounds 内或距离 ≤24px）；注释按正则 `(?:点击|进入|跳转|输入).*?(?:→|->|进入|跳转)\s*(.+)` 解析，失败且有 `chat` 时一次结构化抽取；所有推断边 `element.type="inferred"`、`provenance="inferred"`、`confidence="low"`。
- [ ] **Step 4: Run test** — 预期 PASS。
- [ ] **Step 5: Commit** — `git add src/open/figma-static.ts test/open-figma-static.test.js test/fixtures/open-figma-static.json && git commit -m "feat: synthesize flows from static figma screens"`。

---

### Task 3: Web 文案 + Excel 表头映射

**Files:**
- Create: `src/figma/web-wording.ts`
- Create: `src/open/template-map.ts`
- Modify: `src/figma/test-xlsx.ts`（导出默认列/占位符探测 helper）
- Test: `test/open-web-wording.test.js`、`test/open-template-map.test.js`

**Interfaces:**
- Produces:
  ```ts
  export function rewriteCasesForWeb(cases: GeneratedTest[]): GeneratedTest[];
  export async function fillWorkbookByHeader(input: {
    templatePath: string; outputPath: string; cases: GeneratedTest[];
    meta: { source: string; generatedAt: string; model: string | null };
  }): Promise<void>;
  export function templateHasCasePlaceholders(templatePath: string): Promise<boolean>;
  ```
- 必需表头：`用例编号`、`功能`、`用例名称`、`前置条件`、`操作步骤`、`预期结果`；可选 `优先级`；别名：`用例标题`→`用例名称`、`步骤`→`操作步骤`、`预期`→`预期结果`。

- [ ] **Step 1: Write failing tests** — 断言 Web 改写后不含 `mobile_run_task`/`App`/`设备`，`taskDesc` 为空；表头模版逐行填充、缺 `操作步骤` 列时报错并列出缺失列、额外列保持空白。
- [ ] **Step 2: Run them** — 预期 FAIL。
- [ ] **Step 3: Implement** — 文案替换表（点击/输入/进入/断言）；ExcelJS 读表头、建列索引、逐用例写行；占位符模版走原有 `renderTestsWorkbook`，不进入映射。
- [ ] **Step 4: Run tests** — 预期 PASS。
- [ ] **Step 5: Commit** — `git add src/figma/web-wording.ts src/open/template-map.ts src/figma/test-xlsx.ts test/open-web-wording.test.js test/open-template-map.test.js && git commit -m "feat: web wording and header-mapped excel templates"`。

---

### Task 4: Job 管理器 + 原子 zip

**Files:**
- Create: `src/open/jobs.ts`
- Create: `src/open/zip.ts`
- Test: `test/open-jobs.test.js`、`test/open-zip.test.js`

**Interfaces:**
- Produces:
  ```ts
  export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
  export interface JobRecord { id: string; status: JobStatus; step: string; createdAt: string; finishedAt: string | null; error: { code: string; message: string; hint?: string } | null; artifactPath: string | null; }
  export class JobManager {
    create(): JobRecord;
    get(id: string): JobRecord | null;
    cancel(id: string): JobRecord | null;
    claimNext(): JobRecord | null;
    complete(id: string, artifactPath: string): void;
    fail(id: string, error: { code: string; message: string; hint?: string }): void;
    expire(nowMs: number): string[];
  }
  export function buildZip(entries: Array<{ path: string; data: Buffer }>): Buffer;
  ```
- `buildZip` 使用 store 模式（不压缩）与 CRC32；路径不接受 `..`/绝对路径。

- [ ] **Step 1: Write failing tests** — 队列 FIFO、并发上限 3、maxQueue 满时 `queue_full`、10 分钟超时置 failed、cancel 语义、TTL 过期删除；zip 能被 `unzip -l` 列出且条目名正确。
- [ ] **Step 2: Run them** — 预期 FAIL。
- [ ] **Step 3: Implement** — 内存 Map + 队列；超时用注入的 `now`/timer；zip 写本地头/中央目录/EOCD，CRC32 表。
- [ ] **Step 4: Run tests** — 预期 PASS。
- [ ] **Step 5: Commit** — `git add src/open/jobs.ts src/open/zip.ts test/open-jobs.test.js test/open-zip.test.js && git commit -m "feat: cms open job manager and zip writer"`。

---

### Task 5: 生成流水线（提取 → 合成 → 用例 → 打包）

**Files:**
- Create: `src/open/pipeline.ts`
- Test: `test/open-pipeline.test.js`

**Interfaces:**
- Consumes: Task 1 `DesignRuntimeLike`/`figmaExtractFlows`/`figmaGenerateTests`；Task 2 `synthesizeStaticFlows`；Task 3 `rewriteCasesForWeb`/`fillWorkbookByHeader`；Task 4 `buildZip`。
- Produces:
  ```ts
  export interface OpenJobInput { source: "figma" | "pen"; figmaUrl?: string; figmaToken?: string; nodeId?: string; penFile?: string; templatePath?: string; llm: { baseUrl: string; model: string; apiKey: string } | null; maxFlows?: number; maxDepth?: number; }
  export async function runOpenJob(input: OpenJobInput, workDir: string, deps?: { extractFigma?: ...; extractPen?: ...; generate?: ... }): Promise<{ zipPath: string; counts: { screens: number; cases: number }; warnings: string[] }>;
  ```
- 临时项目结构：`workDir/project/.artemis/design`；`DesignRuntimeLike` 的 `store` 用 `MemoryStore`；`activeEntry` 抛错（chat 必须注入）。

- [ ] **Step 1: Write failing test** — stub 提取/生成；断言 zip 含 `design.md`、`cases.xlsx`、`screens/a.png`、`meta.json`；meta 含 model/maxFlows/maxDepth/warnings；无用例时抛 `no_cases` 并带原因。
- [ ] **Step 2: Run it** — 预期 FAIL。
- [ ] **Step 3: Implement** — 原型交互存在则走 `figmaExtractFlows`，否则 `synthesizeStaticFlows`；写 `flows.json`/`flow-map.md`；生成后 `rewriteCasesForWeb`；模版分派；汇总 zip 与 meta。
- [ ] **Step 4: Run test** — 预期 PASS。
- [ ] **Step 5: Commit** — `git add src/open/pipeline.ts test/open-pipeline.test.js && git commit -m "feat: cms open generation pipeline"`。

---

### Task 6: HTTP 服务（路由 / CORS / 限额）

**Files:**
- Create: `src/open/server.ts`
- Create: `src/open/multipart.ts`
- Test: `test/open-server.test.js`

**Interfaces:**
- Produces:
  ```ts
  export interface CmsOpenServerOptions { host?: string; port?: number; cors?: string[]; maxQueue?: number; jobTimeoutMs?: number; retentionMs?: number; }
  export async function startCmsOpenServer(options?: CmsOpenServerOptions): Promise<{ port: number; close: () => Promise<void> }>;
  ```
- 路由：`POST /jobs`、`GET /jobs/:id`、`DELETE /jobs/:id`、`GET /jobs/:id/download`、`GET /healthz`。
- 写请求校验：`Origin` 存在且不在白名单 → 403；`Host` 非 loopback/允许值 → 403；`Content-Type` 必须匹配；body 限额。

- [ ] **Step 1: Write failing tests** — 创建 → 轮询 → 下载；未知 job 404 + `job_not_found`；未完成 409；过期 410；`DELETE` 取消；`Origin: https://evil` 403；`multipart` 无 Origin 的跨源模拟 403；JSON >1MB 413。
- [ ] **Step 2: Run them** — 预期 FAIL。
- [ ] **Step 3: Implement** — Node `http`；multipart 用 `Request.formData`（多文件）；错误 JSON `{ error, code, hint? }`；下载 `Content-Disposition` 附件名 `design-tests-<jobId>.zip`。
- [ ] **Step 4: Run tests** — 预期 PASS。
- [ ] **Step 5: Commit** — `git add src/open/server.ts src/open/multipart.ts test/open-server.test.js && git commit -m "feat: cms open http service"`。

---

### Task 7: CLI、关停、文档与全量验证

**Files:**
- Create: `src/open/command.ts`
- Modify: `src/cli.ts`（`cms-open` 子命令）
- Modify: `README.md`、`DESIGN.md`
- Test: `test/open-command.test.js`

**Interfaces:**
- Produces: `runCmsOpen(argv: string[], io?): Promise<number>`；`--port/--host/--cors/--max-queue/--job-timeout-ms/--retention-ms`。

- [ ] **Step 1: Write failing test** — 非法端口 exit 2；`--host 0.0.0.0` 打印告警；SIGINT 关闭监听；`--help` 文案含五个 flag。
- [ ] **Step 2: Run it** — 预期 FAIL。
- [ ] **Step 3: Implement** — 参数解析、启动/关停、日志（stderr）、README 增「CMS 开放服务」、DESIGN 增实施记录。
- [ ] **Step 4: Run full suite** — `npm run build && npm test && npm run lint`，预期 2036+ 全绿、lint 0 error。
- [ ] **Step 5: Commit** — `git add src/open src/cli.ts test/open-command.test.js README.md DESIGN.md && git commit -m "feat: cms-open standalone design-to-tests service"`。

---

## Self-Review

- 覆盖 spec：独立服务（Task 6/7）、per-request 凭证（Task 1）、静态合成（Task 2）、Web 文案与模版双模（Task 3）、job 边界/取消/超时（Task 4/6）、zip/meta（Task 4/5）、CORS（Task 6）、错误码（Task 4/6）、文档（Task 7）。
- Review Focus 五项均有对应任务测试（Task 1/2/3/6/6）。
- 类型一致：`DesignRuntimeLike` 贯穿 Task 1/5；`JobRecord` 贯穿 Task 4/5/6。
- 未覆盖：`pen` 上传的实际渲染只在 Task 5 的端到端测试中桩化；真实 pen CLI 验收列入 Task 7 手工冒烟（不联网测试）。
