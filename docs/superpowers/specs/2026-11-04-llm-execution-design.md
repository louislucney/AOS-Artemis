# Web LLM 执行接线设计（R10）

> 2026-11-04 · 状态：**待评估（未实现）**
> 关联：`DESIGN.md` §13.302（数据源 P0）、§13.304（APK/IPA appId）、§13.305（CSV 导入）、`src/web/results.ts`（结果/计费契约）、`src/artemis/`（ARTEMIS 子进程）、`docs/superpowers/specs/2026-10-28-web-project-test-platform-design.md` §4.7/§4.8。

## 1. 问题

`executionMode=llm` 现在只是接口占位：`createWebJob` 允许创建，runner 执行入口直接返回 `llm-execution-not-wired`（`src/runner/web-executors.ts:465`）。用户仍然必须先把自然语言用例生成 Maestro 脚本，才能跑网页测试。

R10 要解决的是：

1. 手工 Excel/CSV 的 `taskDesc` 直接交给 LLM 执行器，不依赖 Maestro flow；
2. 远程执行机也能跑（或明确限制）；
3. 结果、证据、token 成本、Excel 写回与 Maestro 模式同口径；
4. **不能伪造 PASS**：LLM 模式也要有可核验的逐例证据与失败分类。

## 2. 现状与约束

### 2.1 已有能力

- **中心 LLM/ARTEMIS 路径**：`mobile_run_task` 经 ARTEMIS 子进程执行自然语言任务，产出 trace、`status.json`、`data_engine.db`、截图等；适用于本机/`deviceHosts` 声明的远程设备。
- **Web 结果契约**：`src/web/results.ts` 已定义 `tokenUsage`、`tokenTotals`、`tokenArtifacts{dataEngineDb,statusJson}`；`stageTokenArtifacts` 已能落盘并做 sha 校验。
- **Web 任务/租约/队列**：`regression_tasks.job_spec`、`device_leases`、`claimWebJob`、面板、Excel 写回、失败分域、审计均已存在。
- **执行机 bundle**：当前只带 Node/adb/JDK/Maestro（`scripts/bundle-runner.mjs`），不带 Python/ARTEMIS venv。

### 2.2 硬约束

- LLM key 只在中心/项目 `.env`，**不能下发到远程执行机**。
- 远程任务必须回传 `data_engine.db`/`status.json`，否则 token 计费只能落 `token-unavailable`，财务闭环断裂（前一轮平台评审 K1）。
- PASS 需要硬证据：Maestro 模式是 flow 通过 + assertionCount；LLM 模式必须定义等价证据（见 §6）。
- iOS 真机仍走 Appium+WDA；Android 走 adb/ARTEMIS。执行器不能假装跨端等价。
- 测试不依赖真实 LLM/设备/外网；用 fake ARTEMIS/假子进程。

## 3. 方案比较

| 方案 | 做法 | 优点 | 代价/风险 |
|---|---|---|---|
| **A. 中心执行 + 远程设备宿主** | 中心 LLM/ARTEMIS 进程通过 `deviceHosts` 的 `ADB_SERVER_SOCKET`/Appium 操作远程设备；runner 只做设备宿主/租约 | key 不出中心；复用 ARTEMIS；不用给 runner 装 Python | 需要远程 adb/Appium 暴露与网络策略；runner 的领取/租约模型要区分“执行在中心” |
| **B. runner 内置 ARTEMIS** | runner bundle 加 Python + artemis venv；LLM key 经中心代理或 runner 本地配置 | 执行靠近设备；结果/trace 本地生成 | bundle 体积/OS 矩阵；key 下发或代理；Python 依赖升级；运维复杂 |
| **C. 中心 agent + runner 动作 RPC** | runner 暴露受限的 observe/act 协议；中心 agent 决策 | key 中心；不装 Python；可控 | 每步网络往返延迟；新安全协议；runner 要重写观察/动作原语；工作量大 |
| **D. 仅中心本机设备** | `executionMode=llm` 只允许中心本机/直连设备，远程 host 明确拒绝 | 最小闭环，复用现有 ARTEMIS，验证结果/计费 | 不解决远程执行机；只是 P0 验证切片 |

