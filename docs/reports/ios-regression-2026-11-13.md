# iOS 回归追溯（2026-11-13 星期五）

## 1. 范围与证据

- 项目：`ESSO-GU`
- 平台：iOS 真机 `00008101-000359440C69001E`（iPhone 10,2 / iOS 16.7.16）
- 时间：2026-11-13 16:30–20:07（Asia/Shanghai）
- 执行机：`local-mac`，runner 版本从 `0.3.26` → `0.3.31`
- 测试用例：
  - 旧用例集 `GU Navigation Menu-Test Case`（Landing / Login / Register 等）
  - 新导入用例集 `GU Virtual Card-Reg.xlsx`（Virtual Card 注册 3 条）
- 主要证据：
  - 文件台账 `ESSO-GU/.artemis/ledger/state.json` 的 `regressionTasks` / `suiteRuns`
  - 远端证据 `ESSO-GU/.artemis/remote-evidence/<taskId>/<traceId>/status.json`
  - 审计 `ESSO-GU/.artemis/ledger/audit.jsonl`
  - 用例集 `ESSO-GU/.artemis/design/case-sets/20261113_114111_Register-(Smiles-Virtual-Card).json`
- 限制：远端证据只有最终 `status.json`，没有逐步骤 `run.json`、截图或 AX 层级；项目本地 MCP 日志最后停在 11 月 9 日，因此本文对“执行器是否点中/看错屏幕”的判断只能到“证据不足，需要补日志”的级别。

## 2. 结论摘要

当天 iOS 测试不是一次“跑完后的失败”，而是先被环境阻塞，再进入真实执行：

- 12 个回归任务：
  - 6 个在进入用例前因 iOS/Appium/WDA/签名环境失败
  - 3 个被人工取消
  - 3 个部分完成
- 实际进入 LLM 执行的 5 个任务共产生 12 个 iOS trace：
  - 9 个 `failed`
  - 3 个停留在 `running`（任务已被取消/部分结束，没有终态）
- 可确认通过的用例只有 2 条：
  - `Landing page / Reduce to a single button as "Login or Register"`（某一轮）
  - `Login / Register / the email address field`
- 最需要提高的不是“模型能力”，而是：
  1. **测试前环境门禁**
  2. **注册类用例的数据隔离与清理**
  3. **步数/证据/终态等执行器可观测性**
  4. **用例期望与产品实际文案的校准**

## 3. 时间线

| 本地时间 | 任务/跟踪 | 结果 | 直接原因 |
|---|---|---|---|
| 16:30 | `f30ad5c0` | failed | Appium 无 XCUITest 驱动（`Could not find a driver for automationName 'XCUITest'`） |
| 17:16 | `3976ae2d` | failed | WDA `xcodebuild failed with code 70` |
| 17:38 | `07286b63` | failed | 未配置 `AOS_IOS_XCODE_ORG_ID` |
| 17:43 | `438ce113` | failed | WDA 再次 `xcodebuild failed with code 70` |
| 17:53 | `2d6ee427` | failed | IPA 安装 `ApplicationVerificationFailed`（签名校验失败） |
| 18:51 | `0d66eec3` | failed | 已切到已安装 App，但仍缺 WDA 签名团队 |
| 18:54–18:55 | `594719e7` | cancelled | Landing 通过；Login/Register 的 Forgot email 失败后人工取消 |
| 18:56–19:07 | `f8e2bb9c` | partial | Landing 的 Intro 未复现；Forgot email 失败；Forgot password 停在 running |
| 19:33–19:38 | `b1c98a03` | cancelled | Landing 失败；Forgot email 失败；email 输入框停在 running |
| 19:41–19:54 | `138caf15` | partial | Virtual Card 3 条全部失败：1 条验证失败 + 2 条超过 30 步 |
| 19:55–20:07 | `6428cd94` | partial | 注册成功结果证据不足；Reject TNC 因邮箱已注册 blocked |

前 2 小时 21 分钟基本消耗在环境准备；真正执行只有约 1 小时 13 分钟。

## 4. 逐用例结果

### 4.1 `594719e7`（18:54）

| 用例 | 结果 | 说明 |
|---|---|---|
| Reduce to a single button as "Login or Register" | passed | 唯一明确通过的一条 |
| the ' Forgot your registered email?' button | failed | 点击后仍停在 Login/Register，未出现弹窗；运行记录缺少 `failed_items`，被归为 `unclassified` |

任务最后被人工取消，但 `ios-375ff80d...` 的 status 仍是 `running`。

### 4.2 `f8e2bb9c`（18:56–19:07）

| 用例 | 结果 | 说明 |
|---|---|---|
| Reduce to a single button | failed | App Intro 三屏因持久化引导标记被跳过，执行器自述直接到 Landing 并关闭；无法验证步骤 2–5 |
| Forgot email | failed | 两次尝试均未出现弹窗；被错误归为 `data-environment`（失败文本里出现“登录/数据”关键词） |
| email address field | passed | 明确通过 |
| Forgot password | running | 最后一条停在 `running`，任务 `partial`，`finishedAt=null`，进度停在 26% |

