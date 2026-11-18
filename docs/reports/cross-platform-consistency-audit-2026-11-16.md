# 跨端执行一致性：实现审计（2026-11-16）

> 状态：**只读审计 + 2026-11-16 补审完成**（补审：合规项升级、同类模式扫描、spec 基线回写）。实现未改动；`docs/reports/ios-regression-2026-11-13.md`、spec 与测试夹具已做工作树脱敏。
>
> 关联：[跨端一致性设计 v0.2](../superpowers/specs/2026-11-15-cross-platform-execution-consistency.md)、`DESIGN.md` §5.3/§5.4、[iOS 回归追溯](ios-regression-2026-11-13.md)

## 1. 审计范围与结论

- 代码范围：`66d2e75..HEAD`，45 个提交（2026-11-15～16），56 个文件，+5212/−99。
- 验证基线：`npm test` **3421 通过 / 0 失败**（含构建）；`npm run lint` **0 error / 2 warning**。
- 结论：
  1. **同机（中心本地执行）链路基本闭环**：plan → 执行 → `execution-evidence.json` → `suite parity` → 面板可走通。
  2. **“中心面板 + 远程 runner”主拓扑有两处断点**：plan 旁车不随 bundle 下发；通过用例的证据不上传。门禁与 parity 在该拓扑下不成立。
  3. 按 spec Phase 1 字面验收，完成度约 **55–60%**；按 11-16 调整后的 v1 范围（预算/Data Broker 不计）约 **70%**。
  4. 方向符合“条件显式、report-only、不伪判产品缺陷”，但**尚未达到“同一份用例跨端执行时数据/预算/复位/证据可比较”的一句话目标**。
  5. **补审更正**：仓库 `louislucney/AOS-Artemis` 为 GitHub **public**，真实 UAT 邮箱/手机号已进入公开提交历史；合规项从 P3 升级为 **P0-3**，工作树已脱敏，历史处置需单独决策（见 §4 P0-3）。

## 2. 判定口径

“闭环”按四段检查：**产生 → 持久化/传输 → 消费/展示/门禁 → 可回归测试**。任一环缺失或只在非主拓扑可达，即记为未闭环；仅“代码存在”不算完成。

## 3. 问题索引

> 状态统一为“未修复”；修复后在本表与对应小节同步更新，并补验收测试。

| ID | 优先级 | 问题 | 状态 |
|---|---|---|---|
| P0-1 | P0 | 跨机 plan 门禁空转；重跑/定时/Web job 绕过 | 已修复（2026-11-16） |
| P0-2 | P0 | 通过用例不上传 evidence，parity 缺一侧 | 已修复（2026-11-16） |
| P0-3 | P0（合规） | 公开仓库含真实 UAT 邮箱/手机号，已进入提交历史 | 已决定 A：接受暴露 + 账号处置（不重写历史） |
| P1-1 | P1 | `suite parity --task` 文本模式忽略 fail 门禁 | 已修复（2026-11-16） |
| P1-2 | P1 | 弹窗无证据假绿；跨机旁车不同步；iOS 心跳缺字段 | 部分修复：无证据不判一致/clear/跨机同步；iOS 心跳为接受限制（§11） |
| P2-1 | P2 | parity 缺预算/引擎维度，原始缺陷仍可判可比 | 已处理：步数预算已纳入；引擎差异有意不比较 |
| P2-2 | P2 | data lease 租到递增前的值；无锁；默认关 | 已修复：递增后值 + 本地锁 + 中心原子租约 |
| P2-3 | P2 | 证据整包 1MB 上限可能静默丢弃 | 已修复：裁剪+日志+审计事件 |
| P2-4 | P2 | 复位四态/能力/degraded 未落地，失败不进 parity | 已修复：项目级+任务级 policy；Android fresh/none；iOS fresh unsupported |
| P2-5 | P2 | `ui-divergence`/报告 parity/plan 截图与引擎标注缺失 | 部分修复：截图/引擎/报告 parity 已修；ui-divergence/per-case plan 决策延后（§11） |
| P2-6 | P2 | spec §14 验收仍含已 descope 的预算/数据 lease，与 §15 冲突 | 已回写基线（v0.3） |
| P3-1 | P3 | `.env.example` 缺新增变量 | 已补（2026-11-16） |
| P3-2 | P3 | 回归报告含真实 UAT 邮箱/手机号 | **升级为 P0-3** |
| P3-3 | P3 | parity 读取逻辑重复；traces 路径硬编码 | 已修复（2026-11-16） |
| P3-4 | P3 | plan/dialog 旁车无保留期 | 已修复（2026-11-16） |
| P3-5 | P3 | 门禁缺集成测试（删除后仍全绿） | 部分修复：新增 plan/材料化/重跑/定时/上传测试；跨机真机冒烟待做 |
| P3-6 | P3 | spec 头部状态曾与实现不符 | 已修复 |
| P3-7 | P3 | 静默异常模式：全仓 101 处 `.catch(() => undefined)`/空 catch；数据链关键处无日志/状态 | 已处理：关键路径日志/审计 + `audit:catches` 基线阻断新增 |
| P3-8 | P3 | 设备 UDID 仍残留在 `test/` 与 `.scratch/`（风险低于账号） | 已修复（合成 UDID，2026-11-16） |

