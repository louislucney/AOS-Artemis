# Web LLM 执行接线设计（R10）v2

> 2026-11-04 · 状态：**设计 v2（已按产品决策修订；待 review，不实现）**
> 关联：`DESIGN.md` §13.302（数据源 P0）、§13.304（APK/IPA appId）、§13.305（CSV 导入）、`src/web/results.ts`（结果/计费契约）、`src/artemis/`（ARTEMIS 子进程）、`docs/superpowers/specs/2026-10-28-web-project-test-platform-design.md` §4.7/§4.8。
> v1 评审问题与决策见 §2；本版按决策改写架构，不再采用“P0 仅中心本机”的路线。

## 1. 目标

`executionMode=llm` 现在只是占位：`createWebJob` 允许创建，runner 执行入口直接返回 `llm-execution-not-wired`（`src/runner/web-executors.ts:465`）。R10 要让手工 Excel/CSV 的 `taskDesc` 直接交给 LLM 执行器，不依赖 Maestro flow，并且：

1. **必须支持远程执行机**（不是只支持中心本机）；
2. LLM key 只在中心，远程 runner 不持有；
3. Excel/taskDesc 可以发给 LLM，但账号/密码/token 等敏感内容必须自动移除；执行时需要真实凭据时用占位符注入；
4. 结果、证据、token 成本、Excel 写回与 Maestro 模式同口径；
5. **不能伪造 PASS**：LLM 模式也要有可核验的逐例证据与失败分类。

## 2. 决策记录（2026-11-04）

| # | 决策 | 对设计的影响 |
|---|---|---|
| 1 | **必须远程** | 删除“P0 中心本机”方案；P0 即远程 Android 设备网关，P0b 远程 iOS。 |
| 2 | LLM key 只在中心 | runner 不接收 key；LLM/ARTEMIS 在中心执行。 |
| 3 | 可发给 LLM，但账号等内容自动移除 | 新增 `Redactor` + 占位符/密钥注入层；文本、UI 树、截图均需脱敏。 |
| 4 | 证据“目前够但缺参照物” | 新增确定性后置检查 + 可选 reference pack + 独立 verifier；无确定性证据不判 PASS。 |
| 5 | 接受 SSH 隧道/内网直连 | runner 作为设备网关；P0 用 SSH 反向隧道/内网，不公网暴露 adb。 |
| 6 | 重试 token 计算在内 | `tokenUsage` 增加 attempt/phase；`tokenTotals` 汇总所有尝试；报表拆分成功/重试成本。 |
| 7 | runner 只做设备宿主；问是否有更好方式 | 保留“设备网关”模型，并改为**反向隧道**：runner 主动连中心，中心不主动连 runner。 |

## 3. 总体架构

```
┌──────────────────────────── 中心 ────────────────────────────┐
│  HTTP/面板/任务队列（PG/文件台账）                            │
│  Center LLM Worker（新）                                      │
│    ├─ claim executionMode=llm 的任务（CAS）                   │
│    ├─ ARTEMIS 子进程（Python/venv，中心已有）                 │
│    ├─ Redactor/SecretInjector                                 │
│    ├─ Deterministic checks + Verifier                         │
│    └─ ingestWebJobResult → Excel/审计/计费                    │
│  Device Gateway Registry（host → adb/Appium endpoint）        │
└───────────────▲───────────────────────────────┬───────────────┘
                │ 反向隧道（SSH/WSS，可选 mTLS） │ 结果/租约/心跳
┌───────────────┴───────────────────────────────▼───────────────┐
│ 远程 runner（设备网关模式）                                    │
│   - 注册 host/devices/gateway endpoints                        │
│   - 维持到中心的反向隧道（adb / Appium 端口转发）              │
│   - 只做设备/租约/健康检查；不执行 LLM、不持 key               │
│   - Maestro 任务仍由现有 web-runner 执行                       │
└───────────────────────────────────────────────────────────────┘
```

### 3.1 为什么是“中心执行 + 设备网关”

