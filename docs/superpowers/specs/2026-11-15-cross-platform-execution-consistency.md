# Android / iOS 测试过程一致性设计

> 2026-11-15 · 状态：**v0.2 · review 反馈已吸收，待确认后进入 Phase 0（只写方案，不改代码）**  
> 关联：`docs/reports/ios-regression-2026-11-13.md`（周五 iOS 追溯）、`DESIGN.md` §5.3/§5.4、`src/figma/case-runner.ts`、`src/ios/run-loop.ts`、`src/artemis/failure-taxonomy.ts`

## 0. 一句话目标

让同一份 `tests.json` / Excel 用例在 Android 和 iOS 上执行时，**数据、预算、复位、证据、失败口径可比较**；不要求两端结果相同，但要求“同条件比较”。

## 1. 决策摘要（v0.2）

| # | 决策 | v0.2 结论 |
|---|---|---|
| D1 | 是否引入统一 `ExecutionPlan` | **采用**。任务执行前生成，覆盖数据/预算/复位/证据要求，而不是各执行器各自读环境 |
| D2 | 测试数据如何分配 | **按需启用**。当前测试可能跳过注册/OTP 环节，v1 不把 Data Broker 作为门禁；保留本地 lease core，等真实号码池/后端条件具备再启用 |
| D3 | 步数/Token 预算如何跨端 | 统一 `maxWallMs` + 引擎相关 `maxSteps/maxActions`；Token 增加 `maxTokens` / `maxPromptTokens` / `compressionThreshold`，采用**调用前预估 + 压缩**，不把 `maxTokensPerStep` 当唯一硬限 |
| D4 | 复位语义 | `fresh` / `app-internal-reset` / `reuse` / `none`；iOS 真机不支持时标 `unsupported`，可显式降级但要披露，不假装已复位 |
| D5 | 证据契约 | 统一 `run.json` + 失败步骤截图/AX；不支持截图的引擎在上传结果里显式降级 |
| D6 | 跨端一致性门禁 | 第一版 **report-only**；只有 `comparable=true` 且两端结果不一致时才允许阻断发布，`not-comparable` 不阻断 |
| D7 | 落地方式 | Phase 0 两个 Spike → 证据 → 数据 → 预算 → 复位 → 预检 → parity 门禁 |
| D8 | host-state 预检 | 新增存储空间/后台残留/系统弹窗检查；存储不足阻断，低电量/系统更新按策略告警或阻断 |
| D9 | 跨端 UI 差异 | 新增 `ui-divergence` 原因码，但必须有截图/AX 证据才成立，否则 `inconclusive` |

需要在 review 中确认的点见 §16。

## 2. 背景

周五 iOS 的结果暴露了三类跨端问题：

1. **数据隔离**：注册成功用例使用了 `testwithgu+202@gmail.com` 和固定手机号；后续用例直接进入登录/阻塞。
2. **步数预算**：iOS LLM 默认 30 步，长注册流程报“超出步数上限”；Android 没有同一个限制。
3. **证据不足**：远端主要只有 `status.json`，没有逐步骤 `run.json`、截图、AX；取消后 trace 还可能停在 `running`。

周五同一套用例在 Android 上也存在同类风险，只是表现不同。具体分析见：

- [`ios-regression-2026-11-13.md`](../../reports/ios-regression-2026-11-13.md)
- `DESIGN.md` §5.3（runner/多主机）、§5.4（面板/证据）

## 2.1 Review 反馈核验（v0.2）

本轮反馈总体成立，但不是全部都能原样作为 v1 前置条件。已按下面的口径吸收：

| 反馈 | 结论 | 处理 |
|---|---|---|
| iOS 真机普通 reset 无法清 Keychain；`fresh` 不能靠 `fullReset` 稳定完成 | **成立** | 增加 `app-internal-reset`；`fullReset` 作为最后手段，TestFlight 场景默认不依赖它 |
| `maxTokens` 硬限制会导致 Agent 半途熔断 | **成立，且实际更严重** | 增加调用前预估、`maxPromptTokens`、预算感知压缩、熔断后复位；`maxTokensPerStep` 仅作可选上限 |
| OTP 池需要冷却期/号段风险 | **方向成立** | 增加可配置 `cooldownMs` / `riskLevel` / provider；不写死 24h，不默认做 IP 绑定 |
| `device_ip_binding` 必须 | **部分成立** | 作为可选策略；NAT/共享出口 IP 下可能引入新误判，优先按号码/账号做 pacing |
| 跨端 UI 差异会造成 `case-target-missing` | **成立** | 增加 `ui-divergence` 原因码，但必须有截图/AX 证据，否则 `inconclusive` |
| Preflight 应检查 host-state | **成立** | 增加存储空间、后台残留、系统弹窗；按阻断/告警分级 |
| v1 parity 只能 report-only | **成立** | D6 明确第一版只报告；仅 `comparable=true` 且结果不一致时考虑发布阻断 |
| 中心 Data Broker 是唯一方案 | **条件成立** | 跨 runner 建议中心化；单 runner 可确定性生成，外部测试数据服务也是选项 |