### 4.3 `b1c98a03`（19:33–19:38）

| 用例 | 结果 | 说明 |
|---|---|---|
| Reduce to a single button | failed | 当前页面停在 Register 选卡页；Intro 未出现；Landing 单按钮无法验证 |
| Forgot email | failed | 点击后仍为 Login/Register，无弹窗 |
| email address field | failed | 记录“任务失败但无 failed_items、崩溃或环境证据”，实际是取消时被中断，trace 仍 `running` |

### 4.4 `138caf15`（19:41–19:54）

用例集：`GU Virtual Card-Reg.xlsx`

| 用例 | 结果 | 说明 |
|---|---|---|
| i.Check the 'Register for Mobil Smiles Virtual Card' page | failed | 执行器给出详细检查结果：已注册手机号未触发“已注册”弹窗；6 位数字的提示与期望文案不一致 |
| ii.Successful registration | failed | 超过步数上限 30 |
| iii.Failed registration -- Reject Tnc | failed | 超过步数上限 30 |

### 4.5 `6428cd94`（19:55–20:07）

| 用例 | 结果 | 说明 |
|---|---|---|
| ii.Successful registration | failed | 最终停在 Home：没有 In-App Terms & Conditions、没有 Register_Done、没有 Points Earned；无法证明注册成功 |
| iii.Failed registration -- Reject Tnc | failed | `testwithgu+202@gmail.com` 已在 UAT 后端存在，应用连续 3 次进入 Login 密码页而非注册选卡页，环境数据阻塞 |

## 5. 需要提高的地方

### P0-1 环境门禁必须在派发前，而不是执行中

当天 6 个任务失败于 iOS 环境：

- Appium 未安装 `xcuitest` driver
- WDA `xcodebuild` code 70
- 缺 `AOS_IOS_XCODE_ORG_ID`
- IPA 签名验证失败

这些错误在 `suite run --task` 中有 preflight（`appium-driver-missing` / `ios-signing-missing`），但仍然要等任务被领取后才失败，已经占用任务、设备和时间。

建议：

- 在面板「设备/执行机」和执行机 `/healthz` 增加 iOS 就绪状态：Appium、XCUITest driver、Xcode、签名团队、WDA 最近一次构建、设备信任、已安装 App 版本。
- `suite task create` / 「去下发」在目标机未就绪时直接阻止，或给出明确的“先修环境”入口。
- 同一天同类错误重复 4 次（WDA/签名），应在第一次失败后阻止后续排队。

### P0-2 注册类用例需要真正的数据隔离

失败链路非常明确：

1. 第一轮使用 `testwithgu+202@gmail.com` 和手机号 `6953512` 进入注册。
2. 后续轮次同一个邮箱已被注册，应用直接进入 Login 密码页，`Reject Tnc` 无法复现。
3. 同一个已注册手机号提交后仍进入验证码页，没有出现“已注册”弹窗。

当前代码已在 `0.3.33` 增加 `base+NNN@domain` 自动递增（`src/tasks/secret-sequence.ts`），但：

- 周五实际执行的是 `0.3.26` / `0.3.31`，没有这份修复。
- 只覆盖邮箱；**手机号、短信验证码、Smiles 卡号仍没有按用例分配/清理**。
- 序号状态落在执行机本地 `.artemis/secret-sequences.json`；换执行机/重装会重新从起始号开始。

建议：

- 用 `0.3.33` 重跑并确认 `reg_email` 每用例递增（`+203`、`+204`…）。
- 增加手机号/OTP 的测试数据池或清理接口；没有清理能力时，注册类用例必须使用一次性号码，不能复用 `6953512`。
- 为失败注册/TNC 这类“需要未注册账号”的用例单独准备数据，不要和成功注册用例共用邮箱/手机号。
- 数据序号最好由中心分配或同步，而不是只在执行机本地递增。

### P0-3 先确认三个产品问题，避免把自动化问题当产品缺陷

1. **已注册手机号仍进入 OTP**：`6953512` 已注册，但应用仍允许继续到验证码页，没有 `Mobile number has already been registered.` 弹窗。
2. **Forgot email 弹窗不出现**：两轮/iOS 真机多次点击后页面完全不变。
3. **注册成功缺少关键证据**：最终在 Home，但没有 T&C、Register_Done、Points Earned。

建议先手工在同一台真机、同一版本 `2.0.0 (2)` 上复现并截屏；确认是产品问题还是执行器没有点中。不要直接按 `failureDomain` 建单。

### P1-1 步数上限 30 对注册用例不够

两条 Virtual Card 用例（Successful registration、Reject Tnc）都直接报：

```text
超出步数上限（30），任务未完成
```

10 步主流程 + 选卡/OTP/个人信息/键盘/重试/验证，30 步很容易耗尽；执行器还有 3 次 attempt，更容易提前用尽。

建议：

