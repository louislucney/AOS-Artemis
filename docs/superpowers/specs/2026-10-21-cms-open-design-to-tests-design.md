# CMS 开放服务：设计图 → 理解 → 测试用例（2026-10-21，评审修订版）

## 1. 背景与目标

CMS 侧是一个网页系统，需要一个**独立于 MCP / IDE** 的服务：提交设计源与本次使用的 LLM 凭证，等待生成完成，然后下载一份 zip：

- `design.md`：设计图理解（流程、页面、交互、截图）
- `cases.xlsx`：测试用例；调用方可上传自己的 Excel 模版（占位符或表头映射）
- `screens/`：md 引用的截图文件

与现有 `design_to_test` 的区别：目标系统是 **Web/CMS**，不面向 App；只生成、不执行；不依赖本机项目目录与中心 PG。

## 2. 非目标

- 不执行测试、不接设备、不产生 ARTEMIS trace。
- 不做账号体系与鉴权（本期明确不要求；服务默认只监听 loopback）。
- 不做表单校验规则推断（静态稿只能看到字段与注释，推断校验规则会编造）。
- 不替代现有 MCP 工具与 `serve --http`；两者并存。
- 不做多租户项目库；每次请求的产物相互隔离，按 TTL 清理。

## 3. 使用方式

新增独立 CLI 子命令（避开 shell `open` 与 runner 产物端口 8770）：

```bash
node dist/cli.js cms-open --port 8780 [--host 127.0.0.1] [--cors <origin>] [--max-queue 20] [--job-timeout-ms 600000] [--retention-ms 7200000]
```

- 独立进程，不读项目 `aos.config.jsonc`，不依赖 `MOBILE_TESTING_DATABASE_URL`。
- 默认 `127.0.0.1`；显式 `--host 0.0.0.0` 时启动打印醒目告警（无鉴权）。
- CORS 默认**不放开**；`--cors` 指定允许来源（逗号分隔）。
- 任务只在内存；产物落临时目录，完成后保留 2 小时。

### 3.1 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/jobs` | 创建生成任务，返回 `{ jobId }` |
| `GET` | `/jobs/:id` | 状态 / 进度 / 错误 |
| `DELETE` | `/jobs/:id` | 取消（queued 直接取消；running 协作式中止） |
| `GET` | `/jobs/:id/download` | 完成后下载 zip；未完成 409，过期 410，未知/重启后 404 |
| `GET` | `/healthz` | `{ ok: true, bootId }` |

`POST /jobs` 支持两种 Content-Type：

**application/json**（body ≤ 1 MB）

```jsonc
{
  "source": { "type": "figma", "url": "https://www.figma.com/design/…", "token": "figd_…", "nodeId": "1:2" },
  // 或 { "type": "pen" } + multipart 的 pen 文件
  "llm": { "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat", "apiKey": "sk-…" },
  "maxFlows": 20,
  "maxDepth": 30
}
```

**multipart/form-data**：`source`（JSON 字符串或 `figma`/`pen`）、`figmaUrl`、`figmaNodeId`、`figmaToken`、`llm`（JSON）、`penFile`（`.pen`）、`template`（`.xlsx`）。单文件上限 50 MB。

`jobId` 为随机 UUID；`jobId` 本身即下载凭据（无鉴权部署下的能力 URL，LAN 内可接受）。

### 3.2 状态

```jsonc
{
  "jobId": "…",
  "status": "queued | running | done | failed | cancelled",
  "step": "queued | extracting | synthesizing | screenshots | generating | packaging",
  "progress": { "screens": 12, "cases": 8 },   // 可缺省
  "createdAt": "…",
  "finishedAt": "… | null",
  "error": { "code": "figma_auth", "message": "…", "hint": "…" } // failed 时
}
```

页面交互：点「生成」→ 每 2s 轮询 `GET /jobs/:id` → `done` 后显示下载按钮 → `GET /jobs/:id/download`。生成通常 1–3 分钟，不保证同步返回。

### 3.3 服务边界契约

- **重启**：任务只在内存；重启后未知 id 返回 `404 { code: "job_not_found", hint: "任务不存在或服务已重启，请重新提交" }`。客户端不得把 404 当可重试。
- **队列上限**：`--max-queue` 默认 20（含 running）；满时 `429 { code: "queue_full" }`，不落盘。
- **任务超时**：`--job-timeout-ms` 默认 10 分钟；超时中止子任务，任务 failed `job_timeout`。
- **取消**：`DELETE /jobs/:id`；queued → `cancelled`；running → 置取消标记，协作式中止 LLM/子进程后 `cancelled`；已终态幂等返回当前状态。
- **下载状态**：未知/重启后 404；未完成 409 `job_not_ready`；过期 410 `job_expired`；完成 200。
- **zip 原子性**：先写临时文件，成功后 rename，再流式发送；中途失败不发送半包。
- **并发**：最多 3 个 job 同时生成，其余排队；v1 不做公平调度（文档写明）。

