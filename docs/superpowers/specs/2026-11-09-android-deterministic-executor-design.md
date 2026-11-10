# Design：Android 确定性执行层（结构化动作 + 原生 runner）

> 状态：**draft rev 6（Phase 1 已实现；iOS/Android Phase 2 已接入 suite；Android 真机 Phase 0/验收待设备）**
>
> 日期：2026-11-09
>
> 修订 rev 6（2026-11-10）：Android 原生 runner 已接入——`src/device/android-actions.ts`（adb 适配器）+ 与 iOS 共用的 `structured-runner`；`engine:"native"` 在 Android 上不提交 `mobile_run_task`，失败不回退 Artemis；`native-android.json` 纳入证据。单测覆盖；真机 Phase 0/验收待设备。
>
> 修订 rev 4（2026-11-09）：iOS 最小结构化 runner 原型落地——`src/ios/structured-runner.ts` 无 LLM 执行 tap/type/wait + AX 可见性断言；`scripts/ios-structured-runner.mjs` 从 tests.json 执行 native 用例；back/swipe/secretRef 显式不支持。
>
> 修订 rev 3（2026-11-09）：Phase 1 结构化动作契约已落地——tests.json `flows[].actions[]` + `engine`/`engineReason`；生成器按 stack 选择 target kind，仅有标识符时生成 tap，wait/back 可无目标；explore/缺动作/prelude 显式回退 artemis；`suite check`/preflight 对 native 不完整/非法 actions 硬门禁；执行层未接。
>
> 修订 rev 2（2026-11-09）：吸收 review 反馈——新增 Phase 0 环境 Spike 门禁；raw `uiautomator dump` 不再作为默认观测；中文输入强制 ADBKeyboard；selector 按 stack 区分 resource-id/view-tag/content-desc/semantics-label；增加可见性过滤环境失败分类。
>
> 关联：`DESIGN.md` §4.4 / §8.3；`src/figma/test-gen.ts`、`src/figma/case-runner.ts`、`src/artemis/android-trace.ts`、`src/artemis/android-adherence.ts`、`src/ios/script-plan.ts`

## 1. 背景与现状

Android 当前由 Artemis（Python 子进程）执行：

```text
LLM 根据 taskDesc 决定动作
→ Artemis 执行 tap/type/swipe
→ 结束后 AOS 读取 data_engine.db 的 OCR / UI tree
→ 用 【AOS-EXPECT】 文本做事后 adherence
```

已实现的是**观测门禁**：

- `android-adherence.ts`：事后核对断言/探索/起始屏
- `--fail-on-unresolved`：非隔离用例未命中断言时 exit 2
- `suite report` / `android-adherence.json`：可追溯

它不是状态机执行层。原因不是“缺一个补丁”，而是：

1. `taskDesc` 是自然语言，不是可执行动作；
2. 没有“目标控件 + 动作 + 动作后期望状态”的结构化契约；
3. 没有能够在每一步动作后即时读取 UI tree 并做确定性判定的原生执行器。

**明确非目标**：不通过解析中文步骤猜点击目标来冒充确定性执行。那仍然是启发式/LLM，不是本设计要的东西。

## 2. 目标与非目标

### 目标

- 为可结构化用例生成 `actions[]`：动作类型、目标选择器、输入、动作后期望。
- 新增 Android 原生 runner：执行结构化动作，每一步后读取 UI tree，核对期望；不匹配立即失败。
- 保留 Artemis 作为非结构化/探索用例的执行引擎；按用例能力显式选择 engine。
- 失败可复现：step、target、expected、actual、截图、UI tree 证据。
- 不引入 LLM 参与结构化用例的动作选择或断言判定。

### 非目标

- 本设计不替代 iOS 执行器。
- 不要求所有存量 Excel 用例立刻结构化；不能结构化的继续走 Artemis。
- 不做跨设备并发调度；复用现有设备/租约/任务体系。
- 不把 UI diff 当硬断言；视觉比对仍只作补充证据。