| 备选 | 为什么不做 |
|---|---|
| runner 内置 ARTEMIS | key 要么下发 runner（违反决策 2），要么中心代理；bundle 要带 Python/venv/依赖升级，Windows/macOS 矩阵变重 |
| 中心 agent + runner 动作 RPC | 每步 observe/act 网络往返，延迟与失败面大；要新写一套安全动作协议和 Android/iOS 原语；首版成本高于收益 |
| 纯中心本机 | 违反决策 1（必须远程） |
| **中心执行 + 设备网关（选定）** | key 不出中心；复用 ARTEMIS trace/checker/artifacts；runner 只做设备/隧道/租约；SSH 反向隧道避免公网暴露 adb/Appium |

- runner 只做它擅长的事：设备、网络、租约、健康检查；
- 中心不主动连 runner；runner 主动建反向隧道，天然适配 NAT/内网；
- 后续若隧道不可用，再评估 WSS 多路复用或 runner 内置 ARTEMIS。

### 3.2 设备网关（runner 新角色）

- runner 启动时注册：host、devices、`android.adbHost`、`ios.appiumUrl`、隧道状态、版本。
- **反向隧道**：runner 主动连中心（SSH `-R` 或 WSS 多路复用），中心侧得到 loopback 端口；runner 不需要公网入站。P0 用 SSH 反向隧道（已接受），WSS 作为后续可选。
- 中心只接受已注册、心跳在线、隧道健康的 host；端点不可达时任务 pending 并显示原因，不猜测。
- `deviceHosts` 现有的项目级 adb/Appium 配置继续用于 MCP；Web LLM 使用 host 级 gateway 元数据，避免把项目配置复制到中心。
- 安全：隧道只转发 adb/Appium，不转发任意端口；中心侧仅 loopback 绑定；可选 mTLS/SSH 密钥；审计记录 gateway 连接/断开。

### 3.3 任务路由与租约

- `executionMode=maestro`：现有 `web-runner` 领取、执行、回写，不变。
- `executionMode=llm`：**Center LLM Worker** 领取；`web-runner` 不领取。
- `claimWebJob`/新 `claimWebLlmJob` 必须按 `executionMode` 过滤；两端都做硬过滤，不能靠“runner 看到 llm 就报错”。
- 创建任务时仍由中心 `acquireDeviceLeases` 预占设备；LLM worker 领取后持有租约，定期续租；完成/失败/取消释放。
- 多中心实例：PG CAS 领取；文件台账仅单中心（多实例需 PG/控制面）。失联任务按现有 stale claim 回收；LLM worker 崩溃时已有 trace 保留。
- 取消：中心 worker 收到 stopping → 终止 ARTEMIS 子进程，保留已完成用例，未完成写 `SKIP（未执行）`。
- 超时：`AOS_WEB_LLM_CASE_TIMEOUT_MS`（默认 15min/例）、`AOS_WEB_LLM_JOB_TIMEOUT_MS`（默认 2h/任务，0 关闭）；总上限沿用 `AOS_TASK_MAX_RUNTIME_MS`。

## 4. 敏感内容移除与注入

目标：**发给 LLM 的内容不包含账号/密码/token/邮箱/手机号等**；执行时仍能登录。

### 4.1 Secret inventory

- 来源：`materials` 的 secret 文件（`secret:true`）、项目 `.env` 的 `AOS_WEB_SECRET_*`、用户在面板绑定的 secret 别名。
- 每个 secret：`alias`、`value`、`kind`（account/password/token/otp/other）、`scope`（项目/用例）。
- 只在中心内存/0600 文件读取；不写日志、不进 LLM 上下文、不进 CAS 明文。

### 4.2 发 LLM 前

1. **精确值脱敏**：按 secret 值长度降序替换为 `<secret:alias>`；覆盖 taskDesc、步骤、预期、testData、UI 树文本。
2. **模式脱敏**：邮箱、手机号、身份证/银行卡、Bearer/JWT、密码字段（`password|passwd|pwd|验证码|otp` 邻近值）替换为 `<redacted:kind>`。
3. **未绑定账号**：脱敏后若仍出现 account-like 文本且无法绑定 secret → 该用例拒绝 LLM 执行（`llm-secret-unbound`），不把原文发给 LLM；面板提示绑定 materials secret。
4. **严格模式**：`AOS_WEB_LLM_REDACT_STRICT=1`（默认 1）；宁可 block，不泄漏。
5. **审计**：只记脱敏次数/类型，不记值。