### 3.4 下载包

```
design.md
cases.xlsx
screens/<screen-slug>.<png>
meta.json        # 必须：source / generatedAt / model / maxFlows / maxDepth / counts / warnings
```

`design.md` 内图片使用相对路径 `screens/…`；截图文件名去重，同 slug 追加序号。

## 4. 生成流水线

### 4.1 凭证与上下文注入（评审重点）

**禁止**复用 `process.env` / `activeEntry()` / 项目 `.env` 的隐式读取。新增 `JobContext` 作为唯一注入缝：

```ts
interface JobContext {
  llm: { baseUrl: string; model: string; apiKey: string } | null;
  figmaToken: string | null;
  chat: ChatFn;                  // 由 JobContext 构造，不读 runtime.activeEntry()
  figma: FigmaClient;            // per-job token，不调用 src/figma/token.ts 的 process.env 赋值
  workDir: string;               // 临时项目根
  configDir: string;             // workDir/.artemis
  penEnv: NodeJS.ProcessEnv;     // 仅本 job 的 pen 变量
}
```

复用模块新增可选 `ctx` 参数；`ctx` 存在时必须走 ctx，不得回落全局。实施前先做**全链路 env/全局读审计**并列入计划：

- Figma REST token、图片拉取；
- LLM chat / vision；
- pen CLI env、托管路径；
- `AOS_SCREENS` 等开关（改为 ctx 显式值）。

隔离测试：并发两个 job，分别带不同 LLM key 与 Figma token，断言请求头/计费/产物互不串用；pen 状态不跨 job。

### 4.2 设计源解析

**Figma（静态稿为主）**：现有 `figma_extract_flows` 只从原型交互生成边，静态稿会 0 路径。新增**静态流程合成**（`src/figma/static-flows.ts`，与 App/CMS 共用），并接入 `figma_extract_flows` 作为 fallback（原型边优先；默认开，`staticFallback:false` 或 `AOS_STATIC_FALLBACK=0` 关闭）：

1. 屏幕：顶层 `FRAME`（排除组件/隐藏），按画布位置排序（上→下、左→右）。
2. 连线：`LINE`/`VECTOR`（含箭头 marker）节点；端点落在/靠近画板 → 边；方向取箭头端；无法判定方向时按画布顺序。
3. 文字注释：画板附近的 `TEXT`（不在画板内），解析“动作 → 目标”；
   - 先走确定性模式（`点击/进入/跳转/输入 … → …`）；
   - 解析失败且提供了 LLM → 一次结构化抽取（JSON schema：`from, action, to, confidence`），失败记 warning。
4. 兜底：画布顺序串主链；仍无屏幕 → `no_screens`。
5. 与原型混用：原型边优先，推断边只补未覆盖屏幕。

所有推断边 `provenance=inferred`、`confidence=low`；`design.md` 标注“推断流程，需复核”；不因推断失败中断，单屏用例兜底。v1 只覆盖导航与被注释的输入动作，不推断校验规则。

**`.pen`**：保存上传文件，复用 `pen_extract_flows`；托管 `pen` CLI 缺失时截图/视觉降级并写警告，flows 仍可合成。

### 4.3 用例生成

- 复用流程线性化与用例模型（`src/figma/test-gen.ts`）。
- Web/CMS 文案：步骤用浏览器动作（打开/进入、点击、输入、选择、断言），不出现 App/设备/ARTEMIS；不生成 `taskDesc`。
- 默认列：`用例编号 | 功能 | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 优先级`；优先级固定 `P2`。
- LLM 角色：只做视觉识别、功能命名、注释解析；用例由流程结构确定性生成。LLM 不可用时降级并写 warning，不失败（注释解析失败回退布局顺序）。
- 非多模态模型：跳过视觉，`meta.json` 与 md 警告“设计理解可能偏弱”。

### 4.4 Excel 模版（两种模式）

1. **占位符模式**：模版含 `{{meta.*}}/{{counts.*}}/{{case.*}}/{{index}}` → 复用 `src/figma/test-xlsx.ts`。
2. **表头映射模式**：无占位符 → 读取第一个工作表的表头，按列名映射：
   - 必需：`用例名称`、`操作步骤`、`预期结果`；
   - 可选：`用例编号`、`功能`、`前置条件`、`优先级`；其它列留空；
   - 缺必需列 → `template_invalid`，错误列出缺失列（可行动）；
   - 表头别名（`用例标题`→`用例名称`、`步骤`→`操作步骤`、`预期`→`预期结果`）在实现中定义并测试。

两种模式都先校验再写；不静默错位。

## 5. 安全