## 4. 未闭环项

### P0-1 跨机 plan 门禁为空转，且多条创建入口绕过

**状态：已修复（2026-11-16，见 §10）。旁车存在时按旁车校验；缺失旁车仅旧任务兼容重建并标 `plan-rebuilt:no-sidecar`，不视为条件校验。**

- **位置**：`src/figma/task-execution-plan.ts`、`src/panel/actions.ts:2124`、`src/suite-command.ts:3446/3919`、`src/runner/control/suite-service.ts:103-205`、`src/suite-command.ts:926-949`
- **现象**：
  - plan 旁车只在中心写；跨机 `getTaskBundle` 只带 task/project/caseSets/documents/flows/assets，**不带 plan**。runner 用本地 root 读取，`readTaskExecutionPlan` 返回 `null`，门禁静默按 legacy 跳过。
  - 即使读到，`validateTaskExecutionPlan` 只校验“平台存在 + host 相同”，而 host 两边取自同一 task，`plan-host-mismatch` 实际不可达；reset/budget/data/evidence 条件不参与校验。
  - **重跑 / 定时回归 / Web job** 建任务时不写 plan：`src/panel/actions.ts:2933`、`src/runner/schedules.ts:75`、`src/web/jobs.ts:239/426`。
  - `suite task create`（CLI）只做 host 平台预检，不检查磁盘/设备就绪/弹窗；与面板门禁不一致。
- **影响**：spec §6.1“提交前生成并门禁”在主拓扑上不生效；跨机任务实际只有面板创建时的一次性检查。
- **建议**：将 plan 纳入 task bundle（或在 runner 侧由 task 重建）；所有创建入口统一走同一 helper；校验 reset/budget/data 条件而非仅平台。

### P0-2 证据只在失败时上传，parity 在最常见场景缺证据

**状态：已修复（2026-11-16，见 §10）**

- **位置**：`src/figma/case-runner.ts:436-478/770/1226`、`src/runner/control/suite-service.ts:287-293`
- **现象**：`execution-evidence.json` 每个用例都会写本地 trace，但 `uploadFailureEvidence` 只在 `!passed` 时调用。跨机执行时通过侧没有任何证据上传到中心。
- **影响**：`suite parity --task` 与面板“执行一致性”读不到通过侧的 plan → “一过一败”永远 `not-comparable`/`plan-missing`；而这是跨端归因最需要的组合。当前只有“两端都失败”或“中心本地执行”时 parity 才可用。
- **建议**：所有终态都上传 `execution-evidence.json`（小文件）；截图/AX 仍只失败时上传；上传端按整包预算裁剪而非整包拒绝。

### P0-3 公开仓库暴露真实 UAT 邮箱/手机号（合规）

**决策（2026-11-17）：A —— 接受公开历史暴露，不重写 git 历史；转为账号停用/轮换与残余风险记录。处置清单见 [P0-3 账号处置清单](p0-3-account-disposal-checklist.md)；重写方案保留为备选但不执行。**

- **原出现位置（工作树已脱敏）**：`docs/reports/ios-regression-2026-11-13.md`、`docs/superpowers/specs/2026-11-15-cross-platform-execution-consistency.md`、`test/secret-sequence.test.js`、`test/data-lease.test.js`、`test/suite-ios.test.js`
- **事实**：
  - `origin` 为 `https://github.com/louislucney/AOS-Artemis.git`；GitHub API 未认证返回 `"private": false`，即**仓库公开**。
  - 真实 UAT 邮箱/手机号已随 `66d2e75`（2026-11-13）、`d00302c`（2026-11-15）、`527729e`（2026-11-16）进入公开历史；工作树中的报告、spec、测试夹具均可检索到。
- **已做（工作树）**：报告/spec/测试夹具中的邮箱、手机号替换为 `<redacted-*>` / `qa+N@example.com` / `1000000`；回归报告与 Token Spike 的设备 UDID 改为 `00008101-…`；报告顶部加脱敏说明。测试值已改为通用占位，不影响断言。
- **处置决定（A）**：
  1. **历史**：不重写，接受公开历史中的旧值；[历史重写方案](p0-3-history-rewrite-plan-2026-11-17.md)保留为备选，未执行。
  2. **账号**：按[账号处置清单](p0-3-account-disposal-checklist.md)停用/轮换 UAT 邮箱、手机号、测试账号；该清单为 owner/App-UAT 团队待办。
  3. **监控**：公开仓库无法撤回已被抓取的内容，按“已泄露”处理；后续夹具禁止真实账号/号码/UDID。
