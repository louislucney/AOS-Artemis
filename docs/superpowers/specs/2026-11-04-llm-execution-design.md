# Web LLM 执行接线设计（R10）v3

> 2026-11-04 · 状态：**实现中（P0 Node 骨架已落地；ARTEMIS hooks/install/panel 未完成）**
> 关联：`DESIGN.md` §13.302（数据源 P0）、§13.304（APK/IPA appId）、§13.305（CSV 导入）、`src/web/results.ts`（结果/计费契约）、`src/artemis/`（ARTEMIS 子进程）、`docs/superpowers/specs/2026-10-28-web-project-test-platform-design.md` §4.7/§4.8。
> v2 评审处置见 §2.2；本轮把“脱敏/注入在哪一层生效”“UNVERIFIED 如何进契约”“Android 隧道到底转什么”三处机制钉死。

## 1. 目标

`executionMode=llm` 现在只是占位：`createWebJob` 允许创建，runner 执行入口直接返回 `llm-execution-not-wired`（`src/runner/web-executors.ts:465`）。R10 要让手工 Excel/CSV 的 `taskDesc` 直接交给 LLM 执行器，不依赖 Maestro flow，并且：

1. **必须支持远程执行机**；
2. LLM key 只在中心，远程 runner 不持有；
3. Excel/taskDesc 可发给 LLM，但账号/密码/token 等敏感内容必须自动移除；执行时用占位符注入；
4. 结果、证据、token 成本、Excel 写回与 Maestro 模式同口径；
5. **不能伪造 PASS**。

## 2. 决策与评审处置

### 2.1 产品决策

| # | 决策 | 设计承接 |
|---|---|---|
| 1 | 必须远程 | P0 远程 Android；P0b 远程 iOS；无“仅中心本机”阶段 |
| 2 | key 只在中心 | 中心 LLM Worker 执行 ARTEMIS；runner 不持 key |
| 3 | 可发 LLM，但账号等内容自动移除 | Redactor + SecretInjector + ARTEMIS hooks（§4） |
| 4 | 证据缺参照物 | L1 确定性 + L2 reference + L3 verifier；无 L1/L2 不判 PASS（§5） |
| 5 | 接受 SSH/内网 | runner 作为设备网关，SSH 反向隧道（§3.2） |
| 6 | 重试 token 计入 | attempt/phase + 全量汇总（§6.4） |
| 7 | runner 只做设备宿主 | 设备网关 + 反向隧道；不执行 LLM（§3.1） |

### 2.2 评审处置

| 评审项 | 结论 | 落点 |
|---|---|---|
| K1 脱敏/注入画在 Worker 层 | **接受** | 新增 ARTEMIS hook 清单与 fail-closed；Worker 只做 taskDesc 入口脱敏，观察/动作/落盘在 ARTEMIS hook 内完成（§4.4） |
| K2 UNVERIFIED 没有契约 | **接受，修法调整** | 已有 `WebResultVerdictStatus`/Excel/聚合支持；缺的是**中心 LLM Worker 直连 ingest 的入口**。不把 UNVERIFIED 加进 runner 上报枚举，改为 center-only 解析（§6.2） |
| M1 隧道 loopback/部署耦合 | **接受** | P0 单实例、隧道与 worker 同宿主；端口漂移/重连/在途失败语义（§3.2） |
| M2 进程粒度 | **接受** | 每用例一个 ARTEMIS 子进程；clearState/preconditions/归因（§3.4） |
| M3 L1 证据版本 | **接受** | L1 在原始未脱敏证据上评估；L3 只看脱敏；散文预期不产 L1（§5.3） |
| M4 无预期列护栏 | **接受** | 创建时警告+确认；无预期/reference 全部 UNVERIFIED（§5.4） |
| M5 预算算术 | **接受** | 任务预算按用例数派生；per-case 步数/token 上限（§7） |
| M6 Android 走 Appium | **接受问题，否决“ARTEMIS 本来会说 Appium”** | ARTEMIS Android 实际走 adb/uiautomator2（`artemis/artemis/clients/accessibility_client.py`、`mcp_server/background/task_runner.py` 的 adb server），不支持 Appium。P0 转发 **runner 的 adb server**，Appium 作为 P1 替代；安装走 gateway（§3.5） |
| L1 P0 verifier 范围 | 接受 | P0 不跑独立 verifier，`verification.verifier:"not-run"`；P1 启用 |
| L2 sourceEventId | 接受 | 计费事件 id 含 requestId/attempt（§6.4） |
| L3 pending 原因 | 接受 | 新增 `llm-worker-offline` |
| L4 截图脱敏 | 接受 | bbox 遮罩为主、OCR 兜底；严格模式可疑账户文本 block |
| L5 verifier 语义 | 接受 | 引用失败证据→FAIL；仅存疑→UNVERIFIED |
| L6 受控目录/OTP | 接受 | 未脱敏证据仅 admin/maintainer；OTP 用例标不可自动化 |
| L7 deviceHosts 优先级 | 接受 | Web LLM 用 host 级 gateway；项目 `deviceHosts` 只服务 MCP（§8.3） |