**建议：D → A 分阶段，B/C 作为 A 不可行时的备选。**

- P0 先做中心本机/直连设备，打通“用例 → taskDesc → ARTEMIS → 结果/证据/token → Excel 写回”，验证契约与计费；远程 host 明确返回 `llm-requires-local-device`，不伪装成功。
- P1 用 `deviceHosts` 把 Android adb/iOS Appium 指到远程设备宿主；中心执行、runner 只提供设备与租约。这样 key 不出中心，也不需要 runner 装 ARTEMIS。
- 若 P1 的网络/安全策略不可接受，再评估 B（runner 内置）或 C（动作 RPC）。

## 4. 端到端流程（P0/P1 共用）

```
web job (executionMode=llm)
  → 中心 LLM 执行器领取（不是 web-runner 的 Maestro 执行器）
  → 读取 Excel/CSV 的 case 范围 → taskDesc（已有生成/导入逻辑）
  → 逐例调用 ARTEMIS mobile_run_task（Android adb / iOS Appium）
  → 轮询 status.json；收集 trace、截图、notes、data_engine.db
  → 适配为 WebJobResultDocument：
       execution.cases[]（PASS/FAIL/SKIP/ERROR + evidence）
       tokenUsage[] / tokenTotals
       tokenArtifacts{dataEngineDb,statusJson}
  → 复用 ingestWebJobResult：门禁、Excel 写回、审计、失败分域
```

### 4.1 任务归属

- `job_spec.executionMode=llm` 的任务由**中心 LLM worker**领取；`web-runner` 继续只领取 `maestro`。
- P0：仅当 `targetHostId` 是中心本机/`deviceHosts` 直连设备时允许；`assignment=auto` 不得选到无法直连的远程 host。
- P1：允许 `targetHostId` 指向已声明 `deviceHosts` 的 host；中心用该 host 的 adb/Appium 端点执行；runner 只上报设备与续租，不执行 LLM。
- 任务/租约仍走 `regression_tasks`/`device_leases`，避免和 Maestro 任务抢设备。

### 4.2 取消/超时/重试

- 取消：中心 LLM worker 收到 stopping → 终止 ARTEMIS 子进程（协作式中止），保留已完成用例的部分结果；未完成写 `SKIP（未执行）`。
- 超时：`AOS_WEB_LLM_TASK_TIMEOUT_MS`（默认 30min，0 关闭）逐例；总任务上限沿用 `AOS_TASK_MAX_RUNTIME_MS`。
- 重试：仅对 `unstable-assignment`/设备失联重试；同一用例的 LLM 失败不自动重跑（成本不可控），由用户显式 rerun。
- 失联：租约过期回收，任务回 pending；中心 worker 崩溃时已有 trace 保留。

## 5. 结果契约

### 5.1 逐例状态

| 场景 | status | 证据 |
|---|---|---|
| ARTEMIS checker 通过 + 至少 1 个预期断言命中 + 截图/步骤日志 | `PASS` | `evidence[]`、traceId、assertionCount 等价字段 |
| checker 失败/异常 | `FAIL` | failureStep/failureReason/截图 |
| 未执行（取消/超时/范围外） | `SKIP` | `failureReason:"未执行"` |
| 执行了但无硬证据/无法判定 | `UNVERIFIED` | 不得记 PASS；任务 `partial` |
| 设备/环境错误 | `ERROR` | 失败域 `environment`/`device` |

- LLM 模式不要求 Maestro YAML，但要求“可核验的预期命中 + 证据”；具体判定由 ARTEMIS checker/notes 适配器给出，不能只看模型自述。
- 现有 `manualSteps`/`UNVERIFIED` 降级逻辑复用。

### 5.2 token 与计费