- **注意**：本文不复述具体值；不要把本报告当作“已彻底解决”的证据，P0-3 在历史处置完成前保持打开。

### P1-1 `suite parity --task` 文本模式忽略 fail 门禁

**状态：已修复（2026-11-16，见 §10）**

- **位置**：`src/suite-command.ts:5296-5320`
- **现象**：`failed` 只在 `if (options.json)` 分支参与返回码；文本输出路径最后无条件 `return 0`。
- **影响**：不带 `--json` 时，`--fail-on-not-comparable` / `--fail-on-diff` / `--fail-on-dialog-diff` **全部无效**。现有测试只覆盖 `--json`（`test/suite-command.test.js:2526`）。
- **建议**：文本路径同样返回 `failed ? 1 : 0`；补非 JSON 用例。

### P1-2 弹窗一致性无证据时假绿，且跨机不同步

**状态：部分修复（2026-11-16）：无证据不判一致；检查执行且无弹窗写 `clear` 记录；`--fail-on-dialog-diff` 只在内容/存在性不匹配时失败（`--require-dialog-evidence` 可要求两端有捕获记录）；runner 预检写本地后通过控制面 `POST /tasks/:id/system-dialog` 同步中心；旧无 status 的 dialog 不会被 clear 覆盖；弹窗文件读改写带 `<file>.lock`，两平台并发写不丢记录；同步接口校验平台属于任务目标端。iOS 心跳 `systemDialog` 为接受限制（Android-only，§11）。**

- **位置**：`src/figma/system-dialog-store.ts:69-74`、`src/suite-command.ts:982-1058`、`src/panel/actions.ts:2065`
- **现象**：
  - 弹窗旁车写在执行机本地，不在证据上传白名单、也不在 bundle；中心读取中心 root，跨机时为空。
  - `compareSystemDialogs` 在**两端都没有记录**时返回 `comparable:true`；面板显示“两端弹窗内容一致”，`--fail-on-dialog-diff` 不阻断。
  - runner 心跳的 `systemDialog` 仅 Android 上报；文档中的 iOS 侧不会产生该字段，面板 `host-alert` 实际只对 Android 生效。
- **影响**：“检查未运行”被报告为“两端一致”，属于假绿。
- **建议**：无捕获记录标 `inconclusive`/`not-captured`；弹窗旁车纳入上传或 bundle；明确 iOS 心跳能力或从门禁口径中移除。

### P2-1 parity 维度过窄，原始缺陷仍可报 `comparable=true`

**状态：已处理（2026-11-16）：`budget` 记录 iOS 步数/Android 未知；两端已知且不同报 `budget-mismatch`，未知（Android/legacy）报 `budget-unknown` 受限但保持可比；引擎差异有意不比较（不同引擎是预期条件，不是可比性缺陷）。**

- **位置**：`src/figma/execution-plan.ts:77-118`
- **现象**：只比较 `reset.mode`、常量 `data.policy`、alias 列表、steps 可用性；`budget` 恒为 `null`，`engine` 差异不比较，截图要求不比较。
- **影响**：iOS 默认 30 步 vs Android 不受限（spec §2 的原始缺陷之一）仍会得到 `comparable=true`。预算 descope 可以接受，但“可比”结论会误导发布判断。
- **建议**：在 plan 中恢复 `maxWallMs/maxSteps/maxStepsEffective/maxActions` 的最小记录；无法比较时标 `limited`/`not-comparable`，不能默认相等。

### P2-2 data lease 默认关闭且租到递增前的值

**状态：已修复（2026-11-17）：先递增再租约，租约使用实际执行值；同一 case 内相同值只租一次；`<file>.lock` 跨实例互斥并在锁内重读；活跃租约按 `AOS_DATA_LEASE_TTL_MS`（默认 6h）回收；控制模式下 runner 通过 `POST /data-leases/allocate|release` 使用中心原子租约（中心文件锁），控制模式优先中心。`AOS_DATA_LEASE_LOCK_TIMEOUT_MS` 默认 5000。**

- **位置**：`src/figma/case-runner.ts:796-800`、`:1281-1295`
- **现象**：`executeCase` 用 `context.secrets`（如 `+202`）申请租约，`executeCaseInner` 随后递增为 `+203` 再使用；租约保护了未被使用的值。租约文件无锁，跨设备/进程并发会互相覆盖。
- **影响**：`AOS_DATA_LEASE_FILE` 开启后仍不能防止重复邮箱/手机号；默认关闭时无影响。
- **建议**：先递增再租约，或把 sequenced secrets 传给租约层；写操作加文件锁或使用中心原子分配。

### P2-3 证据包可能整包被拒且静默