## 3. 总体架构

```text
tests.json flows[]
  ├─ steps[]        人类可读步骤（保留）
  ├─ expectations[] 现有 AOS-EXPECT（保留）
  ├─ actions[]      ★ 新增：结构化动作
  └─ engine         "native" | "artemis" | "auto"

执行选择
  ├─ engine=native 且 actions 完整 → AndroidNativeRunner
  └─ 其他 → Artemis（现有路径）

AndroidNativeRunner
  ├─ ObservationAdapter：uiautomator dump → UI tree → 可见文本/a11y 索引
  ├─ TargetResolver：a11y id > text/content-desc；多候选/缺失 → fail
  ├─ ActionAdapter：adb input tap/text/swipe/keyevent
  ├─ StepLoop：动作 → 等待 → 观测 → 断言 → 证据
  └─ Result：engine/steps/证据 → SuiteCaseResult
```

## 4. 数据契约（Phase 1）

### 4.1 tests.json 扩展

```jsonc
{
  "flows": [
    {
      "id": "case-1",
      "steps": ["点击「登录」", "输入账号密码", "点击「提交」"],
      "expectations": [
        { "index": 1, "screen": "登录", "hints": ["账号"], "kind": "assert" }
      ],
      "engine": "native",
      "actions": [
        {
          "stepIndex": 0,
          "action": "tap",
          "target": { "kind": "a11y", "value": "login_button" },
          "fallbackTargets": [{ "kind": "text", "value": "登录" }],
          "expect": { "screen": "登录", "hints": ["账号", "密码"] },
          "timeoutMs": 8000
        },
        {
          "stepIndex": 1,
          "action": "type",
          "target": { "kind": "a11y", "value": "username_input" },
          "input": { "kind": "secretRef", "ref": "account.username" },
          "expect": { "hints": ["账号"] }
        },
        {
          "stepIndex": 2,
          "action": "tap",
          "target": { "kind": "text", "value": "提交" },
          "expect": { "screen": "首页", "hints": ["首页"] }
        }
      ]
    }
  ]
}
```

### 4.2 字段

| 字段 | 说明 |
|---|---|
| `engine` | `native` / `artemis` / `auto`；`native` 要求 `actions` 覆盖所有必需步骤 |
| `actions[].stepIndex` | 对应 `steps[]` 下标；允许一个人类步骤对应多条动作（后续扩展） |
| `action` | Phase 2 仅支持 `tap` / `type` / `back` / `swipe` / `wait` |
| `target.kind` | `resource-id` / `content-desc` / `view-tag` / `semantics-label` / `text` / `point`（`point` 仅用于明确手势，不用于文本断言；`a11y` 不再作为笼统值） |
| `target.value` | 选择器值；按 kind 对应 Android UI tree 的实际属性。RN 的 `testID` 可能映射到 `view-tag`/`content-desc`，Flutter 走 `content-desc`/`semantics-label`，不能假设一定是 `resource-id` |
| `fallbackTargets` | 有序回退选择器；仍要求唯一匹配，多候选直接失败 |
| `input` | `text` / `secretRef`；secret 只在执行期从项目 secret 解析，不落 artifacts |
| `expect` | 动作后观测：`screen`、`hints`（全部出现）、`absent`（不得出现）、`timeoutMs` |
| `timeoutMs` | 单步动作+观测超时；缺省 8s |
| `optional` | 缺省 false；optional 步骤失败只记录，不阻断用例（谨慎使用） |

### 4.3 引擎选择规则

```text
actions 存在且每个必需 stepIndex 都有 action
  → engine = native
否则
  → engine = artemis，并记录 engineReason = "actions-incomplete" | "no-structured-actions"
```