### 4.3 执行时注入

- LLM 输出动作中只允许引用 `<secret:alias>`（`valueRef`），不允许直接读 env/文件。
- 注入器只在 `input`/`typeText` 等动作执行瞬间替换真实值；替换后的命令不进 trace/日志。
- 截图/UI 树在发给 LLM（下一轮观察或 verifier）前脱敏：已知 secret 值遮罩；account-like 未绑定文本在严格模式下遮罩或 block。
- 原始证据（未脱敏截图）只落中心受控结果目录，供人工排查；不发给 LLM、不进审计摘要。

## 5. 证据与判定（回答“缺参照物”）

### 5.1 证据分层

| 层 | 内容 | 作用 |
|---|---|---|
| L1 确定性检查 | 期望文本可见/不可见、正则、UI 树 selector、无错误弹窗、无崩溃 | 硬证据；不依赖模型判断 |
| L2 参照物 | 设计稿/`ui-contract`/用户上传 reference 截图，按区域/文本比对 | 解决“没有参照物”；可选 |
| L3 独立 verifier | 另一个 LLM（可用同模型不同 prompt）读脱敏 trace + 截图，输出 PASS/FAIL/UNVERIFIED + 引用步骤 | 只能**降级**，不能把 L1/L2 失败改 PASS |
| L4 人工 | 面板人工标记未实现/阻塞/通过（现有） | 兜底 |

### 5.2 PASS 规则

- **PASS 必须同时满足**：
  1. 至少 1 条 L1 确定性检查通过；
  2. 没有 L1 失败/错误弹窗/崩溃；
  3. L3 verifier 不反对（反对 → UNVERIFIED/FAIL）；
  4. 有截图/步骤证据和 traceId。
- 只有 L3 通过、没有 L1/L2 → **UNVERIFIED**，不判 PASS。
- 只有 L2 参照图、没有文本期望 → L2 通过可 PASS；参照图缺失 → UNVERIFIED。
- 失败分类沿用现有 failure domains；LLM 自述失败不能覆盖 L1 通过，但可触发重试/人工。

### 5.3 Reference pack（可选，解决无参照物）

- 用例可绑定：期望文本（Excel 预期列自动解析）、reference 截图（materials 或设计资产）、可选数据断言。
- 没有 reference pack 时，仍可从“预期结果”提取文本断言；纯视觉/无数值预期的用例默认 UNVERIFIED，提示补充 reference。
- 参考图比对沿用 `design_device_diff`/`ui-contract` 的区域与阈值，不新造一套像素算法。

## 6. 结果、token 与计费

### 6.1 结果契约

- 复用 `WebJobResultDocument`：`execution.cases[]`、`device`、`package`、`evidence`、`tokenUsage`、`tokenTotals`、`tokenArtifacts`。
- LLM 模式额外字段（additive）：
  - `execution.cases[].traceId`、`evidenceSteps[]`（步骤/观察/截图/检查结果）；
  - `execution.cases[].verification`：`{deterministic: {passed, failed, skipped}, reference: "passed"|"missing"|"failed", verifier: "pass"|"fail"|"unverified"}`；
  - `tokenUsage[].attempt`（1-based）、`phase`（`execute`/`verify`/`retry`）、`requestId`。
- `tokenArtifacts` 必须含 `dataEngineDb`/`statusJson`；缺失写 `token-unavailable`，**不写 0**。
- Excel 写回：复用 8 列摘要/平台结果列；未执行写 `SKIP（未执行）`；证据列写 traceId + 截图，不写 Maestro flow。

### 6.2 计费