**状态：已修复（2026-11-16）：服务端按优先级裁剪并回传 `skipped`；客户端记录日志；上传失败写 `evidence/upload-failed` 审计事件（面板审计页可见）。**

- **位置**：`src/runner/control/suite-service.ts:296-311`、`src/figma/case-runner.ts:472-478`
- **现象**：单文件 ≤256KB，但整包 ≤1MB；失败证据最多 3×200KB 截图 + `evidence-ax` + `ax-final` + native json，容易超过 1MB。超限时中心整包拒绝，客户端 `.catch(() => undefined)` 吞掉。
- **影响**：失败证据静默丢失，中心只看到“没有证据”。
- **建议**：上传端按优先级和总预算裁剪；失败时至少保留 `execution-evidence.json` 与 `ax-final.json`；上传失败写日志/状态。

### P2-4 复位策略与失败语义仍不完整

**状态：已修复（2026-11-18）：项目级 `AOS_RESET_POLICY` + 任务级 `resetPolicy`（CLI `--reset-policy` / 面板 API / 面板表单 / 任务页显示）；Android `fresh` 执行 `pm clear`，`none` 不执行；iOS `fresh` 显式 `ios-unsupported`；`capability/supported/degraded` 进入 plan/outcome/证据，reset 失败/不支持/degraded 进入 parity。**

- **位置**：`src/figma/execution-plan.ts:10-14`、`src/device/reset.ts:19-31`、`src/figma/case-runner.ts:800-813/409-412`
- **现象**：只有 `reuse` / `app-internal-reset`；`fresh/none`、`capability/supported/degraded` 未实现。reset 失败只记录 `ok/reason`，执行继续，不进入 parity reason；未产生 `ios-unsupported`/`fresh` 信号。
- **影响**：spec §9.3“要求 fresh 但不支持时标 not-comparable / degraded”未落地；复位失败可能仍得到 `comparable=true`。
- **建议**：补四态与能力声明；reset 失败按 `environment`/`case-defect` 处理并进入 parity。

### P2-5 其余未落地/标注失真

**状态：部分修复（2026-11-16）：plan 截图默认开启（`AOS_RUNNER_EVIDENCE_SCREENSHOTS=0` 关闭）；`ExecutionEngine` 增加 `ios-llm`，iOS proxy 证据/任务 plan 标注 `ios-llm`；任务报告 JSON + xlsx「跨端一致性」sheet 已接入（用例可比性 + 弹窗）。`ui-divergence`、per-case×device plan 仍待做。**

- `ui-divergence` 在 `src/` 中不存在（D9/§12 要求），grep 为 0。
- 任务报告（xlsx）未接 parity/plan（`src/figma/run-report.ts` 无引用）。
- plan 在任务创建时生成，不是按 `(caseId, platform, device, attempt)` 生成（§6.1）。

### P2-6 spec §14 与 §15 的验收基线冲突

- **位置**：spec §14（一期第 1/2 项仍要求“两条 plan + 数据 lease 不同”“预算映射”）、§15（Data Broker/OTP 移入 backlog、预算暂不启用）、§7.3（2026-11-16 范围调整）
- **现象**：同一份 spec 同时存在“按原验收要预算/lease”和“v1 不做预算/lease”两种口径。初版审计因此给出 55–60% 与 70% 两个数字，但没有把“口径冲突”本身记为缺陷。
- **影响**：后续验收容易出现“到底以哪个为准”的拉扯；完成度无法形成单一基线。
- **已做**：在 spec §14 前新增“2026-11-16 v1 范围基线”，明确 v1 门禁只含 §15 Phase 1 + 审计报告；§14 一期第 1/2 项与二期第 5/6 项标为 backlog；§18 增加 v0.3 修订记录。
- **状态**：已回写，待 owner 确认基线表述。

### P3 工程债与合规

- **P3-7 静默异常模式**：已新增 `npm run audit:catches` + `scripts/silent-catch-baseline.json`（v2：按文件计数 + 内容哈希）；新增或同类替换超基线即 exit 1，存量按基线保留（272 处，含 `.catch(() => null)`）。关键路径已单独加信号：
  - 证据上传 `src/figma/case-runner.ts:477`
  - plan 旁车写入 `src/panel/actions.ts:2134`
  - 进度上报（`src/suite-command.ts` 多处 `progress.report(...).catch(() => undefined)`）
  - bundle 读取 `src/runner/control/suite-service.ts:137/155`
  建议：关键路径至少 `logWarn` + 在任务行/面板加“证据上传失败/计划写入失败”标记；CI 增加对新增空 catch 的审查规则，而不是一次性全改。