- `auto` 仅用于显式选择；不会在 native 失败后静默重跑 Artemis。
- native 失败就是失败，必须暴露；避免“原生失败→Artemis 碰巧通过”掩盖问题。
- 探索（`kind=explore`）步骤不进入 native 必需动作；含探索步骤的用例默认 Artemis。

## 5. Android 原生 runner（Phase 2）

### 5.1 环境准备与启动

**Phase 0 Spike 必须先验证以下能力**（见 §8）：

- 快速观测工具：`uiautomator2`（atx-agent）或 Appium UiAutomator2 server，或自定义 instrumentation；**raw `adb shell uiautomator dump` 不作为默认实现**。
- 中文输入：`ADBKeyboard` APK（`com.android.adbkeyboard/.AdbIME`）安装与 `ime set` 切换。
- 工具版本、APK、端口/健康检查、失败降级写入环境准备；Spike 不达标不进入 Phase 2。

启动/复位复用现有套件能力：

- `--device <serial>` / `--app <package>` / `--app-path <apk|url>`
- force-stop → 安装（如提供）→ 启动
- 可选 `preActions[]`：处理权限弹窗、引导页（Phase 2 先不做自动探索）
- 每次会话开始检查观测/输入工具健康状态；失败直接标环境失败，不执行用例

### 5.2 观测适配器

- 通过 `ObservationAdapter` 抽象，默认候选：uiautomator2/atx-agent 或 Appium UiAutomator2 server；raw dump 仅 last-resort，单次超时 ≤1s 并显式降级
- 解析节点：`text`、`content-desc`、`resource-id`、`class`、`bounds`、`clickable`、`enabled`、`visible-to-user`
- **可见性过滤**：`visible-to-user=false`、bounds 不与屏幕交集、父节点不可见的节点不参与 target/断言；`visible-to-user` 单独不可靠，需结合 bounds 与祖先可见性
- 归一化文本：沿用 `normalizeMatchText`（去空白、大小写/全半角按现有规则）
- 稳定判定：快速 adapter 连续两次关键文本一致；**禁止依赖 raw dump 的 `waitForIdle` 10s 行为**
- 每一步保存：
  - `step-N.pre.xml` / `step-N.post.xml`
  - 截图（如可用）
  - 汇总 `actualTexts` / `visibleA11yIds` / `bounds`

### 5.3 目标解析

优先级（按项目技术栈选择，不假设 `testID` 一定映射为 `resource-id`）：

1. `resource-id` 精确匹配（原生 Android 首选）
2. `view-tag`（React Native `testID` 的常见映射之一）
3. `content-desc` / `semantics-label`（RN/Flutter 常见；Flutter `Key` 不保证暴露）
4. `text` 精确匹配可见文本
5. `fallbackTargets` 按顺序
6. 仍无匹配或多候选 → `target-not-found` / `target-ambiguous`，不猜

点击坐标取节点 bounds 中心；节点不可点击时向上找最近可点击祖先（记录 `resolvedBy:"ancestor"`）。滚动查找在 Phase 2 先不自动做；`scroll` 明确失败并建议使用 `swipe` 动作。

### 5.4 动作执行

| action | 实现 |
|---|---|
| `tap` | `adb shell input tap x y` |
| `type` | 聚焦目标后清空（可选）→ **ADBKeyboard 广播** `ADB_INPUT_B64`；支持 `secretRef` |
| `back` | `adb shell input keyevent 4` |
| `swipe` | `adb shell input swipe x1 y1 x2 y2 [duration]` |
| `wait` | 仅观测，不动作 |

**中文/特殊字符**：`adb shell input text` 不支持 Unicode，**不得作为默认实现**；`type` 强制走：

```text
adb shell ime set com.android.adbkeyboard/.AdbIME
adb shell am broadcast -a ADB_INPUT_B64 --es msg <base64(text)>
```

IME 切换/广播失败 → `environment/ime-unavailable`，不静默降级到 `input text`。剪贴板仅作为显式 fallback，且需记录安全键盘/ROM 限制风险。

### 5.5 断言与失败