- 长流程用例在任务/套件级别显式设置 `AOS_IOS_MAX_STEPS=60`（最高 200），不要只依赖默认 30。
- 面板在“派发”处展示当前步数上限，并允许按任务覆盖。
- 把 `budget-exceeded` 和 `behavior-or-design` 分开统计；当前步数超限被归为行为/设计差异，会污染产品缺陷数据。
- 状态里记录已用步数、剩余步数、最后一次动作，方便判断是“流程长”还是“原地打转”。

### P1-2 App Intro/引导页需要可控的干净状态

Landing 用例要求验证 App Intro 三屏，但执行器报告“引导标记已持久化”，直接进入 Landing；即使重新启动也不会出现 Intro。

建议：

- 为需要首次安装状态的用例提供 `freshInstall` / `clearAppData` 复位模式（卸载重装或清理 UserDefaults/keychain；注意保留已安装的 TestFlight 版本）。
- 或者在用例前置条件中明确“仅首次安装执行”，不要每次回归都跑。
- 当前 `appInstallMode=installed` 只跳过 IPA 安装，不等于清理 App 数据。

### P1-3 失败证据不足，且终态不一致

现状：

- 远端证据只有 `status.json`；没有逐步骤 `run.json`、截图、AX 层级、动作目标。
- `Forgot email` 失败只有一句“页面未出现弹窗”，无法判断是按钮不可点、点错坐标、还是产品行为。
- 3 个 trace 在任务取消/部分结束后仍为 `running`；`f8e2bb9c` 任务 `partial` 且 `finishedAt=null`，进度停在 acting。
- 失败域分类是文本关键词启发式：Landing 的 Intro 失败被归为 `data-environment`；`Forgot email` 的取消被归为 `unclassified`。

建议：

- 取消/部分结束时把未完成 trace 写成 `cancelled`/`orphaned`，并补 `finishedAt`。
- 每个失败用例至少保留：最后 3 步截图、当步 AX 树、实际 tap 坐标、目标元素文本、模型动作 JSON。
- 把远程证据 `run.json` / 截图上传中心，或者设置 `AOS_RUNNER_ADVERTISE_URL` 让中心能打开执行机产物。
- 失败分类优先使用显式错误码（`budget-exceeded`、`cancelled`、`appium-driver-missing`），文本关键词只做兜底。

### P1-4 用例期望文案要与产品实际一致

Virtual Card 检查中发现：

```text
期望：输入 6 位数字后提示 "Please input smiles card number"
实际：提示 "Invalid format"
```

这更像**用例期望写错/设计稿与实现不一致**，不是执行器失败。建议：

- 用例的错误提示断言以产品当前文案 + 设计稿/接口文档双确认，不靠生成时猜测。
- 对“格式错误”和“缺少卡号”分开断言，避免一个输入同时期望两种错误。
- 失败输出里保留实际文案（这次做到了），方便快速校准。

### P2 其他改进

- 登录用例需要已注册测试账号（`uat.tester@smilesguam.com` 返回未注册），应在任务资料中固定提供可用账号或注册/清理接口。
- 同一天先跑 Landing/Login，再跑注册，注册用例污染了后续数据；建议按“只读用例 → 注册成功 → 注册失败”分组，或每组独立环境。
- 运行记录 `total` 包含未执行用例，`passed/failed` 不能直接表达“执行了几条”；建议增加 `executed/skipped/notRun`。
- 任务被取消后，最终 `suite-partial` 与“通过 1/3”应明确区分“人工取消”，不要混在失败域里。

## 6. 建议的重跑顺序

1. 升级执行机到包含 `0.3.33` 邮箱递增的版本；先 `doctor`，确认 Appium/XCUITest、WDA、签名团队、设备、已安装版本。
2. 设置长流程步数上限（例如 `AOS_IOS_MAX_STEPS=60`），只跑 Virtual Card 的 3 条用例。
3. 用新的 `+203` 邮箱和一次性手机号；先只跑“成功注册”，确认 T&C/Register_Done/Points 证据。
4. 另起一轮、使用新的邮箱和手机号跑“Reject Tnc”，不要复用成功注册的数据。
5. 最后跑 Landing/Login/Forgot email；需要 Intro 的用例使用 fresh install/清数据模式。
6. 失败时保留截图/AX/动作日志，再决定是产品缺陷、用例问题还是执行器问题。

## 7. 一句话总结

周五 iOS 测试的主要瓶颈不是模型会不会点，而是**环境未提前门禁、注册数据不隔离、长流程步数不足、失败证据不够**；先把这四项补齐，再谈用例通过率才有意义。

## 8. 本次已落地的改进

- 失败分类收紧：只有真实的“未注册/已存在/请先登录/无数据/网络失败”等信号才归 `data-environment`；屏幕标题里的 `Login / Register` 不再误触发。
- 步数/token 预算耗尽单独归 `case-defect`，原因写明“执行预算耗尽”，不再冒充产品行为差异。
- 人工取消时先向 Artemis 发送 `mobile_manage_task stop`，并把仍为 `running` 的 trace 落成 `cancelled` 终态，避免远端证据永远显示运行中。
- 对应测试：`test/failure-taxonomy.test.js`、`test/case-runner-abort.test.js`。