- **P3-8 设备 UDID 残留**：已把 `test/` 与 `.scratch/ios-real-device/` 的真实 UDID 替换为合成常量（`00008101-0000000000000000` / `00008110-0000000000000000`）；两份报告保持占位脱敏。
- **P3-1** `.env.example` 已补跨端执行一致性/证据/预检变量（2026-11-16）。
- **P3-3** 已修复：parity 证据读取合并到 `src/figma/execution-evidence.ts`；任务详情按项目配置解析 traces 目录（读取失败才回退 `.artemis/traces`）。
- **P3-4** 已修复：写 task-plan 时按 `AOS_TASK_SIDECAR_RETENTION_DAYS`（默认 30）/`AOS_TASK_SIDECAR_MAX_FILES`（默认 500）清理 `task-plans` 与 `system-dialogs` 旧 json（0 关闭）。
- **P3-5** 门禁缺集成测试：host-state/host-alert/plan gate/面板派发门禁删除后，现有测试仍会全绿（仅在 `task-execution-plan.test.js` 有纯函数校验）。
- **P3-6** spec 头部状态曾与实现不符；本次已更新。

## 5. 与 spec 验收对照

### §14 一期验收

| # | 验收项 | 状态 |
|---|---|---|
| 1 | 同一 case 生成两条 plan，数据 lease 不同，字段完整 | **未达成**：plan 仅按平台，无 case/device/lease/planId |
| 2 | 预算映射（iOS maxSteps / Android maxStepsEffective=null / native maxActions） | **未实现**：`budget:null`，无 `maxStepsEffective` |
| 3 | 两端 `run.json` 同顶层字段，缺字段显式 `degraded` | **部分**：只有 `execution-evidence.json`，无 `run.json`/`degraded` |
| 4 | 取消后 trace 为 `cancelled`、`finishedAt` 非空 | **已实现** |
| 5 | 条件不同 → `comparable=false` 且原因可读；相同 → true | **部分**：仅覆盖 reset/policy/aliases/steps，预算/引擎维度缺失 |
| 6 | 预算/数据/预检/复位不落 `behavior-or-design`/`unclassified` | **部分**：预算/复位/数据有文本分类；`preflight-*`、`ui-divergence` 未落地 |
| 7 | 历史任务/旧 trace 可读，不因缺 plan 报错 | **已实现** |

> 注：按 2026-11-16 v1 基线，第 1/2 项与二期第 5/6 项已转为 backlog，不计入 v1 完成度；本表保留为事实状态，便于后续启用时对照。

### §15 Phase 1

| 项 | 状态 |
|---|---|
| 证据 schema + run.json/截图/AX 上传 | 部分（失败侧完整；通过侧不上传；无统一 `run.json`） |
| 统一预算字段 | 按决定暂不启用（不计缺陷，但不能据此判 comparable） |
| ResetPolicy | 部分（两态 + 入口；无 fresh/none/capability/degraded） |
| PreflightReport + host-state + 派发前门禁 | 大部分（磁盘/设备/启动/弹窗；无统一 report 类型；后台残留未接） |
| executionParity report-only | 部分（CLI/面板可用；文本门禁失效；跨机缺证据） |

## 6. 修复顺序与验收标准

0. **合规处置（先做，独立于功能修复）**：工作树脱敏已完成；由 owner 决定是否重写公开历史，并与 App/UAT 团队确认账号停用/轮换。
   - 验收：P0-3 有明确结论（已重写并清理缓存 / 接受暴露并完成账号处置），不能以“文件已改”关闭。
1. **plan 可跨机**：bundle 带 plan（或 runner 重建）；重跑/定时/Web job 复用同一创建入口。
   - 验收：跨机任务缺端时在 runner 侧以 `host-state` 阻断；四类入口都能读到 plan。
2. **终态证据**：所有终态上传 `execution-evidence.json`，截图/AX 仅失败时上传；上传端按预算裁剪，失败写日志并在任务行/面板标记。
   - 验收：一过一败的跨机任务，`suite parity --task` 能读取两侧 plan 并给出可比/不可比；证据上传失败可见。
   - **检查点**：第 1、2 步完成后做一次**跨机真机冒烟**（中心 + 远程 runner，iOS/Android 各一条一过一败用例），不要等全部修完再联调；冒烟通过后再进入第 3 步。
3. **parity 语义**：修文本模式返回码；无证据 → `inconclusive`；补预算/引擎最小维度或显式 `limited`。
   - 验收：`suite parity --task --fail-on-not-comparable` 无 `--json` 时 exit 1；无弹窗证据不返回 comparable。
4. **lease 与弹窗**：先递增后租约；弹窗旁车纳入上传/中心；无捕获不判一致。
   - 验收：lease 文件记录的是实际使用的值；中心能看到两端弹窗记录或明确的 `not-captured`。
5. **文档与测试**：补 `.env.example`；确认 spec v0.3 基线表述；为 plan 门禁、跨机 parity、无弹窗证据补集成测试。
   - 验收：删除任一上述门禁时测试转红。