每步动作后：

1. 通过快速 adapter 等待 UI 稳定（连续两次关键文本一致，最多 `timeoutMs`）
2. 校验 `expect.screen`（若给出）：屏幕名作为完整可见标签/标题匹配
3. 校验 `hints`：全部出现在**可见**文本或 a11y 标签（不可见/屏外节点不算命中）
4. 校验 `absent`：可见节点中不得出现
5. 失败 → 停止该用例，记录：

```json
{
  "engine": "native-android",
  "stepIndex": 2,
  "action": "tap",
  "target": {"kind":"text","value":"提交"},
  "expect": {"screen":"首页","hints":["首页"]},
  "actual": {"screen":"登录","hints":["账号","密码"]},
  "failureReason": "expect-mismatch",
  "evidence": {"pre":"step-2.pre.xml","post":"step-2.post.xml","shot":"step-2.png"}
}
```

**失败域**：仍走现有 taxonomy，但 native runner 必须显式区分环境失败：

- `environment/ime-unavailable`：ADBKeyboard 安装/切换/广播失败
- `environment/dump-timeout` / `environment/observation-failed`：观测工具超时/崩溃
- `environment/adb-disconnected`：设备掉线
- 上述失败不计入用例 PASS/FAIL 统计，触发 quarantine/环境重试；不得归为 `app-defect` 或 `case-defect`

## 6. 生成侧（Phase 1）

### 6.1 设计流水线

`figma_generate_tests` / `design_to_test` 在已有 `steps[]`/`expectations[]` 基础上生成 `actions[]`：

- 读取项目 `stack`：
  - `android-native`：优先 `resource-id`
  - React Native：优先 `view-tag`/`content-desc`（`testID` 映射需按 RN/Appium 版本探测，不假设 `resource-id`）
  - Flutter：优先 `content-desc`/`semantics-label`（`Key` 不保证暴露）
- 其次取元素 `label` 的精确文本
- 无法确定目标 → 不生成该步 action；flow 标 `engine:"artemis"`，`engineReason:"actions-incomplete"`
- `expect` 复用现有 expectations 的 screen/hints；`kind=explore` 不进入 actions
- 生成侧不猜测跨平台框架的 `testID` 映射；用 `stack` + 可选运行时探测（Phase 0 Spike 结果）决定 selector kind

### 6.2 Excel 导入

- Phase 1 不解析中文 Excel 步骤猜 action
- 导入用例默认 `engine:"artemis"`
- 后续可提供显式结构化动作列/旁路 JSON（单独设计），不混入本阶段

### 6.3 校验

- `suite check` 增加 actions 结构校验：stepIndex 越界、动作类型未知、target 为空、secretRef 未定义 → 硬错误
- `actions` 不完整但 `engine:"native"` → 硬错误
- 旧 tests.json 无 actions → 保持 Artemis，不报错

## 7. 与现有模块的关系

| 模块 | 变化 |
|---|---|
| `src/figma/test-gen.ts` | 生成 `actions[]` / `engine` / `engineReason` |
| `src/figma/design-store.ts` | `GeneratedCase` 投影增加 actions/engine |
| `src/figma/case-runner.ts` | 按 engine 分派；native 结果映射为 `SuiteCaseResult` |
| 新增 `src/android/native-runner.ts` | Observation/TargetResolver/ActionAdapter/StepLoop |
| `src/artemis/android-trace.ts` | 保留；Artemis 路径继续用 |
| `src/artemis/android-adherence.ts` | 保留；Artemis 路径的事后观测 |
| `src/suite-command.ts` | `--fail-on-unresolved` 继续；native 不需要该门禁也天然硬失败 |
| 面板/报告 | 显示 `engine` 与 native 逐步证据；旧产物显示 `engine:artemis` |

## 7.1 iOS 对照（2026-11-09 实测）

