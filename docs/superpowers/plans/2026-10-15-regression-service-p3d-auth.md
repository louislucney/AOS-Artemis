# 回归服务 P3d 实施计划（鉴权升级：可选静态令牌）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为两个对外网络面引入**可选静态令牌**鉴权：`serve --http`（全路由闸门＋非 loopback 无 token 启动失败的安全默认）与 runner 产物服务（设置即强制，含 `?t=`）；`install --mode http` 自动注入 `Authorization` 头。

**Architecture:** 共享小模块 `src/auth.ts`（loopback 判定 / 凭据判定（Bearer＋Basic＋可选 `?t=`，timingSafeEqual）/ 401 响应构造）；`src/http-server.ts` 在 URL 解析后、路由分派前插闸门（豁免 `GET|HEAD /` 与 `/healthz`，补 HEAD 200 无体），启动处插安全默认；`artifact-server.ts` options 增 token 并在处理前鉴权；install 的 http 条目形状增 `headers`。令牌仅来自**进程 env**，不落 PG、日志 masked、无 CLI 参数。

**Spec:** `docs/superpowers/specs/2026-10-15-regression-service-p3d-design.md`（D1–D8 与复核记录 §9；总体设计 `2026-10-14-regression-service-design.md` §5.4/§5.5）

## Global Constraints

- 测试口径：真实 loopback 端口服务、假 env、不触网；测试跑 `dist/`；`pg-mem`/内存 store 不变。
- 相对导入一律带 `.js` 后缀；代码英文、用户文案中文；默认不加注释（仅保留解释非显然契约的 JSDoc）。
- 兼容：**未设令牌时所有既有行为逐字不变**（既有 http-server/panel-command/runner-artifact 测试为回归锁）。
- 完工标准：`npm run build && npm test && npm run lint` 全绿；同步 DESIGN（新增 §13.113）＋ README（风险段与令牌用法）＋ AGENTS.md（HTTP/runner 行）＋ `.env.example`（`AOS_HTTP_TOKEN`/`AOS_RUNNER_ARTIFACT_TOKEN`/`AOS_HTTP_ALLOW_INSECURE`，只写变量名）。
- **拍板（D1–D8 摘要）**：D1 静态共享令牌（Bearer＋Basic 双接受）；D2 serve 非 loopback 无 token → 启动失败（`AOS_HTTP_ALLOW_INSECURE=1` 放行＋WARN）；D3 artifact token 可选（设＝强制）；D4 浏览器 Basic challenge、脚本 Bearer、artifact 另允 `?t=`；D5 令牌仅进程 env、无 CLI flag、timingSafeEqual、日志 masked；D6 install 从进程 env 注入 headers（全 target＋提示）；D7 豁免 `GET|HEAD /` 与 `/healthz`、闸门先于路由（非豁免路径无凭据一律 401）；D8 不改默认绑定、独立 CLI 看板不在范围。

## Review Focus

1. **未设令牌零行为变化**：既有路由/状态码/响应逐字回归（含禁用路由 404、MCP 端点、面板动作）。
2. **令牌卫生**：启动日志与 install 输出均 masked、非 CLI 参数、不落 PG；`timingSafeEqual` 前长度归一（不等长不崩、不短路口径泄露）。
3. **安全默认**：非 loopback 无 token 必拒（附指引）；`ALLOW_INSECURE` 显式放行＋醒目 WARN；loopback 不受限；来源统一进程 env（项目 `.env` 同名变量不生效——断言）。
4. **闸门优先级与豁免**：token 启用时禁用/未知路径无凭据 → 401、有凭据 → 既有 404；`GET|HEAD /`、`/healthz` 豁免且 HEAD 返回 200 无体。
5. **双路径可用**：Basic（`WWW-Authenticate` realm 正确、浏览器可弹窗）与 Bearer 均通过；artifact 的 `?t=` 仅在 artifact 服务生效（HTTP 服务不认查询参数）。

---

### Task 1: 共享鉴权模块 `src/auth.ts`（判定与 401 构造）

**Files:**
- Create: `src/auth.ts`
- Test: `test/auth.test.js`（新）