> 风险提示：第 1、2 步会改 bundle、证据上传和创建入口，属于架构级调整，可能“修一个 P0 引出三个 P1”。每步保持独立可回滚，并在检查点做跨机冒烟。

## 7. 不在本次审计范围

- 预算/Token 硬限与 Data Broker/OTP：属于 11-16 已确认的范围调整，不作为缺陷计数；但其“未实现”必须在 parity 结论中显式体现。
- 真实设备、PG、中心/runner 双机联调：本次仅做代码与单机测试审计；Phase 2 场景仍需真机验收。
- 未评审本批之外的既有模块（除非被本次链路直接引用）。
- 公开历史重写与 UAT 账号轮换：属于 P0-3 的处置决策，不在代码审计内；工作树脱敏已完成，历史与原账号状态需 owner/App 团队确认。

## 8. 参考

- [跨端一致性设计 v0.2](../superpowers/specs/2026-11-15-cross-platform-execution-consistency.md)
- [iOS Token 预算 Spike](ios-token-budget-spike-2026-11-15.md)
- `DESIGN.md` §5.3 runner/多主机、§5.4 面板/证据
- 关键实现：`src/figma/execution-plan.ts`、`src/figma/task-execution-plan.ts`、`src/figma/case-runner.ts`、`src/suite-command.ts`、`src/runner/control/suite-service.ts`、`src/panel/actions.ts`

## 9. 审计方法复盘：为什么初版漏掉同类问题

初版审计在功能链路上是完整的，但方法上有四个偏差，导致“同类问题”没有一次扫清：

1. **范围偏差（diff 视角）**：审计范围是 `66d2e75..HEAD` 的功能 diff，不是全仓模式扫描。标准轴已经抓到 `case-runner.ts:477` 的静默吞异常，但我把它当成“一个实例”而不是“一个模式”，没有继续问“全仓还有多少、哪些在数据链上”。补审已做 101 处空 catch 普查，并把关键路径单列（P3-7）。
2. **严重度偏差（功能视角）**：我把真实邮箱/手机号归为“文档卫生”P3，默认它只影响仓库可读性。没有先检查 remote 可见性、是否已推送、是否在历史中；补审确认仓库为 public 后，直接升级为 P0-3。**合规问题的定级不能只看代码影响面，要先看暴露面。**
3. **口径偏差（只读注解）**：我读了 spec 的“当前实现”注解和 §15，接受了“预算/Data Broker 已 descope”，但没有把 §14 的旧验收逐条对照，所以只报告了 55–60% vs 70% 两个数字，没有把“spec 自相矛盾”本身记为缺陷（P2-6）。**完成度有两个数字，本身就是文档缺陷的信号。**
4. **节奏偏差（只排顺序）**：修复顺序在逻辑上正确，但没有设计联调检查点。bundle/上传策略属于架构级改动，确实容易“修一个 P0 引出三个 P1”；补审已把跨机真机冒烟放在第 1、2 步之后（§6 检查点）。

对应的纠正动作已落到文档：P0-3、P2-6、P3-7、P3-8、§6 检查点，以及 spec 的 v1 范围基线（v0.3）。后续审计应默认增加三项：**全仓同类模式普查、暴露面/历史检查、验收口径与实现注解的交叉对照**。

## 10. 修复进展（2026-11-16）

> 剩余未闭环项的最终处置见 §11（接受限制/延后/外部依赖）。

本轮只做不具破坏性的功能修复；P0-3 历史处置仍待 owner 决策。未提交 commit，改动留在工作树供 review。

### P0-3（决策 A：接受暴露 + 账号处置）

- 工作树已脱敏；历史重写方案已备但**不执行**（[dry-run 方案](p0-3-history-rewrite-plan-2026-11-17.md)）。
- 账号/号码/测试账号按[处置清单](p0-3-account-disposal-checklist.md)由 owner/App-UAT 团队停用或轮换；公开历史按“已泄露”记录残余风险。
- 后续夹具禁止真实账号、号码、UDID；仓库侧检查项已写入清单。

### P0-1（已修复）

- `getTaskBundle` 返回 `taskPlan`；`materializeTaskDocuments` 在 runner 本地落盘旁车。
- `suite run --task` 缺失旁车时按任务字段重建并写回（`plan-rebuilt:no-sidecar`），不再静默跳过。
- 创建入口统一写旁车：面板创建/重跑、CLI 创建、定时回归、Web job（两条创建路径）、控制面 `createTask`。Web job 旁车供审计/面板，其执行器不走 suite plan 门禁。
- 旁车存在时按旁车校验（host/平台）；缺失时重建并标 `plan-rebuilt:no-sidecar`，**仅兼容旧任务，不视为条件校验**。
- 测试：`runner-control-suite`（bundle 携带 plan、控制面创建写 plan）、`runner-task-materialize`（落盘）、`suite-command`（重建 warning、旁车不匹配时 exit 2）、`task-execution-plan`（helper）、`panel-console-actions`（创建/重跑）、`web-llm-worker`（Web job）、`fire-schedules`（定时）。