不采纳的表述：

- “必须先有一个固定 24h 冷却期”：冷却时间应由后端策略/号段供应商决定。
- “必须用 `maxTokensPerStep` 解决”：单步硬限仍可能让合法长上下文直接失败；核心是调用前预估与压缩。
- “iOS fresh 必须禁止用例”：应按 App 是否提供内建复位、是否可降级 reuse 来分级，不是一律禁止。

## 3. 当前实现对照

| 维度 | iOS | Android | 结论 |
|---|---|---|---|
| 执行引擎 | LLM：`src/ios/run-loop.ts`；native：structured runner | proxy：ARTEMIS `mobile_run_task`；native：structured runner | 一个用例可能走不同引擎，不能直接用同一个通过率比较 |
| 数据分配 | `case-runner` 跑 case 前统一分配 `caseSecrets` | 同一入口，同样分配 | 邮箱自动递增已跨端；手机号/OTP/卡号仍未隔离 |
| 序号状态 | 执行机本地 `.artemis/secret-sequences.json` | 同一 runner 共用；不同 runner 各自从起始号开始 | 跨 runner 不保证唯一 |
| 步数限制 | `AOS_IOS_MAX_STEPS`，默认 30 | proxy 不受该变量约束；native 执行固定 `actions[]` | 没有统一预算语义 |
| Token 预算 | `AOS_WEB_LLM_MAX_TOKENS_PER_CASE` **无默认值**；有值时在 LLM 调用后检查；历史固定保留最近 8 步 + 旧步骤 digest | proxy 不适用 | 当前没有必须的 token 预算；有预算时也不是调用前预估，长上下文仍可能一次耗尽 |
| 复位 | 当前 `resetIosApp` 实际只做 terminate + launch，不清 App 数据/Keychain | adb 可卸载/清数据；但没有统一 fresh/reuse 策略 | iOS fresh 不能靠现有 reset 保证；Android 也没有统一策略 |
| 证据 | 常见只有 status；native 有 `native-ios.json` | proxy 有 status/stderr/stdout；native 有 `native-android.json` | schema 不同，无法同口径分析 |
| 失败分类 | 共享 `classifyFailure` | 共享 `classifyFailure` | 输入信号不同，分类可能不同 |
| 预检 | `iosDriverPreflight` 在任务领取后执行 | adb/设备/安装检查同样在领取路径 | 环境问题仍会消耗任务和设备 |

## 4. 目标与非目标

### 4.1 目标

1. 任务在开始执行前明确知道：用哪台设备、什么引擎、什么数据、什么预算、什么复位方式、要交什么证据。
2. 同一用例跨端执行时，数据身份和前置条件要么相同，要么被明确标记为不同。
3. 预算耗尽、数据缺失、复位失败、环境失败有独立错误码，不冒充产品行为失败。
4. 失败后能回答“是应用问题、用例问题、数据问题、环境问题，还是两端条件不同”。
5. 不要求 Android/iOS 通过率相同；要求 `executionParity` 能说明是否可比。

### 4.2 非目标

- 不重写 ARTEMIS Python agent。
- 不要求 iOS 和 Android 使用完全相同的设备原语或步骤实现。
- 不改变测试用例的人类层生成规则（`semanticId`、taskDesc、预期等）。
- 不在一期实现真正的跨设备同帧对比或视觉一致性。
- 不把产品缺陷判断自动化；只提供可归因的证据。

### 4.3 反目标

- 用“Android 能跑通”代替 iOS 证据。
- 把 `maxSteps` 设成 200 作为默认值，掩盖流程/用例问题。
- 让数据复用靠“这次应该没注册过”的人工假设。
- 在 iOS 真机不支持 fresh reset 时假装已清数据。
- 用 `unclassified` 把预算/取消/环境问题混进产品失败。

## 5. 总体设计

```
Suite task
  └─ Suite plan（每个 case × platform × device 一条 ExecutionPlan）
       ├─ DataBroker: 申请数据 lease（email/phone/otp/card）
       ├─ ResetPolicy: fresh | reuse | none
       ├─ Budget: maxWallMs + engine-specific
       ├─ Adapter:
       │    ├─ android-proxy  (ARTEMIS)
       │    ├─ android-native (structured)
       │    ├─ ios-llm        (Node run-loop)
       │    └─ ios-native     (structured)
       └─ EvidenceWriter: run.json + screenshots + AX/log
            └─ ExecutionParity: comparable? reasons
```