**Interfaces:**
- Produces：
  ```ts
  /** 仅 127.0.0.1 / ::1 / localhost（含大小写）视为 loopback。 */
  export function isLoopbackHost(host: string): boolean;
  /** 带凭据判定：`Authorization: Bearer <t>` / `Authorization: Basic <base64(user:pass)>`（密码＝token，用户名任意/空）；
   * options.allowQueryToken 时另接受 URL `?t=<token>`。比较用 crypto.timingSafeEqual（先做长度归一，长度不等直接 false）。 */
  export function authorizeRequest(input: {
    authorization: string | undefined;
    queryToken?: string | null;
    token: string;
    allowQueryToken?: boolean;
  }): boolean;
  /** 401 响应三件套（含 `WWW-Authenticate: Basic realm="<realm>"` 触发浏览器弹窗）。 */
  export function unauthorizedResponse(realm: string): {
    status: 401;
    headers: Record<string, string>;
    body: string;
  };
  ```
- 语义：Bearer/Basic 解析大小写不敏感（scheme 部分）、Basic base64 解码失败/缺 `:` → 视为无凭据；token 与解析值比较必须 timingSafeEqual（对 base64 解码后的密码串；长度先比、不等直接 false 但走一次等长填充比较亦可——实现选常时安全写法并注释契约）。401 body＝`{"error":"unauthorized"}`（JSON），headers 含 `Content-Type: application/json` 与 `WWW-Authenticate`。

