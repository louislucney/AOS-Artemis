# 回归服务 P3d 设计（动作层与产物服务鉴权升级：可选静态令牌）

> 2026-10-15 · 前置：P1–P3c 已落地（§13.106–§13.112）；总体设计见 `2026-10-14-regression-service-design.md`（§5.4 动作层「v1 内网无鉴权…鉴权升级见 P3」、§5.5 产物服务「默认 0.0.0.0、无鉴权」）。
> 状态：builder-check 复核后修订；实施计划另出。

## 1. 意图与背景

两个**对外网络面**目前无鉴权（内网假设，风险已在 README/DESIGN 点名）：

| 面 | 现状 | 风险 |
|----|------|------|
| `serve --http` | 默认 loopback；`--host 0.0.0.0` 供 LAN。路由：`/mcp/<project>`（可跑任务/改 LLM 等**写面**）、`/panel/api/*`（任务/裁决/一键建 Jira 单）、`/panel*`、`/usage*` | 任何能访问端口者可**执行任务、写任务/裁决、在真实 Jira 建单**、读看板 |
| runner 产物服务 | 默认 `0.0.0.0`（LAN 预览），`/artifact/<rel>` 读 `.artemis`（含 `logs/`、`crashes/`） | 任何能访问端口者可读日志/崩溃/截图等 |

P3d 升级为**可选静态令牌**鉴权：默认行为对既有内网部署零破坏；启用后对外网络面须持令牌；并对「非 loopback 且未设令牌」的 `serve --http` 给出安全默认（启动失败，显式放行可覆盖）。

## 2. 范围

### 2.1 `serve --http` 令牌（`AOS_HTTP_TOKEN`）

- 未设置＝现状（无鉴权；loopback 本地开发不变）。
- 设置后：**除豁免面外的全部路由**要求认证——`/mcp/<project>`、`/panel`、`/panel.json`、`/panel/api/*`、`/usage`、`/usage.json`、深探层。
- 请求凭据三种等价形式（服务端任一接受）：
  1. `Authorization: Bearer <token>`（脚本/MCP 客户端）；
  2. `Authorization: Basic`（用户名任意/空，**密码＝token**）——浏览器原生弹窗，无前端改造；
  3. 仅产物服务另有 `?t=<token>`（见 2.2；HTTP 服务不开查询参数通道）。
- 未认证 → `401` ＋ `WWW-Authenticate: Basic realm="aos-mcp"`（浏览器据此弹窗）＋ JSON `{"error":"unauthorized"}`。
- **豁免**：`GET|HEAD /` 与 `GET|HEAD /healthz`（探活/探针；serve 补 `HEAD` 处理返回 200 无体，与产物服务 parity）。
- **闸门先于路由**：令牌启用时，一切非豁免路径**先鉴权**——未认证一律 401（含禁用路由与未知路径，不泄露路由存在性）；认证通过后才进入既有 404/路由逻辑。
- **安全默认**：绑定非 loopback（如 `0.0.0.0`/`::`/LAN 地址）且未设 token → **启动失败（exit 2）**，附指引；`AOS_HTTP_ALLOW_INSECURE=1` 显式放行（打印醒目警告）。loopback 绑定不受此限。
- `install`（`--mode http`）：生成客户端配置时，若**操作者进程 env** 有 `AOS_HTTP_TOKEN` → 条目附 `headers: { Authorization: "Bearer <token>" }`（各 target 的 http/remote 形状均注入；输出附一行提示：客户端若不识别自定义 headers，请按其文档配置）；未设 → 不带头并在输出中提示「目标服务若启用令牌，请配置 Authorization」。

### 2.2 runner 产物服务令牌（`AOS_RUNNER_ARTIFACT_TOKEN`）

- 未设置＝现状（默认 `0.0.0.0`＋既有醒目告警；不强制——默认即 0.0.0.0，强制会破坏既有部署）。
- 设置后：`/artifact/*`（GET/HEAD）要求认证，接受 `Authorization: Bearer`、`Authorization: Basic`（密码＝token）、或 `?t=<token>`（书签/直链方便；在 URL 中会入浏览器历史/日志，文档明示取舍）。
- 豁免：`GET|HEAD /healthz`。
- 未认证 → `401` ＋ `WWW-Authenticate: Basic realm="aos-artifact"`。
- 令牌不随心跳广播（不落 PG、不出现在面板链接）——面板产物链接保持纯 URL，浏览器首次访问时按弹窗输入（每个 runner 源各弹一次）。