## 3. 架构

```
┌──────────────────────────── 中心 ────────────────────────────┐
│ HTTP/面板/任务队列（PG/文件台账）                             │
│ Center LLM Worker（独立 CLI）                                 │
│   ├─ claim executionMode=llm（CAS）                           │
│   ├─ taskDesc 入口脱敏 + secret 绑定检查                      │
│   ├─ ARTEMIS 子进程（每用例一个）                             │
│   │    └─ AOS LLM hooks：观察脱敏/动作注入/trace 脱敏/usage    │
│   ├─ L1 确定性检查（原始证据）+ L2 reference                  │
│   ├─ L3 verifier（P1）                                        │
│   └─ ingestWebJobResult（center-only UNVERIFIED）              │
│ Device Gateway Registry（host → adb server/Appium endpoint）  │
└───────────────▲───────────────────────────────┬───────────────┘
                │ runner 主动建 SSH -R 反向隧道  │ 结果/租约/心跳
┌───────────────┴───────────────────────────────▼───────────────┐
│ 远程 runner（设备网关模式）                                    │
│   - 注册 host/devices/gateway endpoints/隧道状态               │
│   - 本地 adb server（USB 设备）或 Appium 端口 → SSH -R         │
│   - install 控制面：下载中心资产、校验 sha、安装、返回版本     │
│   - Maestro 任务仍由现有 web-runner 执行                       │
│   - 不执行 LLM、不持 key                                      │
└───────────────────────────────────────────────────────────────┘
```

### 3.1 方案对比

| 备选 | 结论 |
|---|---|
| runner 内置 ARTEMIS | key 下发/代理、Python/venv/依赖矩阵重；不选 |
| 中心 agent + 动作 RPC | 每步往返、新协议/原语；P0 不选 |
| 纯中心本机 | 违反“必须远程”；不选 |
| **中心执行 + 设备网关（选定）** | key 不出中心；复用 ARTEMIS trace/checker/artifacts；runner 只做设备/隧道/租约/安装 |

### 3.2 设备网关与隧道

- runner 启动注册：host、devices、`android.adbServer`、`ios.appiumUrl`、隧道状态、版本。
- **反向隧道**：runner 主动 `ssh -R` 到中心；中心侧仅 loopback 绑定；`ExitOnForwardFailure=yes`、`ServerAliveInterval/CountMax` 保活；每 runner 一密钥，中心 `authorized_keys` 加 `restrict,port-forwarding`。
- **P0 部署亲和**：单中心实例、隧道宿主＝LLM worker 宿主；endpoint 注册带 `tunnelInstanceId`/端口；worker 只领取同实例注册的 endpoint。多实例/HA 留 P1，需独立隧道网关服务（绑定宿主网卡而非 loopback）。
- **端口漂移**：SSH `-R` 动态端口 → runner 重连后重新注册端口；在途任务因 endpoint 变化 `failed`（`llm-gateway-endpoint-changed`），不静默改派；新任务用新端口。
- **健康**：注册/心跳/端口探测；不可达 → 任务 pending，原因 `llm-gateway-unavailable`；无 worker → `llm-worker-offline`。
- **Android 转什么**：转发 runner 本机 **adb server**（`ADB_SERVER_SOCKET=tcp:127.0.0.1:<forwarded>`），不是设备 adbd；USB 设备无需 `adb tcpip`。runner 侧 adb server 只绑 loopback（`adb -a nodaemon server` 的暴露风险用 SSH 隧道隔离）。
- **iOS**：转发 Appium HTTP 端口；P0 不做 mTLS（SSH 隧道即认证边界），P1 共享网关再加令牌。