关键原则：

- **控制面负责条件，执行器负责执行**。预算/数据/复位/证据要求由控制面决定，执行器只做映射。
- **条件不满足时先标记，不要先跑**。
- **结果不同可以接受，条件不同必须显式**。

## 6. ExecutionPlan

### 6.1 生成时机

在 `suite run --task` 解析设备/用例引用之后、提交 `mobile_run_task` 之前生成；每个 `(caseId, platform, deviceSerial, attempt)` 一条。

### 6.2 建议 schema

```jsonc
{
  "schemaVersion": 1,
  "planId": "uuid",
  "suiteRunId": "uuid",
  "taskId": "uuid",
  "caseId": "imp-...",
  "platform": "ios",
  "deviceSerial": "00008101-...",
  "engine": "ios-llm",
  "identity": {
    "policy": "per-platform",        // shared | per-case | per-platform | unique-per-run
    "namespace": "run-20261113T...:ios",
    "leaseId": "lease-uuid"
  },
  "data": {
    "keys": ["reg_email", "reg_phone", "reg_code", "reg_card"],
    "profile": "registration-success"
  },
  "reset": {
    "mode": "app-internal-reset",   // fresh | app-internal-reset | reuse | none
    "requireFresh": true,
    "capability": "debug-menu|deep-link|full-reset|unsupported",
    "supported": true
  },
  "budget": {
    "maxWallMs": 900000,
    "maxSteps": 60,
    "maxActions": null,
    "maxTokens": 200000,
    "maxPromptTokens": 40000,
    "compressionThreshold": 0.75
  },
  "evidence": {
    "required": ["run.json", "final.png", "last_steps"],
    "redactSecrets": true
  },
  "preflight": {
    "required": ["device", "app-version", "engine", "data", "reset"]
  }
}
```

### 6.3 当前实现（v0.3 起步）

`ExecutionPlan` 的**安全视图**已进入 `execution-evidence.json`：

- platform / engine
- reset.mode（当前能确定 `app-internal-reset` 或 `reuse`）
- data.policy=`per-platform` + aliases
- budget=null（按要求不启软/硬 Token 预算）
- evidence.steps / screenshots

完整 plan 生成、派发前门禁、raw secret 绑定仍未接入。

### 6.4 兼容性

- 老任务没有 plan 时，由 adapter 生成“旧模式” plan，字段为 null/默认，并在报告中标 `legacy:true`。
- `plan` 只记录条件，不把 secret 明文写入中心台账；数据值通过 lease 接口或任务材料解析。

## 7. 数据隔离（按需，当前可跳过）

> **2026-11-16 范围调整**：当前测试可能跳过注册/OTP 环节，因此 Data Broker/OTP 冷却不进入 v1 必做门禁；本地 `DataLeaseRegistry` 保留为可选能力，不阻塞任务/parity。

### 7.1 问题不是“邮箱 +1”

周五的 `+202` 只解决了邮箱形式；注册链路还需要手机号、OTP、卡号。

建议数据资源拆为：

| 资源 | 示例 | 分配策略 |
|---|---|---|
| 邮箱 | `base+NNN@domain` | 可确定性递增 |
| 手机号 | 测试号段/一次性号码 | 中心池租约，用完释放 |
| OTP | 固定测试码/短信查询 | 后端测试接口或固定码；按环境声明 |
| 卡号 | Smiles 卡号 | 预置池，不可重复注册 |
| 登录账号 | 已注册账号 | 固定 fixture，不做注册 |

### 7.2 三种可选方案（v0.2 取舍）

#### 方案 A：中心 Data Broker（建议）

- 中心新增 lease registry：`suiteRunId + caseId + platform + resource` 原子预留。
- runner 通过 runner token 领取 lease，lease 有过期/释放/consumed。
- 优点：跨 runner 唯一；可审计；可做清理。
- 缺点：控制面复杂度、离线 runner 需要降级。

#### 方案 B：确定性本地生成

- 由 `runId + caseId + platform` hash 生成邮箱/手机号后缀。
- 优点：无中心依赖、实现快。
- 缺点：手机号/OTP 不是任意后缀都有效；跨环境仍可能重复；删除/清理不可控。

#### 方案 C：外部测试数据服务

- 已有测试数据平台/API 提供账号、手机号、OTP。
- 优点：最贴近真实链路；缺点：依赖外部可用性和接入成本。