iOS 不是 Artemis 路径：已有原生执行器（模拟器 idb/simctl，真机 Appium/WDA），按步读取 AX、执行 `AOS-EXPECT` adherence、preflight、verifier。它的缺口在**动作选择仍是 LLM chat**，而不是观测层。

Phase 0 等价 Spike（iPhone 17 / iOS 27 模拟器，Xcode 27.2）：

- `idb ui describe-all` 预热后：p50 155.6ms / p95 157.3ms
- 中文输入走 `idb ui set-value --api ax`：p50 176ms / p95 192ms，5/5 正确
- 单步合计约 350ms，低于本设计给 Android 的门槛

结论：

- iOS 模拟器的观测/中文输入已满足原生 runner 前提；
- 真机 WDA `typeText` 对非 ASCII 有限制（代码已有提示），需要单独真机 Spike；可评估 WDA setValue / pasteboard 方案；
- 结构化 `actions[]` 契约可在 iOS/Android 共用；iOS 可直接复用现有 observation/action 层，优先做 Phase 1 actions 的 iOS 执行验证。

Phase 2 iOS 已接入 suite（2026-11-09）：

- `src/ios/structured-runner.ts`：无 LLM，按 `actions[]` 执行 tap/type/wait，按 AX 可见节点解析目标并校验 expect；back/swipe 显式不支持；`type` 的 `secretRef` 执行期解析项目 secret（缺失显式失败，证据文本脱敏，含 iOS 逐字分隔回显）
- `case-runner`：`engine:"native"` 在 iOS 上直接调用 structured runner，不提交 `mobile_run_task`；失败不回退 Artemis；环境/断言失败分别归 environment/behavior-or-design
- `scripts/ios-structured-runner.mjs`：从 tests.json 选 `engine:"native"` 用例单独执行，退出码 0/1/2
- 已在 iPhone 17 / iOS 27 模拟器端到端跑通：`type` 目标 text「搜索」→ 输入「中文测试 AOS」→ expect 命中；tap 用例通过 `suite run`
- Android `engine:"native"` 走 adb 结构化 runner（`native-android`，与 iOS 共用同一套 target/expect/secretRef 逻辑）；真机 Phase 0/验收待设备；iOS 真机仍待 WDA Unicode Spike
- 运行手册：`docs/ios-structured-runner.md`

## 8. 分阶段与验收

### Phase 0：环境 Spike（Phase 2 的硬门禁）

目标：在目标项目（如 ESSO-GU）真机上，不使用 LLM，仅验证底层工具链闭环：

> 执行脚本：`scripts/android-native-spike.mjs`；用法见 `docs/android-native-spike.md`。

1. 安装 `ADBKeyboard` 并 `ime set com.android.adbkeyboard/.AdbIME`
2. 通过 `ADB_INPUT_B64` 广播输入中文/特殊字符，确认输入框内容正确
3. 用候选观测工具（uiautomator2/atx-agent 或 Appium UiAutomator2 server）连续 dump UI tree 10 次
4. 用 `visible-to-user` + bounds 过滤后校验预期文本
5. 连续 5 轮，记录 p50/p95、超时/失败率

验收门槛（建议）：

- 单次 dump p95 ≤ 1s，无 raw dump 的 10s idle 超时
- 中文输入 5/5 正确，无乱码
- 可见性断言不会把屏外/不可见文本算命中
- 稳态单步（动作+观测+断言）p95 ≤ 2s
- 任一项不达标 → **不进入 Phase 2**，保留 Artemis + 事后观测门禁，重新评估工具链

### Phase 1：结构化动作契约（可先做）

产物：

- tests.json `actions[]` / `engine`
- 生成器只在有足够选择器时产出 native actions
- `suite check` 校验
- 不改变执行行为（无 actions 的仍然 Artemis）

验收：

- 旧 tests.json 全部继续通过
- 新生成用例中，凡 `engine:"native"` 的 actions 完整、stepIndex 合法
- 无法结构化的用例显式 `engine:"artemis"` + reason
- 单测覆盖：完整 actions、actions 缺失、secretRef、越界、未知 action