### 3.3 任务路由与租约

- `maestro`：现有 `web-runner` 领取/执行/回写，不变。
- `llm`：Center LLM Worker 领取；`web-runner` 不领取；两端 `claim` 都按 `executionMode` 硬过滤。
- 创建任务仍由中心 `acquireDeviceLeases` 预占；LLM worker 领取后持租约、续租、完成/失败/取消释放。
- 多实例：PG CAS；文件台账仅单中心。失联按现有 stale claim 回收；worker 崩溃保留已生成 trace。
- 取消：停止 ARTEMIS 子进程（协作式中止），已完成用例保留，未完成写 `SKIP（未执行）`。

### 3.4 进程模型（M2）

- **每用例一个 ARTEMIS 子进程**：
  - 超时＝kill 子进程，干净；
  - 用例隔离：`clearState`/preconditions 语义与 Maestro 模式对齐（启动前重置应用数据/登录态按 `preconditionMode`）；
  - 部分结果保留：已完成的用例先落库；
  - token 归因：per-case `data_engine.db`/status 天然按用例切分。
- 子进程启动参数带 `AOS_LLM_CASE_ID`；stdout/stderr 落 job 目录，日志脱敏。

### 3.5 安装路径（M6）

- 中心不直接 `adb install` 大文件过隧道；新增 gateway 控制面：
  - `POST /gateway/install`（中心→runner，经现有 runner 控制面/心跳通道）；
  - runner 下载中心资产（sha256 校验）、安装（adb/`devicectl`/Appium `app` 能力）、返回 package/version；
  - 安装失败 → 任务 `ERROR`（environment），不进入 LLM。
- 已安装同版本可跳过；强制重装/清数据由任务参数控制；安装产物不进 LLM 上下文。

## 4. 脱敏与注入（K1）

**结论：Worker 层只负责入口 taskDesc 脱敏；UI 树/截图/动作/落盘必须在 ARTEMIS 进程内 hook。** 否则 §4 只是政策，不是机制。

### 4.1 Secret inventory

- 来源：materials secret 文件、项目 `.env` 的 `AOS_WEB_SECRET_*`、面板绑定的 secret 别名。
- 每个 secret：`alias/value/kind/scope`；只在中心内存/0600 读取；不进日志/CAS/LLM。

### 4.2 入口脱敏（Worker）

1. 精确值按长度降序替换为 `<secret:alias>`；覆盖 taskDesc/步骤/预期/testData。
2. 模式脱敏：邮箱、手机号、身份证/银行卡、Bearer/JWT、密码/验证码邻近值。
3. 未绑定 account-like 文本 → `llm-secret-unbound`，拒绝该用例，不发给 LLM。
4. `AOS_WEB_LLM_REDACT_STRICT=1` 默认；只审计脱敏次数/类型，不记值。

### 4.3 执行时注入

- LLM 只允许输出 `<secret:alias>`（`valueRef`）；注入器在动作执行瞬间替换真值。
- 替换后的命令不进 trace/日志；证据目录保留原始截图，但只给受控角色。
- 截图/UI 树在进入下一轮模型/verifier 前脱敏：已知 secret 值 + bbox 遮罩；OCR 兜底；严格模式可疑 account 文本 block。

### 4.4 ARTEMIS 改造/挂载清单