**建议**：当测试包含注册/OTP 时，邮箱用 A/B 均可；手机号/OTP/卡号用 A（中心池）或 C；跨 runner 场景中心化或使用外部服务。当前测试若跳过注册/OTP，则只保留固定登录 fixture，不启用 Data Broker 门禁。

### 7.3 冷却期、号段风险与请求节奏

Data Broker 不能只做“领取-使用-释放”，至少记录：

```jsonc
lease: {
  resource: "phone",
  valueRef: "lease-uuid",
  provider: "sms-pool-a",
  riskLevel: "low|medium|high",
  lastUsedAt: "ISO",
  cooldownMs: 3600000,        // 由 provider/后端策略配置，不写死
  deviceIpBinding: false      // 可选，不默认开启
}
```

建议：

- 释放后进入可配置冷却期；冷却结束才可再次分配。
- 同一后端/同一号段有独立速率限制（如 1/min、10/day），由 Data Broker 做 pacing。
- `riskLevel` 来自供应商/号段元数据；高风险号码不用于金融/实名类用例。
- `deviceIpBinding` 只作为可选策略；NAT/共享出口 IP 下默认关闭，避免把测试环境自身变成风控信号。
- 连续失败要能区分 `data-conflict`、`otp-rate-limited`、`otp-provider-unavailable`，不要统一叫“环境问题”。
- 当前已提供本地 `DataLeaseRegistry`（`src/figma/data-lease.ts`），并在显式配置 `AOS_DATA_LEASE_FILE` 时由 case-runner 租用/释放 email/phone/otp/card；默认关闭，中心跨 runner 原子分配和真实供应商接入仍未实现。

### 7.4 Identity policy

| 用例类型 | 建议 |
|---|---|
| 登录成功 | `shared` 固定已注册账号 |
| 注册成功 | `per-platform` 每端独立邮箱/手机号/卡号 |
| 注册失败 / Reject TNC | `unique-per-run`，不能复用成功注册的数据 |
| 跨端同用例 | 默认 `per-platform`；需要证明同一账号行为时显式 `shared` |

必须避免：

```text
Android 注册成功账号
→ iOS Reject TNC 复用同一账号
→ Android 的数据污染 iOS
```

## 8. 预算语义

### 8.1 当前事实（v0.2 修正）

- iOS 的 `AOS_WEB_LLM_MAX_TOKENS_PER_CASE` **没有默认值**；项目未设置时，单个 case 可以消耗到百万级 prompt token。
- 有 token 预算时，检查点在 LLM 调用**之后**，无法阻止本次请求超支；已发生 token 仍计费。
- 已有固定历史压缩：保留最近 8 步，旧步骤压成 digest（`AOS_IOS_HISTORY_STEPS` 可调），但**不是 token 感知**，也不和剩余预算联动。
- 周五实际 trace 的 prompt/completion 比例约为 47x–338x，单 case 出现 4,014,161 prompt / 11,877 completion；这不是理论风险。
- Android proxy 没有 `AOS_IOS_MAX_STEPS` 对应字段；Android native 的天然上限是 `actions.length`。

### 8.2 统一字段

```jsonc
budget: {
  maxWallMs: 900000,              // 两端都执行
  maxSteps: 60,                   // iOS LLM；Android proxy 可能为 null
  maxActions: null,               // Android native 的 actions.length 上限
  maxTokens: 200000,              // 单 case 总预算
  maxPromptTokens: 40000,         // 单次调用 prompt 预估上限
  maxTokensPerStep: null,         // 可选，不作为唯一机制
  compressionThreshold: 0.75      // 剩余预算低于 75% 时触发压缩
}
```

### 8.3 Token 预算不是“到点再失败”

建议执行顺序：

1. 调用前估算本次 prompt（系统提示 + 工具 + 历史 + 当前屏幕/截图）。
2. 预估会超过 `maxPromptTokens` 或剩余总预算 → 先压缩历史/裁剪截图/禁用视觉，再重试预估。
3. 仍超过 → 返回 `budget-exceeded`，记录 `budgetUsed`，并进入复位/恢复。
4. 调用后按实际 usage 结算；如果本次已经超支，记录 `overrun`，不静默吞掉。
5. 预算熔断后必须执行 `reset`（至少 terminate/launch；可 fresh 时 fresh），避免“半注册/半登录”状态。

`maxTokensPerStep` 只能作为可选的单步硬上限；它不能替代调用前预估，否则只是把“总预算突然死”变成“单步突然死”。

### 8.4 引擎映射