- [ ] **Step 1: 写失败测试**（`test/auth.test.js`）
  - `isLoopbackHost：127.0.0.1/::1/localhost 真；0.0.0.0/::/192.168.x/LAN 名 假；大小写与空白边界`。
  - `authorizeRequest：Bearer 正确→true；Basic（user:pass 密码=token、空用户名）→true；错 token/缺头/空头→false；allowQueryToken=false 时 ?t= 不生效、=true 时生效；Base64 非法/缺冒号→false；token 空串→一律 false`。
  - `unauthorizedResponse：status 401、含 WWW-Authenticate: Basic realm="<realm>"、body 为 JSON`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/auth.test.js`。
- [ ] **Step 3: 实现**（`src/auth.ts`；`timingSafeEqual` 常时比较，长度归一；默认无注释，仅对比较契约加 JSDoc）。
- [ ] **Step 4: 跑测试确认通过** + `npm run build`。
- [ ] **Step 5: 提交**：`git commit -m "feat(auth): static token helpers (bearer/basic/query, timing-safe)"`

### Task 2: `serve --http` 闸门与安全默认

**Files:**
- Modify: `src/http-server.ts`、`src/cli.ts`（serve 分支的 exit 2 出口——C1 修订）
- Test: `test/http-server.test.js`（追加）

**Interfaces:**
- Consumes：Task 1（`isLoopbackHost`/`authorizeRequest`/`unauthorizedResponse`）。
- 语义：
  - 启动读取（**直接读 `process.env`**，与文件既有取法一致；I1 修订）：`token = (process.env.AOS_HTTP_TOKEN ?? "").trim()`；`allowInsecure = process.env.AOS_HTTP_ALLOW_INSECURE === "1"`。
  - **安全默认**（解析 host/token 之后、`RuntimeHost.prepare` **之前**——fail-fast 无副作用；M1）：`!isLoopbackHost(host) && token === "" && !allowInsecure` → `throw new InsecureBindRefusedError(指引文案)`（含：设置 `AOS_HTTP_TOKEN` 或显式 `AOS_HTTP_ALLOW_INSECURE=1`）；`allowInsecure && !isLoopbackHost(host) && token === ""` → `log()` 醒目 WARN。
  - **exit 2 出口（C1 修订）**：`http-server.ts` 导出该错误类型；`src/cli.ts` 的 `serve` 分支包 try/catch——捕获该类型 → 将指引打印至 stderr → `process.exit(2)`；其余错误维持既有顶层出口（exit 1）。
  - **闸门**：URL 解析后、所有路由分派前：`if (token !== "" && !isExempt(method, pathname) && !authorizeRequest({authorization: req.headers.authorization, token}))` → 发送 401（Task 1 的 `unauthorizedResponse("aos-mcp")`）；**401 写回对 HEAD 抑制 body**（M3：HEAD 不写体、`Content-Length: 0`）。`isExempt = (m, p) => (m === "GET" || m === "HEAD") && (p === "/" || p === "/healthz")`。**不读查询参数**（allowQueryToken 不启用）。
  - **HEAD 补全**：`GET|HEAD /` 与 `GET|HEAD /healthz` 均 200 无体（HEAD 不写 body；沿用健康检查 JSON 形状对 GET）。
  - 启动日志：追加 `认证：已启用（Bearer/Basic，token=<masked>）/未启用`（masked 用既有 `maskSecret`；**不得输出明文**）。
- [ ] **Step 1: 写失败测试**（`test/http-server.test.js` 追加；沿用该文件真实 loopback＋port 0 harness）
  - `未设 token：既有路由行为回归（/healthz、/panel 404/200、/mcp 鉴权前路径、404 未知）`（既有断言即锁，新增仅在必要处）。
  - `设 token：无凭据 → 401＋WWW-Authenticate（/panel、/panel.json、/usage、/mcp/<p>、/panel/api/*）；Bearer 通过；Basic（密码=token）通过；错 token 401`。
  - `豁免：GET|HEAD / 与 /healthz → 200（HEAD 无体）`；`禁用路由（AOS_PANEL_WEB=0/AOS_USAGE_WEB=0）与未知路径：无凭据 401、有凭据 404`。
  - `行级：401-on-HEAD 无体（Content-Length 0）`。
  - `安全默认：host=0.0.0.0 无 token → 启动 throws（信息含指引、且不产生 prepare 副作用）；ALLOW_INSECURE=1 → 可启动（并断言有警告日志）；host=127.0.0.1 无 token → 正常启动`。
  - `来源断言：仅 process.env 生效——测试以 process.env 设值＋try/finally 还原（与既有 harness 风格一致）；「项目 .env 同名变量不生效」为弱回归断言（http-server 不加载 dotenv，恒真即可）`。
  - `cli 出口：InsecureBindRefusedError → serve 捕获后 stderr 指引＋exit 2（若既有 cli 测试可注入进程则补一条；否则实现保证＋Task 5 DESIGN 记录）`。
  - `日志断言：启动行含 masked 片段、不含明文 token`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/http-server.test.js`。
- [ ] **Step 3: 实现**（按「语义」；保持既有路由与 404/413 行为不变）。
- [ ] **Step 4: 跑测试确认通过** + `npm run test:file -- test/panel-command.test.js`（独立看板不回归）＋ `npm run build`。
- [ ] **Step 5: 提交**：`git commit -m "feat(http): static token gate + non-loopback safety default"`

### Task 3: runner 产物服务令牌

**Files:**
- Modify: `src/runner/artifact-server.ts`（**既有 `env?` 缝**：`startRunnerArtifactServer` 内从 `options.env ?? process.env` 读取 `AOS_RUNNER_ARTIFACT_TOKEN`——M5 修订：不新增 `token?` 选项、命令层已传 env、无需改 `suite-command.ts`）
- Test: `test/runner-artifact.test.js`（追加）；命令层回归 `test/suite-runner.test.js`（M4：实际文件名，无 `-cli`）

**Interfaces:**
- Consumes：Task 1（`authorizeRequest`/`unauthorizedResponse`）。
- 语义：`token = ((options.env ?? process.env).AOS_RUNNER_ARTIFACT_TOKEN ?? "").trim()`；启用后 `/artifact*`（GET/HEAD）先鉴权：`authorizeRequest({authorization, queryToken: url.searchParams.get("t"), token, allowQueryToken: true})`；未过 → 401（`unauthorizedResponse("aos-artifact")`；**HEAD 抑制 body**）。**`GET|HEAD /healthz` 豁免**（既有处理不变）。未设 token → 一切照旧。启动行含 `认证：已启用（token=<masked>）/未启用`。
- [ ] **Step 1: 写失败测试**（`test/runner-artifact.test.js` 追加）
  - `未设 token：既有测试回归`。
  - `设 token：无凭据 401＋realm；Bearer 通过；Basic 通过；?t= 通过；错 token 401；/healthz 豁免（GET 与 HEAD）`。
  - `命令层接线：suite runner 以 env AOS_RUNNER_ARTIFACT_TOKEN 启动 → artifact server 收到 token（注入断言）；启动日志 masked`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过** + build。
- [ ] **Step 5: 提交**：`git commit -m "feat(runner): optional artifact service token"`

### Task 4: `install --mode http` 注入 Authorization 头

**Files:**
- Modify: `src/install.ts`
- Test: 既有 install 测试文件追加（`test/install.test.js` 或该功能实际测试文件；实现时定位）

**Interfaces:**
- Consumes：无（独立）。
- 语义：`token = (process.env.AOS_HTTP_TOKEN ?? "").trim()`。
  - `ServerEntry` 的 http 形状增可选 `headers?: Record<string, string>`；`buildServerEntry` 在 `mode === "http" && token !== ""` 时置 `headers: { Authorization: \`Bearer ${token}\` }`。
  - `targetPlan` 各 target 的 http/remote 映射带上 `headers`（存在才带）：claude/vscode `{type:"http",url,headers?}`；cursor 裸对象 `{url,headers?}`；opencode `{type:"remote",url,enabled:true,headers?}`（以文件实际形状为准）。
  - 输出提示：token 存在 → 追加一行「已注入 Authorization 头；客户端若不支持自定义 headers，请按其文档配置」；不存在 → 既有输出追加「目标服务若启用令牌，请在客户端配置 Authorization」。
  - **不打印 token 明文**（输出中一律 masked）。
- [ ] **Step 1: 写失败测试**（既有 install 测试追加）
  - `env 有 token：各 target 写入的配置含 headers.Authorization（Bearer <真实值>——写入配置文件是必须的，允许出现在文件断言中；输出提示 masked）`。
  - `env 无 token：无 headers＋提示行`。
  - `既有形状字段不回归（command/args/env/url 等）`。
  - `幂等语义（M6）：含 headers 的既有条目重装默认 skipped——token 变更需 --force（测试断言 + Task 5 README 提及）`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过** + build。
- [ ] **Step 5: 提交**：`git commit -m "feat(install): inject Authorization header for http mode"`

### Task 5: 文档＋全量回归

**Files:**
- Modify: `DESIGN.md`（§13.113）、`README.md`、`AGENTS.md`、`.env.example`

- [ ] **Step 1: 全量回归**：`npm run build && npm test && npm run lint` → 全绿（记录新增测试数与总数）。
- [ ] **Step 2: 文档**
  - DESIGN §13.113：P3d 实施记录（机制/闸门优先级与豁免/安全默认/双路径/artifact `?t=`/install 注入/令牌卫生；D1–D8 口径收束）。
  - README：更新三个「无鉴权」风险段（serve 动作层、产物服务、usage 看板）为「可选令牌＋serve 安全默认」表述；补令牌用法（env 名、Bearer/Basic/`?t=`、install 自动注入）。**必写（I2 修订）**：① `?t=` 会进入 URL/浏览器历史/访问日志的取舍提示；② 浏览器流指引——首次访问 `/panel*`（GET）触发 Basic 弹窗，认证按 origin 缓存后同源 `/panel/api/*` fetch 自动携带（各环境或有差异，建议先打开一次页面再点动作按钮）；③ install 幂等——token 变更后需 `--force` 重装。
  - AGENTS.md：HTTP 服务行与 runner 行补鉴权一句；`.env.example` 增 `AOS_HTTP_TOKEN`/`AOS_RUNNER_ARTIFACT_TOKEN`/`AOS_HTTP_ALLOW_INSECURE`（注释说明、只写变量名）。
  - DESIGN §13.113 另记两条边界（复核 M2/M3）：`isLoopbackHost` 为纯字符串判定（`::ffff:127.0.0.1`/解析到 loopback 的主机名均按非 loopback **fail-closed**）；401 对 HEAD 抑制 body。
- [ ] **Step 3: 提交**：`git commit -m "docs: regression service P3d (auth tokens)"`

## 独立复核修订记录（2026-10-15）

计划评审（deepseek/deepseek-v4-pro#high，只读）结论「需先修订（1 Critical＋2 Important）」；发现已全部并入：

- **C1（Critical）**：serve 无 exit 2 出口（实际 exit 1）——Task 2 增 `src/cli.ts`：导出专用错误类型（如 `InsecureBindRefusedError`），serve 分支捕获 → stderr 指引＋`exit 2`；其余错误维持 exit 1。
- **I1（Important）**：`HttpServerOptions` 无 `env` 字段——统一为**直接读 `process.env`**（与文件现状/既有 harness 一致）；测试以 process.env 设值＋try/finally 还原。
- **I2（Important）**：README 必写项补 `?t=` 取舍、浏览器 Basic/fetch 流指引（Task 5）。
- **M1**：安全默认检查置于 `RuntimeHost.prepare` 之前（fail-fast 无副作用）。
- **M2**：`isLoopbackHost` 纯字符串判定（fail-closed 边界）→ DESIGN 记录。
- **M3**：401 对 HEAD 抑制 body（serve 与 artifact）。
- **M4**：runner 测试文件名修正为 `test/suite-runner.test.js`。
- **M5**：artifact 令牌复用既有 `env?` 缝（不新增 `token?` 选项；命令层无需改）。
- **M6**：install 幂等——token 变更需 `--force` 重装（测试＋README）。

---

## 范围外（另立计划）

- 账号/角色/OAuth/mTLS/令牌轮换；独立 CLI 看板鉴权；产物签名 URL/中心代理；默认绑定不改变。