- 所有尝试（首跑 + 失败重试 + verifier）的 token 都计入 `tokenUsage` 与 `tokenTotals`；报表按 `attempt/phase` 拆分“成功成本/重试成本/验证成本”。
- 缓存 token 按厂商语义拆分 `cacheCreateTokens`/`cacheReadTokens`；不合并。
- 失败任务也计费；不因未通过而清零。
- 账期/项目/任务/用例四级汇总沿用现有成本表；`token-unavailable` 单独计数并阻断该任务出账（不当作 0）。

## 7. 兼容与迁移

- `executionMode=llm` 不再返回 `llm-execution-not-wired`；P0 只对“有 gateway、隧道在线、工具满足”的 host 开放，其余明确 `llm-gateway-unavailable`。
- Maestro 路径完全不变；`web-runner` 只增加 `executionMode` 过滤，不改变执行逻辑。
- 结果 schema 的新字段全部可选；旧结果文档仍可解析。
- 设备租约/任务表不新增列；gateway 元数据放 host 注册（或新表，见开放问题）。
- 面板：执行方式选择 LLM 时显示“由中心执行，runner 只做设备网关”；gateway 离线时禁用。

## 8. 分阶段

| 阶段 | 范围 | 验收 |
|---|---|---|
| **P0 远程 Android** | 设备网关（SSH 反向隧道）+ Center LLM Worker + ARTEMIS + 脱敏/注入 + L1 确定性检查 + token/artifacts + Excel 写回 | 远程 Android 真机/模拟器跑通一条 Excel 用例；无 key 下发；无账号明文进 LLM/日志；PASS 有 L1 证据；重试 token 计入 |
| **P0b 远程 iOS** | Appium/WDA 网关；iOS 模拟器/真机 | 远程 iOS 跑通；隧道断开/恢复、取消/超时 |
| **P1 加固** | 多中心 worker、gateway HA、reference pack UI、verifier 独立模型、WSS 隧道 | 并发/失联/账期报表；面板人工复核流程 |

## 9. 测试策略

- Center LLM Worker：fake ARTEMIS 子进程、fake 设备网关；不连真实 LLM/设备。
- 脱敏：taskDesc/UI 树/截图中的 secret 与 account 模式；严格模式 block；注入只在动作执行瞬间。
- 判定：L1 通过 + verifier 反对 → UNVERIFIED；L1 失败 + verifier 说 pass → FAIL；无 L1/L2 → UNVERIFIED。
- 计费：首跑/重试/verifier token 全计入；缺失 artifacts → `token-unavailable`。
- 租约/领取：maestro runner 不领 LLM；LLM worker 不领 maestro；取消/超时/失联回收。
- 真实设备仅手动 `scripts/e2e-device.mjs`。

## 10. 剩余开放问题（部署/产品细节）

1. Gateway 隧道 P0 用 SSH 反向隧道是否足够？还是首版就要 WSS（跨平台/无 SSH 客户端）？
2. Gateway 元数据放 host 注册字段，还是新表 `host_gateways`？多项目共享一台 host 时是否需要项目级隔离？
3. Reference pack 的入口：复用 materials（新增 `reference` 类型）还是设计资产/`ui-contract` 自动生成？
4. 严格脱敏的误杀允许项目级 allowlist 吗？谁维护？
5. Center LLM Worker 部署形态：独立 CLI `web llm-worker` 还是 HTTP 服务内嵌循环？
6. iOS 远程 Appium 是否需要中心侧 mTLS/令牌？现有 iOS 配置只有 URL。
7. 人工复核（L4）是否允许把 UNVERIFIED 改成 PASS？需要什么权限/审计？

## 11. 结论

R10 采用 **中心 LLM 执行 + 远程设备网关 + 反向隧道**：key 与模型只在中心，runner 只做设备宿主；账号等内容在进 LLM 前脱敏、执行时占位符注入；PASS 由确定性检查 + 可选参照物 + 独立 verifier 共同约束，缺少参照物时宁可 UNVERIFIED；所有尝试 token 计入计费。按 P0 远程 Android → P0b 远程 iOS → P1 加固推进。