### 2.3 令牌卫生与文档

- 令牌仅来自**进程 env**（serve 为 workspace 级服务、runner 在其命令层读取、install 读取操作者进程 env——三者均无「项目 `.env`」语义）；不落 PG；日志不落 token（启动行与 doctor 用 masked 预览）。
- `Bearer`/`Basic`/`?t=` 比较用 `crypto.timingSafeEqual`（先做长度归一，防时序侧信道）。
- 不提供 CLI `--token` 参数（`ps` 可见泄露）——env 是唯一配置面。
- README 风险段与启动提示更新；DESIGN §13.113；AGENTS.md 对应行。

## 3. 非目标

- 多用户/账号体系、角色权限（读/写分级）、OAuth/SSO、mTLS、令牌轮换与过期工具（列 P3+）。
- 独立 CLI 看板（`panel --web`/`usage --web`）——loopback 默认即安全；如需后续加 `--token`（本设计不排他）。
- 产物服务代理取文件/签名 URL（中心仍只拼 URL）。
- 面板前端登录页/会话管理（选 Basic 正是为避免前端改造）。
- 改动任何**默认绑定**（loopback/0.0.0.0 维持现状；只加「非 loopback 无 token 拒绝」的 serve 安全默认）。

## 4. 硬约束

- 测试口径：http 级真实 loopback 服务、假 env、不触网；测试跑 `dist/`；`pg-mem`/内存 store 不变。
- 兼容：未设 token 时所有既有行为逐字不变（既有 http-server/panel-command/runner-artifact 测试为回归锁）。
- 相对导入 `.js`；代码英文、用户文案中文；默认不加注释；401 响应不泄露内部细节。
- 完工标准：`npm run build && npm test && npm run lint` 全绿；同步 DESIGN（§13.113）＋ README ＋ AGENTS.md。

## 5. 关键决策（本次方案判断；可被否决/修订）

| # | 决策 | 理由 | 若否决的代价 |
|---|------|------|--------------|
| D1 | 机制＝**静态共享令牌**（Bearer＋Basic 双接受）；不做账号/角色 | 内网单团队场景的最简有效鉴权；浏览器零改造（Basic） | 若要多用户，需引入账号/会话体系（大改） |
| D2 | `serve`：token 可选；**非 loopback 无 token → 启动失败**（`AOS_HTTP_ALLOW_INSECURE=1` 放行） | 「升级」的安全默认；loopback 开发不受扰；显式放行保留逃生门 | 若要求仅告警不失败，LAN 暴露面仍可无鉴权运行 |
| D3 | artifact：token **可选**（设＝强制；未设＝现状＋告警）；不因默认 0.0.0.0 强制 | 默认即 0.0.0.0，强制会破坏所有既有部署；升级以「推荐配置」呈现 | 若要求强制：既有部署全需补 token（可接受但需迁移说明） |
| D4 | 浏览器路径＝Basic 401 challenge；脚本＝Bearer；artifact 另允 `?t=` | 前端零改造；`?t=` 的 URL 泄露取舍文档明示 | 若禁用 `?t=`，书签/直链体验退化 |
| D5 | 令牌仅**进程 env**（无项目 `.env` 语义；serve 为 workspace 级）；无 CLI flag；`timingSafeEqual`；日志 masked | `ps`/日志泄露面最小化；安全默认检查与令牌读取同源（避免「.env 设了但检查读不到」的误拒） | 若需 `.env` 便利，需为各入口新增 dotenv 装载（行为面变大） |
| D6 | `install --mode http` 自动带 `Authorization` 头（**操作者进程 env** 有 token 时）；各 target 的 http/remote 形状均注入，附「客户端若不支持自定义 headers 需按其文档」提示 | 客户端接线零手改；不确定的 target 以提示兜底，不静默 | 若逐 target 核实能力后再条件注入，实现更繁琐（可后续细化） |
| D7 | 豁免仅 `/` 与 `/healthz` | 探活必须无凭据（容器/复盘探针） | 若连 `/` 也认证，监控探针需改造 |
| D8 | 不改默认绑定；独立 CLI 看板不在范围 | 最小升级面；loopback 默认已安全 | 若要求 CLI 看板也带鉴权，后续小票 |