不直接改上游 submodule 的首选：在 `scripts/artemis-llm-hooks/` 提供 Python hook 包，通过 `PYTHONPATH`/`sitecustomize` 注入；hook 失败即 fail-closed。若某 hook 点不存在，才按 AGENTS 规则给 `artemis` 打 `PATCH (aos-mcp)` 并更新 NOTICE。

| # | Hook 点 | 责任 | 验收 |
|---|---|---|---|
| H1 | LLM provider/router（`artemis/artemis/llm/`） | 请求前脱敏文本/图像；响应 usage 透传 | 测试 prompt 中 grep secret 0 命中；usage 落 `tokenUsage` |
| H2 | 观察层（`accessibility_client`/snapshot/screenshot） | UI 树文本脱敏、截图 bbox/OCR 遮罩后再交给模型 | 截图注入区遮罩；UI 树无 secret |
| H3 | 动作层（uiautomator2/adb/Appium input） | `<secret:alias>` 解析、执行瞬间注入、回传目标 bbox | 命令/日志无 secret；登录成功 |
| H4 | trace/DB 写入（`status.json`/`data_engine.db`/notes） | 落盘前脱敏；原始证据另存受控目录 | 对 `status.json`/DB 文本表 grep 0 命中 |
| H5 | LLM 边界 usage/step 记录 | per-case token/阶段/requestId | 重试/verifier token 可归因 |

- **fail-closed**：H1–H4 任一不可用 → 需要 secret 的用例直接 `llm-secret-hook-unavailable`，不降级为把密码发给模型。
- **P0 验收**：已知 secret 字符串对全部文本工件 grep 0 命中；截图注入区遮罩检查；命令日志 grep 0 命中。

## 5. 证据与判定

### 5.1 分层

| 层 | 内容 | 评估对象 |
|---|---|---|
| L1 确定性 | 期望文本可见/不可见、正则、UI selector、无错误弹窗/崩溃 | **原始未脱敏证据**（中心本地，不经过模型） |
| L2 参照物 | 设计稿/`ui-contract`/reference 截图，区域/文本比对 | 原始证据 + 参照物 |
| L3 独立 verifier | 脱敏 trace/截图 + 预期，输出 PASS/FAIL/UNVERIFIED + 引用步骤 | 脱敏证据 |
| L4 人工 | 面板人工标记 | 结果/证据 |

### 5.2 PASS 规则（修评审指出的矛盾）

- PASS 必须同时满足：
  1. **至少 1 条确定性证据（L1 或 L2）通过**；
  2. 没有 L1/L2 失败、错误弹窗、崩溃；
  3. L3 verifier 不反对（P0 未启用时记 `not-run`，不阻塞）；
  4. 有截图/步骤证据与 traceId。
- 只有 L3 通过、没有 L1/L2 → `UNVERIFIED`。
- 只有 L2、没有文本期望 → L2 通过可 PASS；reference 缺失 → UNVERIFIED。
- 纯视觉/无数值预期的用例默认 UNVERIFIED，提示补 reference。

### 5.3 L1 版本与预期抽取（M3）

- L1 在**原始证据**上跑：确定性检查不过模型，无泄漏面；避免“预期含手机号→脱敏成占位符→占位符对占位符永假”的假 FAIL。
- L3 只看脱敏证据；L3 不能看原始 secret。
- 预期散文抽取：
  - 有引号/明确锚点（`显示/出现/包含` + 文本）→ 生成文本断言；
  - 无锚点自由文本 → 不产 L1，直接 UNVERIFIED（fail-closed）；不把整句当 substring 造成假 FAIL。

### 5.4 无预期列护栏（M4）

- 创建 LLM 任务时检查 Excel 是否有预期列/reference：
  - 两者都无 → 面板显式警告并要求确认：“该 Excel 无预期列，LLM 执行将全部 UNVERIFIED，且仍计费”；
  - API 可用 `allowUnverified:true` 显式放行；否则 400 `llm-no-expectation`。