| 字段 | iOS LLM | Android proxy | Android native |
|---|---|---|---|
| `maxWallMs` | 任务轮询/用例超时 | 用例超时 | 用例超时 |
| `maxSteps` | `AOS_IOS_MAX_STEPS` | 无法精确映射；记录 `maxStepsEffective=null` | `actions.length` 是天然上限 |
| `maxActions` | 不适用 | 不适用 | 显式 action 数 |
| `maxTokens` | `AOS_WEB_LLM_MAX_TOKENS_PER_CASE` | 不适用/由 Artemis 内部预算 | 不适用 |
| `maxPromptTokens` | 调用前预估 | 不适用 | 不适用 |
| `compressionThreshold` | `AOS_IOS_HISTORY_STEPS` + 预算感知压缩 | 不适用 | 不适用 |

### 8.5 状态

统一写：

```jsonc
budgetUsed: {
  wallMs: 123456,
  steps: 42,             // null 表示该引擎未统计
  actions: null,
  tokens: 12345,
  promptTokens: 1000000,
  completionTokens: 4691,
  cacheReadTokens: 945408,
  exhausted: "tokens",   // null | steps | actions | tokens | wall
  maxStepsEffective: null // Android proxy 专用，显式表示不可精确统计
}
```

- 预算耗尽统一错误码 `budget-exceeded`，失败域 `case-defect`（用例/预算设计问题），不是 `behavior-or-design`。
- 预算熔断后必须留下 reset/recovery 结果；不能只写一个错误码就结束。

## 9. 复位策略

### 9.1 现状与限制

- 当前 `resetIosApp` 只做 `terminate + launch`，**不清 App 数据、不清 Keychain**。
- iOS 卸载重装不等于 `pm clear`；Keychain 在卸载后仍可能保留（项目 `docs/iOS-适配方案.md` 已记录）。
- `fullReset` 对 TestFlight 真机需要重新走 TestFlight 下载/安装，自动化和耗时都不稳定，不能作为默认 `fresh` 实现。
- Android `adb` 有 `pm clear`/卸载重装能力，但当前没有统一策略，也没有验证复位结果。

### 9.2 四态 + 能力声明

| 模式 | 含义 | Android | iOS |
|---|---|---|---|
| `fresh` | 清 App 数据/重装后再跑 | adb uninstall 或 pm clear + 重装 | 模拟器 uninstall/erase；真机 `fullReset` 仅作最后手段 |
| `app-internal-reset` | 由 App 自己的测试入口清理状态 | Debug Menu / Deep Link / 测试 API | 同左；必须由 App 提供 |
| `reuse` | 保留登录态，仅重启 | force-stop + start | terminate + launch |
| `none` | 依赖外部状态，不复位 | 无 | 无 |

`app-internal-reset` 的能力必须在 plan 中声明：

```jsonc
reset: {
  mode: "app-internal-reset",
  capability: "debug-menu|deep-link|test-api",
  entry: "testapp://debug/reset",
  supported: true
}
```

如果 App 不提供该能力：

- 要求 fresh 的用例：`supported=false`，标 `not-comparable` 或按项目策略跳过；
- 可降级 reuse 的用例：显式 `degraded=true`，报告中披露，不假装已清数据；
- 不能直接假设 `fullReset` 一定可用。
- 当前实现已支持 `AOS_IOS_RESET_URL` 与 `AOS_ANDROID_RESET_URL`（launch → 内建复位入口 → wait → launch）；这是 `app-internal-reset` 的第一版适配器，完整 plan/capability 字段仍待接入。

### 9.3 不支持时要显式

- iOS 真机无法清 TestFlight App 数据时：
  - `reset.supported=false`
  - 用例标 `not-comparable`（如果它要求 fresh）
  - 允许项目选择 `reuse + degraded`，但必须披露。
- Android `fresh` 必须验证安装包版本/包名，避免误清其他应用。
- 复位失败优先归 `environment`/`case-defect`，不进入产品断言失败。

### 9.4 输出

`run.json.reset` 记录：

```jsonc
{
  "mode": "app-internal-reset",
  "capability": "debug-menu",
  "ok": true,
  "degraded": false,
  "detail": "cleared app data via debug menu"
}
```

失败时：

```jsonc
{ "mode": "fresh", "ok": false, "reason": "ios-real-device-fresh-unsupported", "degraded": false }
```

## 10. 证据契约

### 10.1 统一 run.json

建议最小 schema：