### Phase 2：最小原生 runner

范围：`tap` / `type` / `back` / `swipe` / `wait` + 观测断言 + 证据。

验收：

- 同一结构化用例连续 5 次，PASS/FAIL 与失败 step 一致
- target 多候选/缺失不会误点，直接失败
- expect 不匹配在 `timeoutMs` 内失败，且带 pre/post UI tree + 截图
- 中文输入通过 ADBKeyboard，无乱码/剪贴板依赖
- 环境失败（dump/IME/adb）归 `environment`，不计入用例 PASS/FAIL
- 同一批次中 `engine:"artemis"` 用例仍走原路径，互不影响
- 无 LLM 调用

### Phase 3：并存与收口

- 面板/报告展示 engine 与 native step 结果
- `AOS_ANDROID_ENGINE=auto|native|artemis`（缺省 auto）
- native 覆盖率达到项目门槛后，再决定是否把套件门禁切到 native-first

## 9. 风险

- **观测性能**：raw `uiautomator dump` 可能因 `waitForIdle` 阻塞 3-10s；必须用快速 adapter，否则 Phase 2 不可用。
- **中文输入**：`input text` 不支持 Unicode；ADBKeyboard 是默认方案，但受 ROM/安全键盘/输入法策略影响，必须显式环境失败。
- **选择器映射**：RN 的 `testID` 可能映射到 `view-tag`/`content-desc`，Flutter 走 semantics，不保证 `resource-id`；生成侧必须按 `stack` 选择 kind。
- **可见性**：UI tree 包含屏外/不可见节点；必须用 `visible-to-user` + bounds + 祖先可见性过滤，避免假阳性。
- **动态列表/滚动**：Phase 2 不自动滚动查找；需要显式 `swipe` 或后续扩展 `scrollUntil`。
- **权限弹窗/系统 UI**：需要 preActions 或 reset 策略；否则首步就可能 target-not-found。
- **选择器漂移**：设计或代码改动会导致 target 失效；这是确定性的代价，应通过 `screen-map`/a11y 稳定性治理。
- **引擎并存复杂度**：必须禁止 native 失败后静默重跑 Artemis；否则会掩盖真实缺陷。

## 10. 开放问题

1. 目标项目（ESSO-GU 等）的 `resource-id`/`testID`/semantics 覆盖率如何？需要真机 dump 抽样，不能只看源码。
2. 观测工具选哪个：uiautomator2/atx-agent、Appium UiAutomator2 server、还是自定义 instrumentation？以 Phase 0 的 p95/稳定性数据决定。
3. `ADBKeyboard` 在目标 ROM/安全键盘/密码框上的行为是否稳定？失败如何降级为环境失败？
4. RN/Flutter 项目的 selector 映射需要用真实 dump 验证；`testID` 是否出现为 `view-tag`/`content-desc` 而不是 `resource-id`？
5. 滚动查找是否进入 Phase 2，还是先要求用例显式 `swipe`？
6. ~~secretRef 的命名与项目 secret 存储如何与现有 `.env`/materials 对齐？~~ 已决：alias 大小写不敏感，来源为项目 secret materials + `AOS_WEB_SECRET_*`（与 `loadWebSecrets` 同源）；执行期解析，证据脱敏。
7. 多设备并行时 UI dump 的串行化与设备锁如何复用现有租约？

## 11. 结论

Android 确定性执行层应先落 **Phase 0 环境 Spike**，用真实设备证明“快速稳定 dump UI 树 + 中文输入 + 可见性断言”成立；再落 **Phase 1 结构化动作契约**，最后才是 **Phase 2 原生 runner**。当前按用户要求已先落 Phase 2 代码与单测（与 iOS 共用 runner），但 Phase 0 真机门禁仍未通过，不能宣称真机验收通过。