- LLM key / Figma token 只在请求生命周期内驻留内存；不写日志、不落盘、不写 PG；错误摘要不回显。
- **CORS**：默认不放开跨源；`--cors` 白名单。所有写请求校验 `Origin`（存在且不在白名单 → 403）与 `Host`（仅 loopback/允许的 host，防 DNS rebinding）。`multipart/form-data` 属 CORS 安全清单类型，跨源 POST 会绕预检，不能只靠响应头。
- JSON body ≤ 1 MB；multipart 单文件 ≤ 50 MB，超限 413。
- SSRF：Figma URL 仅接受 `figma.com`/`www.figma.com` 设计链接；LLM `baseUrl` 仅 http(s)，可选 `--llm-allowlist`（域名列表，缺省不限制，文档注明）。
- 临时目录只允许本服务写入；下载路径不接受客户端文件名；jobId 不可预测。
- 无鉴权、明文 HTTP：README 注明仅内网/反代 TLS 使用。

## 6. 失败与降级

| 场景 | 行为 |
|---|---|
| Figma 401/403 | `figma_auth` |
| Figma 404 / 坏 URL / 无效 nodeId | `figma_not_found` / `invalid_source` |
| Figma 429 | 有界重试后 `figma_rate_limit`；429 等待期间状态保持 running，`meta.json` 记录耗时 |
| 截图渲染失败 | 逐屏降级 `screenshot-*`，任务仍 done |
| LLM 调用失败/超时 | 命名/注释/视觉降级 + warning；不失败（除非用户显式要求严格模式） |
| 模版不合法/缺列 | `template_invalid`，列出缺失占位符或列 |
| 生成 0 条用例 | `no_cases`，带原因：无交互且无注释/连线、maxFlows 过窄、或截图/视觉降级 |
| 队列满/超时/取消 | `queue_full` / `job_timeout` / `cancelled` |
| 下载未知/未完成/过期 | 404 / 409 / 410 |

## 7. 测试

- HTTP：创建 → 轮询 → 下载；JSON/multipart、超大文件、未知 job、未完成/过期下载、取消、队列满、重启后 404 文案。
- 静态合成：画板顺序、箭头连线、文字注释、原型混用、单屏兜底；推断边标 `inferred/low`。
- 流水线桩：stub 提取/生成，断言 zip 内容与相对路径、meta.json 必需字段。
- 模版：占位符、表头映射、缺列报错、别名。
- 凭证隔离：并发两个不同 LLM/Figma 凭证的 job；日志与响应不含 key/token。
- CORS/Origin/Host：默认拒绝跨源、白名单放行、`Origin` 伪造 403。
- 超时/取消：LLM 挂起与子进程中止。
- 全量 `npm run build && npm test && npm run lint` 绿，DESIGN.md 增实施记录。

## 8. 已确认与默认决策

已确认：等待出结果后点击下载；Figma token 每次请求提供；默认 Excel 列；本期不做鉴权；Figma 以静态稿为主（箭头/线条 + 画板旁文字注释）；LLM 只做视觉/命名/注释解析，用例确定性生成；模版支持占位符与表头映射。

默认决策（可推翻）：

1. 命令名 `cms-open`，默认端口 `8780`（避开 runner 的 8770）。
2. 下载为单个 zip；md 中截图用相对路径，不内嵌 base64。
3. 任务状态只在内存，进程重启丢失；产物 TTL 2 小时；并发 3、队列 20、单任务 10 分钟。
4. 只生成人工可读步骤，不生成自动化脚本（Playwright 等）。
5. md 主体复用 `flow-map.md`，不额外生成“测试说明”md。

## 9. 复用与改动面

- 新增：`src/open/`（HTTP 服务、job 管理、输入解析、静态 Figma 合成、打包）。
- 复用：`figma/flows.ts`、`pen/flows.ts`、`test-gen.ts`、`test-xlsx.ts`。
- 改造：提取/生成入口支持显式 `JobContext`（禁止 env 回落）；Web 文案 profile；表头映射；静态合成。
- CLI：`src/cli.ts` 增 `cms-open`；README / DESIGN 增说明。

## 10. 后续扩展：可选设计阅读（2026-10-27）

- 请求字段：`reading`（默认 false）、`readingStates`、`readingMaxScreens`（默认 30、最大 200）、`readingAnswers`（本次请求规则，≤100 条）；只传后三者时自动开启阅读。
- 顺序：flows 提取后、用例生成前调用 `runDesignReading`；阅读失败/无 LLM/缺 flows 只写 warning，不阻断生成。
- 产物：zip 增 `design-reading.md/json`；`design.md` 追加「## 设计阅读」摘要；`meta.json.reading` 记录状态与计数；任务 `step` 增 `reading`。
- 人工答案：写入任务临时目录 `design/reading/answers.json`，不读项目 `.artemis`；随任务生命周期结束。
- 边界：`readingStates` 依赖 pen `states`；大稿受 10 分钟任务超时与视觉配额约束；默认关闭以保持 CMS 交付时延/SLA。