- 任务详情/报告列出 UNVERIFIED 数与原因（`no-reference`/`no-assertion`/`verifier-uncertain`）。

### 5.5 verifier 语义（L5）

- verifier 引用具体失败证据（步骤/截图/检查）→ `FAIL`；
- 仅“无法确认/存疑” → `UNVERIFIED`；
- verifier 不能把 L1/L2 失败改 PASS。
- P0 不启用独立 verifier，`verification.verifier:"not-run"`；P1 启用。

## 6. 结果、UNVERIFIED 与计费

### 6.1 结果契约

- 复用 `WebJobResultDocument`；LLM 模式 additive：
  - `execution.cases[].traceId`、`evidenceSteps[]`；
  - `verification:{deterministic:{passed,failed,skipped},reference:"passed|missing|failed",verifier:"pass|fail|unverified|not-run"}`；
  - `tokenUsage[].attempt`、`phase`、`requestId`。
- `tokenArtifacts` 必须含 `dataEngineDb`/`statusJson`；缺失 `token-unavailable`，不写 0。
- Excel 写回复用 8 列摘要/平台结果列；UNVERIFIED 原样写（已有 `values.result = "UNVERIFIED"`），与 `SKIP（未执行）` 互斥；证据列写 traceId + 截图。

### 6.2 UNVERIFIED 入口（K2 修正）

现状（`src/web/results.ts`）：

- `WebResultVerdictStatus = WebResultCaseStatus | "UNVERIFIED"`（:35）；
- Excel 已写 `UNVERIFIED`（:883）；任务聚合已计 `unverified` 并落 `partial`（:603/:628）；
- 但 HTTP runner 上报解析只接受 `PASS/FAIL/SKIP/ERROR`（:372），注释明确“UNVERIFIED 由中心派生，runner 不得直接上报”。

因此**不把 UNVERIFIED 加进 runner 枚举**，改为：

- 新增 center-only 结果入口（LLM worker 直接调用 `ingestWebJobResult` 的内部参数/`centerOrigin:true`），允许 `status:"UNVERIFIED"`；
- HTTP runner 路径仍拒绝 UNVERIFIED；
- Excel/聚合复用已有逻辑，无需改写回映射；
- 文档明确“UNVERIFIED 可由中心 LLM worker 直接产生，runner 不得上报”。

### 6.3 任务聚合

- any FAIL/ERROR → `failed`；
- 否则 any SKIP/UNVERIFIED → `partial`；
- 全 PASS → `completed`；空结果 → `error`（不冒充成功）。
- 已有 `taskStatusFromGate`/`aggregate` 逻辑复用。

### 6.4 token 与计费

- 首跑、失败重试、verifier 全部计入；`tokenUsage` 带 `attempt/phase/requestId`。
- 计费事件幂等键（平台 §15 挂账）必须含 `requestId`/attempt，不能只用 `(projectId, sourceEventId, purpose)`，否则重试 token 会被去重塌缩。
- 缓存 token 按厂商语义拆分；失败任务也计费；`token-unavailable` 单独计数并阻断该任务出账。

## 7. 运行预算（M5）

- 默认不再用固定 2h：任务上限 = `min(AOS_WEB_LLM_JOB_MAX_MS, cases × AOS_WEB_LLM_CASE_TIMEOUT_MS × (1 + maxRetries) + overhead)`；默认 case 15min、retry 0、job max 8h。
- per-case 步数上限 `AOS_WEB_LLM_MAX_STEPS`（默认 80）与 token 上限 `AOS_WEB_LLM_MAX_TOKENS_PER_CASE`；超限 → `budget-exceeded`，已发生 token 仍计费。
- 取消/超时保留已完成用例；常量集中到模块常量，环境变量覆盖。

## 8. 安全与部署

### 8.1 隧道/端口

- P0 单实例、worker 与隧道同宿主；endpoint 注册带实例/端口；重连刷新；在途任务失败语义见 §3.2。
- SSH `-R` 动态端口 + `ExitOnForwardFailure` + 保活；每 runner 一密钥；`restrict,port-forwarding`。