```jsonc
{
  "schemaVersion": 1,
  "traceId": "ios-...",
  "platform": "ios",
  "engine": "ios-llm",
  "device": "00008101-...",
  "caseId": "imp-...",
  "planId": "...",
  "startedAt": "ISO",
  "finishedAt": "ISO",
  "reset": { "mode": "reuse", "ok": true },
  "budget": { "limit": {}, "used": {}, "exhausted": null },
  "dataLease": { "namespace": "...", "leaseId": "...", "keys": [] },
  "steps": [
    {
      "index": 1,
      "action": "tap",
      "target": "Login or Register",
      "observed": "Login / Register",
      "expected": null,
      "status": "passed",
      "screenshot": "steps/001.png",
      "at": "ISO"
    }
  ],
  "final": {
    "status": "passed",
    "errorCode": null,
    "failureDomain": null
  }
}
```

### 10.2 必传 artifacts

- `run.json`
- 最终截图
- 失败步骤截图（最多 N 张，例如最近 5 步）
- 失败步骤 AX/UI hierarchy（若引擎支持）
- 设备/引擎日志（Android logcat、iOS device log；不可用时标 `degraded`）

### 10.3 上传与脱敏

- 复用 runner 结果上传通道，新增 `run.json`/截图类 artifact。
- `taskDesc`、输入值、secret 必须脱敏；当前 `status.json` 已有 redaction，`run.json` 必须同规则。
- 大小限制：单文件 + 总包上限；超限截断并标 `evidence-truncated`。
- 远端证据目录继续保持 `remote-evidence/<taskId>/<traceId>/`。

### 10.4 现有缺口

`uploadFailureEvidence` 当前上传 `status/stderr/stdout/native-*/execution-evidence.json` 、最近最多 3 张 `evidence-shot-*`（默认开、可关、≤200KB）与 `evidence-ax.json`（最近 ≤8 步 AX 文本摘要、secret 脱敏、默认开、可关）；`execution-evidence.json` 已包含安全步骤摘要（native 来自 structured runner，proxy 来自 `run.json` 的 index/action/status）。完整 `run.json`、截图和 AX 仍未统一。

## 11. Preflight 与 executionParity

### 11.1 PreflightReport

统一返回：

```jsonc
{
  "platform": "ios",
  "hostId": "local-mac",
  "checkedAt": "ISO",
  "checks": [
    { "code": "device", "ok": true },
    { "code": "app-version", "ok": true, "detail": "2.0.0 (2)" },
    { "code": "appium-xcuitest", "ok": false, "detail": "driver missing" },
    { "code": "signing", "ok": true },
    { "code": "host-storage", "ok": true, "detail": "free 24%" },
    { "code": "host-background", "ok": true, "detail": "target app terminated" },
    { "code": "data", "ok": true },
    { "code": "reset", "ok": false, "detail": "fresh unsupported" }
  ],
  "blocking": ["appium-xcuitest"]
}
```

- 远程 host 的就绪信息由 runner 心跳上报，中心缓存 `checkedAt`。
- 面板「去下发」/`suite task create` 在 `blocking` 非空时阻止；允许显式 override（带审计）以便诊断。
- 旧 runner 没有该字段时标 `unknown`，不假装 ready。
- `host-state` 至少检查：
  - 存储空间低于阈值（默认 10%，可配）→ 阻断；
  - 目标 App 后台/前台残留 → 先 terminate，失败才阻断；
  - 系统更新/权限弹窗未处理 → 阻断并给 `host-alert`；
  - 低电量 → 默认告警，不直接阻断（除非用例声明必须满电/充电）。
- “系统更新/低电量弹窗”只能检测/关闭/报告，不能承诺阻止系统事件。
- 面板派发时已按目标主机心跳磁盘做 `host-state` 门禁（`AOS_PANEL_MIN_FREE_DISK_PCT`，默认 10%）。
- 当前实现已接入宿主磁盘检查（`AOS_RUNNER_MIN_FREE_DISK_PCT`）、Android `/data` 与 iOS 真机数据卷检查（`AOS_RUNNER_MIN_FREE_DEVICE_PCT`，默认 10%；iOS 走 `ideviceinfo`）、Android `sys.boot_completed`；iOS 可用 `AOS_IOS_RESET_ALERTS`，Android 可用 `AOS_ANDROID_RESET_ALERTS=1` 广播关闭系统弹窗；Android 预检用 `uiautomator dump`（`AOS_RUNNER_SYSTEM_DIALOG_CHECK`/`AOS_RUNNER_SYSTEM_DIALOG_POLICY`）；iOS 预检按 AX `Alert` 类型识别，但需显式 `AOS_RUNNER_IOS_SYSTEM_DIALOG_CHECK=1`（默认关；两端均只读，不自动点击）。后台残留、未知系统弹窗仍待接入。

### 11.2 executionParity

每个 case 生成：