- `tokenUsage[]` 从 ARTEMIS trace / LLM 网关日志提取：`caseId, traceId, model, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, cost`。
- `tokenTotals` 由中心汇总；缺失则显式 `token-unavailable`，**不写 0 冒充免费**。
- `tokenArtifacts` 必须上传 `data_engine.db`/`status.json`；sha256 校验；落 `.artemis/web/results/<jobId>/artifacts/`。
- 计费按项目/任务/账期汇总，沿用现有成本表；不把失败重试的 token 合并进成功用例。

### 5.3 Excel 写回

- 复用 `ingestWebJobResult` 的 8 列摘要与平台结果列；未执行写 `SKIP（未执行）`。
- LLM 模式的证据列写 traceId + 截图路径；不写 Maestro flow 路径。

## 6. 安全与隐私

- LLM key 只在中心/项目 `.env`；远程 runner 不接收 key。
- taskDesc/Excel 内容会发给 LLM 厂商：项目级开关 `AOS_WEB_LLM_ALLOW_DATA_EGRESS=1`（默认 0？需产品决定）；关闭时拒绝 `executionMode=llm`。
- 日志/审计不落 key；只落模型名、token 计数、traceId。
- `deviceHosts` 的 adb/Appium 端点按现有安全约束（SSH 隧道优先、`adb -a` 风险提示）；不新增公网暴露。
- 结果上传沿用 runner job token/中心鉴权；不把项目 rootPath 返回给 runner。

## 7. 分阶段

| 阶段 | 范围 | 验收 |
|---|---|---|
| **P0（中心本机）** | 中心 LLM worker + ARTEMIS；`executionMode=llm` 仅本机/直连设备；结果适配/计费/写回；远程 host 明确拒绝 | 一条真实 Excel 用例在中心设备跑通；tokenUsage/tokenArtifacts 落库；Excel PASS/FAIL/SKIP 正确 |
| **P1（远程设备宿主）** | `deviceHosts` 远程 adb/Appium；中心执行、runner 只做设备/租约；面板显示“LLM 由中心执行” | 远程 Android/iOS 模拟器跑通；runner 不拿 key；取消/超时/失联可回收 |
| **P2（备选）** | runner 内置 ARTEMIS 或动作 RPC | 仅在 P1 网络策略不可行时启动 |

## 8. 测试策略

- `web-executors`/新 `web-llm-executor`：fake ARTEMIS 子进程（不连设备），断言任务/结果/取消/超时。
- 结果适配：PASS/FAIL/SKIP/UNVERIFIED、token 缺失、artifacts sha 不匹配。
- 计费：tokenUsage 汇总、cache token、缺失显式 `token-unavailable`。
- 面板：`executionMode=llm` 选择、host 限制提示、任务详情证据。
- 端到端：fake 设备 + fake LLM；真实设备仅手动 `scripts/e2e-device.mjs`。

## 9. 开放问题（需产品/运维确认）

1. **P0 是否接受“仅中心本机/直连设备”**？如果必须首版就支持远程 runner，A 方案的成本/网络改造是否可接受？
2. **LLM key 是否可以留在中心**（推荐），还是 runner 需要独立 key？
3. **数据出境**：是否允许 Excel/taskDesc 发给第三方 LLM？默认关闭还是按项目开关？
4. **PASS 证据口径**：ARTEMIS checker + 截图/notes 是否足够，还是要求额外的断言脚本？
5. **远程 adb/Appium 暴露**：是否接受 SSH 隧道/内网直连，还是必须走 runner 本地执行（B 方案）？
6. **计费粒度**：按任务/用例/账期，失败重试是否单独计费？缓存 token 是否按厂商语义拆分？
7. **P1 的 runner 角色**：是否允许 runner 只做设备宿主（不上报 LLM 结果），还是保持现有领取/回写模型？

## 10. 结论

R10 不是“把 `llm-execution-not-wired` 换成一次函数调用”，而是新增一个**中心 LLM 执行面**：执行位置、key 边界、远程设备接入、结果证据、token 计费、Excel 写回都要一起定义。建议先做 P0 中心本机切片，验证契约后再用 `deviceHosts` 扩到远程；不要在首版给 runner 下发 LLM key，也不要把“模型说通过”当 PASS。