## 6. 接口草案（细节留给计划）

- **env**：`AOS_HTTP_TOKEN`（serve）、`AOS_RUNNER_ARTIFACT_TOKEN`（runner；options 传入 artifact server）、`AOS_HTTP_ALLOW_INSECURE`（仅 serve 安全默认放行）。
- **判定助手**（建议 `src/auth.ts` 共享）：`isLoopbackHost(host: string): boolean`（`127.0.0.1`/`::1`/`localhost`）；`authorizeRequest(reqHeaders, url, token, { allowQueryToken?: boolean }): boolean`（Bearer/Basic/`?t=`＋timingSafeEqual）；`unauthorizedResponse(realm): { status, headers, body }`（401＋`WWW-Authenticate`）。
- **http-server**：URL 解析后、路由分派前插入闸门（豁免 `GET|HEAD /` 与 `GET|HEAD /healthz`；补 `HEAD` 处理返回 200 无体）；启动处插入安全默认（`host` 非 loopback && `!token` && `!allowInsecure` → throw；`allowInsecure` → WARN）；启动日志含 `认证：已启用（masked）/未启用`。
- **artifact-server**：`StartRunnerArtifactServerOptions` 增 `token?: string`（`suite runner` 命令层从进程 env 读取传入）；`/healthz` 豁免、其余先鉴权；启动行含认证状态。
- **install**：http 条目形状增可选 `headers`；从**进程 env** 读取 token 注入（各 target 形状一致附加）；输出提示（含「客户端不支持 headers 时按其文档」一行）。
- **usage web（serve 内）**：随闸门一并保护；独立 `usage --web` 不变。

## 7. 测试口径（映射，具体用例随计划）

| 面 | 覆盖点 |
|----|--------|
| http-server | 未设 token：全路由既有行为回归（逐字）；设 token：无凭据 → 401＋WWW-Authenticate；Bearer/Basic（用户名任意/空）通过；错 token 401；`GET|HEAD /`、`GET|HEAD /healthz` 豁免（HEAD 200 无体）；**闸门先于路由**（禁用路由/未知路径：无凭据 401、有凭据 404）；`/panel/api/*` 同样受保护；启动安全默认（非 loopback 无 token → 失败；`ALLOW_INSECURE` → 放行＋WARN；loopback 不受限）；**来源断言**（项目 `.env` 里的同名变量不被读取） |
| artifact-server | 未设 token：既有回归；设 token：401（含 realm）/Bearer/Basic/`?t=` 通过/错 token 401/`GET|HEAD /healthz` 豁免 |
| install | env 有 token → 各 target http/remote 条目带 `Authorization` 头＋提示；无 token → 无 headers＋提示；既有形状字段不回归 |
| 卫生 | 启动日志/doctor 输出不含 token 明文（masked 断言）；比较逻辑单元（等/不等/长度差异） |
| 回归 | 面板/usage/MCP 既有测试全绿；未设 token 零行为变化 |

## 8. 留给实现/计划的（不阻塞）

- `src/auth.ts` 是否落独立文件 vs 各服务内联（倾向独立共享）；`Basic` 解析细节（大小写、缺 `:`、空密码）；401 body 文案；启动日志措辞；install 输出提示文案；测试 harness（真实 loopback 端口）。

## 9. builder-check 复核记录（2026-10-15）

独立 subagent（只读文档＋相关代码）提出 5 个实质问题，全部在文档内定案、无遗留待用户问题：

1. **令牌来源与 env 通路不一致（serve 为 workspace 级、runner 在命令层、install 只读 process.env）** → 统一为**仅进程 env**（§2.3/D5；安全默认检查与读取同源）。
2. **闸门与禁用/未知路由的优先级未定** → **闸门先于路由**：无凭据一律 401（不泄露路由存在性），通过后 404/路由照旧（§2.1/§7）。
3. **各 target 的 headers 支持不一** → 全 target 注入＋提示兜底（D6 修订；逐个能力核实列实现细化）。
4. **install 读谁家 `.env`** → 收束为**操作者进程 env**（D6；无项目 `.env` 语义）。
5. **serve `HEAD /healthz` 现为 404（仅 GET 处理）** → 补 `HEAD /` 与 `HEAD /healthz` 返回 200 无体（§2.1/§6/§7）。