```jsonc
{
  "comparable": false,
  "reasons": [
    "budget-dimension-diff:ios.maxSteps=60,android.maxStepsEffective=null",
    "data-identity-diff",
    "reset-unsupported",
    "ui-divergence"
  ],
  "platforms": {
    "ios": { "executed": true, "status": "failed" },
    "android": { "executed": true, "status": "passed" }
  }
}
```

规则：

- 两端都执行 + 同一 data namespace/policy + 同预算维度 + 同复位模式 + 证据完整 → `comparable=true`。
- 任一条件不同 → `not-comparable`，**不进入产品缺陷统计**。
- 不要求 `ios.status == android.status`；通过率差异仍需人工/统计观察。
- 已提供 `src/figma/execution-plan.ts` 的纯函数 parity 评估，并接入 `suite parity --task <id>`（默认 report-only，显式 `--fail-on-not-comparable` / `--fail-on-diff` 可门禁）与面板任务页；任务报告仍未接入。
- `ui-divergence` 必须由截图/AX 证据支撑：两端失败均为 `case-target-missing`，但截图/AX 显示控件实际存在/可见，才能归为“用例未适配跨端 UI”（`case-defect`）；缺证据时标 `inconclusive`，不能猜。
- 原始控件差异（Picker、Permission Dialog、Navigation Bar 等）应由 adapter 归一化或 target 层适配，不直接判产品缺陷。

## 12. 失败语义

建议显式错误码优先于文本关键词：

| errorCode | 失败域 | 说明 |
|---|---|---|
| `preflight-*` | `environment` | 设备/Appium/WDA/签名未就绪 |
| `host-state` / `host-alert` | `environment` | 存储不足、后台残留、系统弹窗 |
| `data-missing` / `data-conflict` | `data-environment` | 未注册账号/账号已存在 |
| `otp-rate-limited` / `otp-provider-unavailable` | `data-environment` | OTP 池限流/供应商不可用 |
| `budget-exceeded` | `case-defect` | 步数/动作/token/墙钟耗尽 |
| `reset-unsupported` | `case-defect`（或 `environment`） | 要求 fresh 但平台不支持 |
| `engine-error` | `environment` | 引擎/进程异常 |
| `case-target-missing` | `case-defect` | 结构化 target 找不到 |
| `ui-divergence` | `case-defect` | 跨端 UI 差异导致目标丢失（需截图/AX 证据） |
| `app-assert-failed` | `behavior-or-design` | 真实 UI/断言不符 |

`classifyFailure` 只在没有显式 errorCode 时做兜底；屏幕标题里的 Login/Register 不应触发 `data-environment`（已在源码修正）。

## 13. 兼容与迁移

- 老 run/trace 没有 `schemaVersion`/plan：读取时按 legacy 处理，不阻塞历史报告。
- 新字段只增不改；现有 `status.json`、`native-*.json` 保留。
- 面板/报告先展示新字段，旧记录显示 `—`/`legacy`。
- 任务未带 plan 时，runner 生成 legacy plan；`executionParity` 默认 `not-comparable`，避免历史数据假比较。

## 14. 验收标准

一期（不依赖真实设备/PG）：

1. 同一 case 在 fake Android/iOS adapter 上生成两条 plan，数据 lease 不同，plan 字段完整。
2. 预算映射测试：
   - iOS `maxSteps` 映射到 `AOS_IOS_MAX_STEPS`
   - Android proxy 标 `maxStepsEffective=null`
   - Android native `maxActions=actions.length`
3. `run.json` schema 测试：两端 adapter 输出同一顶层字段，缺字段显式 `degraded`。
4. 取消测试：取消后 trace 为 `cancelled`，`finishedAt` 非空，无 `running` 残留。
5. `executionParity`：条件不同 → `comparable=false` 且 reason 可读；条件相同 → true。
6. 失败分类：预算/数据/预检/复位不再落 `behavior-or-design` 或 `unclassified`。
7. 历史任务/旧 trace 仍可读取，不因缺 plan 报错。

二期（真实环境）：

1. 同一注册用例在 Android/iOS 使用不同邮箱/手机号/卡号，互不污染。
2. iOS 真机 `fresh` 不支持时，报告明确 `not-comparable`，不判产品失败；`app-internal-reset` 可用时验证数据/Keychain 已清。
3. 远端证据可在中心打开 `run.json` 和失败截图。
4. 环境未就绪时，任务在创建前被阻止，或至少不消耗领取/设备租约。
5. Token 预算在调用前预估并触发压缩；熔断后执行复位，不留下半注册状态。
6. OTP 池释放后按 `cooldownMs` 冷却，连续请求不触发 429/CAPTCHA。
7. host-state 检查能识别存储不足/系统弹窗；`ui-divergence` 只在证据完整时成立。

## 15. 落地顺序

