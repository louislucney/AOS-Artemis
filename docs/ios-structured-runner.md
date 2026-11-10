# iOS 最小结构化动作 runner（Phase 2，已接入 suite）

> 关联：`docs/superpowers/specs/2026-11-09-android-deterministic-executor-design.md` §7.1
>
> 模块：`src/ios/structured-runner.ts`
>
> 脚本：`scripts/ios-structured-runner.mjs`

## 能力

不使用 LLM，按 `tests.json flows[].actions[]` 在 iOS 上执行：

- `tap`：按 `resource-id` / `view-tag` / `content-desc` / `semantics-label` / `text` / `point` 解析目标
- `type`：点击目标后 `inputText`（模拟器非 ASCII 走 `idb set-value --api ax`）；`input.kind=secretRef` 时执行期按 ref 解析项目 secret（`suite run` 与独立脚本同源：项目 secret materials + `AOS_WEB_SECRET_*`；alias 大小写不敏感，缺失显式失败 `secret-unresolved:<ref>`，证据文本以 `***` 脱敏，含 iOS 逐字分隔回显）
- `wait`：等待后观测
- 每步动作后读取 AX 树，过滤屏外/零尺寸节点，校验 `expect.screen/hints/absent`

明确不支持（Phase 2 原型）：

- `back` / `swipe`（iOS 能力不同，先显式失败）
- 探索步骤、continuation/prelude

## 运行

### 直接跑单例

先启动并安装目标应用，确保用例的 `engine:"native"` 且 `actions[]` 完整：

```bash
node scripts/ios-structured-runner.mjs \
  --project /Users/louis/Documents/AOS/ESSO-GU \
  --case TC_000001 \
  --device <simulator-udid> \
  --json
```

输出逐 step `passed/failed/error`，退出码 0/1/2。

### suite run

`engine:"native"` 的 iOS 用例在 `suite run` 中直接走 structured runner，不提交 `mobile_run_task`：

```bash
node dist/cli.js suite run \
  --project <dir> \
  --device <simulator-udid> \
  --case <caseId> \
  --no-save --no-api-errors
```

- 原生失败不回退 Artemis。
- 逐例输出「引擎 native-ios」；trace 的 `native-ios.json` 纳入 `suite evidence`。
- `environment` 类失败（idb/HID、设备、WDA）计入 `failure.domain=environment`。
- 断言失败/目标问题计入 `behavior-or-design` 或 `case-defect`。
- Android 的 `engine:"native"` 仍按 Artemis 执行（Android Phase 2 未实现）。

## 已验证

iPhone 17 / iOS 27 模拟器（Xcode 27.2）：

| 指标 | 结果 |
|---|---|
| AX 快照预热后 p95 | 157ms |
| 中文输入 `set-value --api ax` p95 | 192ms |
| 中文输入成功 | 5/5 |
| 结构化 actions 端到端 | `type` 目标 text「搜索」→ 输入「中文测试 AOS」→ expect 命中，status=passed |

端到端用例不经过 LLM：tests.json `engine:"native"` + `actions[]`，脚本直接执行目标解析、tap/type、AX 可见性断言。

## 真机 WDA Unicode Spike 前置

当前物理设备 `HenryiPhone` 在 `devicectl` 中为 `unavailable`，USB 未连接，且没有 Remote XPC 隧道；因此真机 Spike 尚未执行。连接设备后按以下顺序：

1. USB 连接、解锁、信任此电脑，开启 Developer Mode
2. 项目 `.env` 配置 `AOS_IOS_XCODE_ORG_ID`（真机签名团队 ID）
3. 确认 Appium + xcuitest driver 已安装
4. iOS 18+ 建立并保持隧道（独立常驻进程）：
   ```bash
   sudo appium driver run xcuitest tunnel-creation
   ```
5. 准备一个 `engine:"native"` 的 `type` 用例（目标输入框 + 中文文本），运行：
   ```bash
   node scripts/ios-structured-runner.mjs \
     --project <ios-project> \
     --device <physical-udid> \
     --case <caseId> \
     --json
   ```

判定：

- 中文输入成功 → WDA 路径可用
- `typeText` 报错/乱码 → 记录 `environment` 失败，后续评估 WDA setValue / pasteboard 方案
- 不要用模拟器结果替代真机结论

## 边界

- 当前脚本通过 `Runtime.iosDevice` 解析设备：模拟器走 idb/simctl，真机走 Appium/WDA（需要隧道/签名配置）。
- 真机 WDA `typeText` 对非 ASCII 有限制，需单独真机 Spike；`src/ios/appium/facade.ts` 已显式提示。
- 已接入 `suite run` / `case-runner`；`mobile_run_task` 的普通任务路径不变。
- `actions[]` 生成依赖 Phase 1 的 `screen-map`/code identifier；没有标识符的用例仍走 Artemis。