### P0-2（已修复）

- 所有终态上传 `execution-evidence.json`；通过用例只传该文件，失败仍附 status/日志/native/AX/截图。
- 证据按优先级排序（execution-evidence → ax-final → 其他 → 截图）；服务端整包超 1MB 时按预算跳过并返回 `skipped`，不再整包 413/拒绝；suite 控制面请求体上限从 1MB 提到 4MB，保证 handler 能裁剪。
- 上传改为 `await`，避免 `suite run` 结束/`process.exit` 时最后一条证据未送达；上传失败、单文件 >256KB、服务端 `skipped` 均写 `logWarn`。
- 测试：`suite-runner`（通过用例上传、延迟上传时 run 必须等待）、`runner-evidence`（裁剪而非整包拒绝）。

### P1-1（已修复）

- `suite parity --task` 文本模式返回 `failed ? 1 : 0`；测试覆盖非 `--json` 的 `--fail-on-not-comparable`。

### P1-2 / P2-1（部分修复）

- 弹窗：`compareSystemDialogs([])` 返回 `no-dialog-evidence`（不再 comparable）；预检检查执行且无弹窗时写 `status:"clear"` 记录，两端 clear 才判一致；一端 clear 一端 dialog 报 `dialog-presence-mismatch`；旧空内容记录报 `dialog-evidence-ambiguous`；clear 不覆盖同平台已记录的 dialog；`--fail-on-dialog-diff` 只在内容/存在性不匹配时失败；面板无证据显示“不判定一致”。
- 预算：`ExecutionPlanView.budget` 记录 `maxSteps/maxStepsEffective/maxActions`；iOS proxy 取 `AOS_IOS_MAX_STEPS`（默认 30、1–200 截断），Android proxy 显式 `null`；两端已知且不同报 `budget-mismatch`，未知（Android/legacy）报 `budget-unknown` 受限但保持可比；面板执行计划新增“步数预算”列。
- 测试：`system-dialog-store`（无证据/clear/presence）、`execution-plan`（30 步 vs 未知）、`suite-command`（弹窗不一致 exit 1、两端 clear exit 0）。
- 跨机同步：runner 预检写本地后调用控制面 `POST /tasks/:id/system-dialog`；中心落 `system-dialogs/<taskId>.json`；测试覆盖 hybrid client → 中心文件。
- 仍待做：iOS 心跳 `systemDialog`（引擎差异按设计不比较）。

### P2-2（部分修复）

- `executeCase` 先做 secret 递增，再用递增后的值申请租约；测试 `suite-runner` 断言 lease 文件记录 `qa+203` 而非 `qa+202`。
- 本地租约文件已加 `<file>.lock` 跨实例互斥并在锁内重读；控制模式新增中心原子租约（`POST /data-leases/allocate|release`，中心 `DataLeaseRegistry` + 文件锁，租约带 `taskId`，释放校验归属）。
- 同一 case 内相同值只租一次（`reg_email`/`reg_email_confirm` 不互相 `busy`）；活跃租约超过 TTL 可在下次分配时回收。
- 测试：两个实例共享文件不能重复分配；hybrid client 中心分配/占用/释放；case-runner 控制模式优先中心租约（值为递增后的 `+203`，重复值只租一次）；TTL 回收。

### P2-4（已修复）

- `AppResetOutcome` / `ExecutionPlanView.reset` 增加 `mode/capability/supported/degraded`；`execution-evidence.json` 写入同样字段；parity 增加 `reset-failed` / `reset-unsupported` / `reset-degraded`。
- 测试：`execution-plan`（失败/不支持/degraded 不可比）、`reset`/`ios-reset`（reuse vs app-internal 的 mode/capability）。
- 项目级 `AOS_RESET_POLICY` 已接：Android `fresh` = `pm clear` + 拉起；`none` 不执行；`app-internal-reset` 缺 URL 显式失败；iOS `fresh` 显式 `ios-unsupported`。
- 测试：`reset`（fresh/none/缺 URL）、`ios-reset`（fresh unsupported/none）、`execution-plan`（policy 写入 plan）。
- 任务级 `resetPolicy` 已接：CLI `suite task create --reset-policy`、面板 API、面板表单 select、任务页“复位”、任务记录/plan/执行上下文贯通。

### P2-5 / P3-3（部分 / 已修复）