### Phase 0：两个 Spike（先做，未通过不进入实现）

1. **数据/OTP 风控 Spike**
   - 连续分配/释放 5 个虚拟号，验证后端是否 429/CAPTCHA/风控；
   - 记录每个号码的冷却时间、号段风险、供应商行为；
   - 结论决定 `cooldownMs`、`riskLevel` 和是否需要外部测试数据服务。

2. **Token/中断恢复 Spike**
   - 数据侧已完成：[`ios-token-budget-spike-2026-11-15.md`](../../reports/ios-token-budget-spike-2026-11-15.md)（周五 10 个 trace：prompt/completion 10.6x–338x，单 case 4.01M prompt）；
   - 仍需真实设备：注入预算熔断，验证 App 是否处于“半注册”，现有 reset 能否恢复；
   - 结论决定 `maxTokens`、`maxPromptTokens`、`compressionThreshold` 和 `app-internal-reset` 需求。

### Phase 1：可观测性与数据

1. **证据 schema + run.json/截图/AX 上传**（先让两端可比）
2. **统一预算字段**（`maxWallMs`；Token 软/硬预算按用户要求暂不启用）
3. **ResetPolicy**（`app-internal-reset` / fresh/reuse/none；iOS unsupported 显式）
4. **PreflightReport + host-state + 派发前门禁**
5. **executionParity report-only → `comparable=true` 才允许发布阻断**

Data Broker/OTP 移到可选 backlog：等测试重新包含注册环节、且供应商/后端清理条件具备再启用。

Phase 1 的每一步都可独立回滚；第 1 步不改变执行结果，只改善可观测性，建议先做。

## 16. 需要 review 的开放问题（v0.2 状态）

| # | 问题 | 当前结论 | 仍需确认 |
|---|---|---|---|
| 1 | 数据分配：中心 Data Broker vs 本地/外部 | **当前范围跳过**：测试可能跳过注册/OTP；v1 不启用 Data Broker 门禁，本地 core 保留 | 等测试重新包含注册环节再确认供应商/号码池 |
| 2 | 注册身份策略 | 默认 `per-platform`；登录用 `shared`；需要证明同账号多端行为时显式 `shared` + 顺序锁 | 产品是否要求同账号跨端互踢用例 |
| 3 | Android proxy 预算 | 接受 `maxStepsEffective=null` + `maxWallMs` + token 预算作为统一硬限制 | Artemis 是否有可映射的内部预算字段 |
| 4 | iOS 真机 fresh | 首选 `app-internal-reset`；不支持时 `unsupported`/`degraded`，不假装复位 | App 是否能提供 Debug Menu/Deep Link/测试 API |
| 5 | 证据保留 | `run.json` + 失败截图/AX；保留期另定 | 存储上限、敏感数据策略、是否允许上传中心 |
| 6 | Parity 门禁 | 第一版 **report-only**；只有 `comparable=true` 且两端结果不一致时才考虑发布阻断 | 阻断阈值和发布流程归属 |
| 7 | 任务 API 归属 | 建议任务级 `budget` + 项目默认；面板展示 | 是否暴露到 CLI/面板，或只走 `.env` |

## 17. 参考

- [`ios-regression-2026-11-13.md`](../../reports/ios-regression-2026-11-13.md)：周五 iOS 逐任务追溯与 Android 对照
- `DESIGN.md` §5.3 runner/多主机、§5.4 面板与证据
- `src/figma/case-runner.ts`：统一 case 入口、secret 分配、失败证据上传
- `src/ios/run-loop.ts`：iOS LLM 步数预算
- `src/artemis/failure-taxonomy.ts`：失败域分类
- `src/ios/appium/preflight.ts`：iOS 驱动/签名预检

## 18. 版本修订

### v0.2（2026-11-15，review 反馈吸收）

- 增加 `app-internal-reset` 与四态复位；明确当前 `resetIosApp` 只做 terminate+launch。
- 增加 Token 调用前预估、`maxPromptTokens`、`compressionThreshold`；修正“当前已有 200k 上限”的事实错误。
- Data Broker 增加可配置 `cooldownMs` / `riskLevel` / provider；`deviceIpBinding` 改为可选。
- Preflight 增加 `host-state`；`executionParity` 增加 `ui-divergence`（证据门禁）。
- 失败语义增加 `otp-rate-limited`、`host-state`、`ui-divergence`。
- 增加 Phase 0 数据/OTP 与 Token/中断恢复两个 Spike；随后按测试范围将 Data Broker/OTP 标为按需/可跳过。
- 明确 v1 parity 只报告；只有 `comparable=true` 且结果不一致时才考虑发布阻断。