### 8.2 安装

- gateway `/gateway/install`：runner 下载资产、sha 校验、安装、返回版本；中心不把 APK/IPA 过大文件塞进 adb 隧道。
- Android 安装走 runner 本地 adb；iOS 走 `devicectl`/Appium `app` 能力；失败归 environment。

### 8.3 配置优先级（L7）

- Web LLM：host 级 gateway 元数据优先；项目 `deviceHosts` 只服务 MCP，不参与 Web LLM 路由。
- 同一 host 多项目共享设备：由中心租约隔离；gateway 不感知项目。

### 8.4 证据访问与 OTP（L6）

- 未脱敏原始截图/日志：仅 admin/maintainer 可读，审计下载；LLM/verifier 不可读。
- OTP/短信验证码类用例：标注 `not-automatable`，不进入 LLM 执行（静态 secret 对真流程无意义）。

## 9. 分阶段

| 阶段 | 范围 | 验收 |
|---|---|---|
| **P0 远程 Android** | 设备网关（runner adb server + SSH -R）+ Center LLM Worker + ARTEMIS hooks + L1 + 入口脱敏/注入 + token/artifacts + Excel | 远程 Android 真机/模拟器跑通；无 key 下发；secret grep 0；PASS 有 L1；重试 token 计入；预算有界 |
| **P0b 远程 iOS** | Appium/WDA 网关；安装/隧道/取消/超时 | 远程 iOS 跑通；端点漂移/重连语义 |
| **P1 加固** | 独立 verifier、reference pack UI、多实例/HA、WSS、Appium-Android 替代路线 | 并发/失联/账期；面板人工复核 |

## 10. 测试策略

- Center LLM Worker：fake ARTEMIS 子进程、fake gateway；不连真实 LLM/设备。
- 脱敏/注入：文本/UI 树/截图/命令日志；H1–H4 hook 失败 fail-closed；secret grep 0。
- 判定：L1 通过 + verifier 反对 → UNVERIFIED；L1 失败 + verifier pass → FAIL；无 L1/L2 → UNVERIFIED；散文无锚点不产 L1。
- UNVERIFIED：center-only ingest 接受、HTTP runner 拒绝；Excel 写 UNVERIFIED；聚合 partial。
- 计费：首跑/重试/verifier 全计入；sourceEventId 含 attempt/requestId；token 缺失阻断出账。
- 路由：maestro runner 不领 LLM；LLM worker 不领 maestro；取消/超时/失联/端口漂移。
- 预算：20 例×15min 不被 2h 截断；per-case 步数/token 超限。
- 真实设备仅手动 `scripts/e2e-device.mjs`。

## 11. 剩余开放问题（部署细节）

1. Gateway 控制面 `/gateway/install` 走现有 runner 心跳通道还是新增 HTTP 端点？P0 建议新增 loopback/隧道内端点。
2. Android adb server 中继在 runner 多设备/高并发下的稳定性；是否需要 P1 切 Appium-Android（新执行器，不是 ARTEMIS 现成能力）。
3. Reference pack 的 materials `reference` 类型 UI/权限；P1 是否自动从 `ui-contract` 生成。
4. 严格脱敏 allowlist 的维护角色与审计保留期。
5. 未脱敏证据的保留期/加密存储；是否复用现有 artifacts 保留策略。
6. P1 verifier 模型选择（同模型不同 prompt vs 独立模型）与成本上限。

## 12. 结论

R10 采用 **中心 LLM 执行 + 远程设备网关 + SSH 反向隧道**；runner 只做设备/隧道/安装/租约。脱敏与注入的强制点在 **ARTEMIS hook + 中心入口**，不在 Worker 外层假装完成；UNVERIFIED 由**中心 LLM Worker 直连 ingest** 产生，不污染 runner 上报枚举；L1 在原始证据上做硬判定，L2 补参照物，L3 只能降级；所有尝试 token 计入计费。P0 远程 Android → P0b iOS → P1 加固。