- plan 截图默认开启（`AOS_RUNNER_EVIDENCE_SCREENSHOTS=0` 关闭）；任务 plan 的 iOS 引擎标为 `ios-llm`，Android proxy 仍 `proxy`；iOS proxy 的 execution-evidence 同步标 `ios-llm`。
- parity 证据读取合并到 `src/figma/execution-evidence.ts`；任务详情按项目配置解析 traces 目录，读取失败才回退默认路径。
- 任务报告：`buildTaskRunReport` 计算 `executionParity`/`systemDialogParity`，JSON 返回，xlsx 增加「跨端一致性」sheet（用例行 + 弹窗行）；`suite parity` 与报告共用 `src/figma/execution-parity.ts`。
- 测试：`task-execution-plan`（ios-llm/截图开关）、`execution-plan`（ios-llm 解析 + resetOk）、`run-report`（JSON + sheet/弹窗行）。
- 仍待做：`ui-divergence` 分类、per-case×device plan。

### P3-4（已修复）

- `src/figma/task-sidecar-retention.ts`：按 mtime/数量清理 `.json` 旁车；`writeTaskExecutionPlanForTask` 写完后清理 `task-plans` 与 `system-dialogs`。
- 环境变量：`AOS_TASK_SIDECAR_RETENTION_DAYS`（默认 30，0 关闭）、`AOS_TASK_SIDECAR_MAX_FILES`（默认 500，0 关闭）。
- 测试：`task-execution-plan` 按年龄/数量清理。

### P2-3（已修复）

- 上传失败写 `logWarn` 与 `evidence/upload-failed` 审计事件（refs: taskId/traceId/caseId），面板审计页可见；服务端 `skipped` 仍由客户端记录。
- 测试：`suite-runner`（上传失败写审计）。

### P3-7（已处理）

- 新增 `scripts/audit-silent-catches.mjs` 与 `scripts/silent-catch-baseline.json` v2（存量 272 处，按文件计数 + 内容哈希）；去注释/字符串后匹配，新增或同类替换空 catch/`.catch(() => undefined|null)` 超基线 exit 1；`npm run verify` 已纳入。
- 关键路径已加信号：证据上传失败写审计、系统弹窗同步失败写 `logWarn`。
- 仍保留存量静默 catch（多为清理/降级的有意为之），按基线约束。

### 验证

- `npm test`：**3456 通过 / 0 失败**；`npm run lint`：**0 error / 2 warning**；`npm run audit:catches`：无新增；`npm run test:types` 通过。
- `npm run verify`：**全绿**（含 `bundle:mcp-runner` + `check:runner-bundle`）：win32-x64（`76fcd69…`）、darwin-arm64（`a595e75…`）、win32-x64 offline 均通过契约检查。
- 未做跨机真机冒烟（§6 检查点仍待执行）。

### 仍打开

- P0-3 账号/号码停用或轮换（决策 A；清单已备，App/UAT 团队执行）。
- P1-2 iOS 心跳 `systemDialog`（跨机旁车同步已接；无证据假绿已修）。
- P2-5 `ui-divergence`/per-case×device plan。
- P3 功能项已清；P3-5 跨机真机冒烟仍待做（P0-3 历史处置单独跟踪）。
- P2-3 已通过审计事件暴露上传失败（面板审计页），任务行内嵌标记未做。

## 11. 剩余项决策（2026-11-17）

以下项不再作为“待修复缺陷”挂着；已明确为**接受限制 / 延后 / 外部依赖**，并记录理由与下一步。

| 项 | 决策 | 理由 | 下一步 |
|---|---|---|---|
| P1-2 iOS 心跳 `systemDialog` | **接受限制（Android-only）** | iOS 弹窗读取需要活跃 WDA/idb 会话；30s 心跳创建会话会与任务执行争抢设备，风险高于收益。Android `uiautomator dump` 成本低，保留。 | 面板 `host-alert` 门禁明确 Android-only；如需 iOS 心跳，另做低频/按需探测。 |
| P2-5 `ui-divergence` 分类 | **延后** | 需要跨用例证据（截图/AX 证明控件存在）与产品判断；当前 parity 已能报告 `case-target-missing`，启发式分类容易误判。 | 等真实跨端样本与证据模型，再定 `ui-divergence`/`inconclusive` 规则。 |
| P2-5 per-case×device plan | **延后** | `execution-evidence.json` 已按 case 记录实际 plan；任务级 plan 是派发时快照，再加 per-case×device 文件没有消费者。 | 如未来需要按 case 预算/数据门禁，再扩 plan schema。 |
| P2-4 任务级 reset override | **已实现（2026-11-18）** | 项目级无法覆盖同项目多策略；任务级 `resetPolicy` 已贯通 DB/CLI/API/面板表单/plan/执行上下文。 | 无。 |
| P3-5 跨机真机冒烟 | **外部依赖** | 需要中心 + 远程 runner + iOS/Android 真机与签名环境，CI 无法替代。 | 按 §6 检查点执行：第 1、2 步后做“一过一败”冒烟。 |
| P0-3 公开历史 | **决策 A** | 接受历史暴露，不重写；通过账号轮换降低风险。 | 按[账号处置清单](p0-3-account-disposal-checklist.md)执行，owner 关闭。 |
