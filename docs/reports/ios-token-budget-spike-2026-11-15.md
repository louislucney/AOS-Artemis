# iOS Token 预算 Spike（2026-11-15）

> 状态：**Phase 0 数据侧 Spike 完成；真实设备中断/恢复 Spike 仍待执行**  
> 关联：[跨端一致性设计 v0.2](../superpowers/specs/2026-11-15-cross-platform-execution-consistency.md)、[iOS 回归追溯](ios-regression-2026-11-13.md)

## 1. 目的

验证草案中的 Token 预算假设，回答三个问题：

1. 当前 iOS LLM 一个 case 实际消耗多少 prompt/completion token？
2. 是否有默认上限？现有历史压缩是否足以控制上下文？
3. `maxTokens` / `maxPromptTokens` / `compressionThreshold` 应该怎么设，才不会造成“未完成核心断言就熔断”？

## 2. 数据来源

- 项目：`ESSO-GU`
- 证据：`ESSO-GU/.artemis/remote-evidence/<taskId>/<traceId>/status.json`
- 日期：2026-11-13 周五
- 设备：iOS 真机 `00008101-…（已脱敏）`
- 工具：

```bash
node scripts/analyze-ios-token-usage.mjs <project>/.artemis/remote-evidence
```

## 3. 实测结果

周五共 13 个带 iOS trace 的目录；其中 3 个 `running` 没有 token 记录，其余 10 个有 usage。

| trace | 状态 | calls | prompt | completion | prompt/completion | maxPrompt | p95Prompt | cacheRead |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| ios-93b8d19a | failed | 7 | 33,265 | 3,128 | 10.6 | 8,372 | 8,372 | 17,664 |
| ios-e84e85d6 | failed | 9 | 50,835 | 1,177 | 43.2 | 9,713 | 9,713 | 32,256 |
| ios-3ff8421f | failed | 11 | 106,571 | 4,632 | 23.0 | 16,076 | 16,076 | 79,104 |
| ios-4dab2d78 | failed | 9 | 70,604 | 2,798 | 25.2 | 15,472 | 15,472 | 45,184 |
| ios-0427e80c | failed | 8 | 49,628 | 1,421 | 34.9 | 11,462 | 11,462 | 29,184 |
| ios-a81ba869 | failed | 33 | 1,095,444 | 10,269 | 106.7 | 67,674 | 64,201 | 993,408 |
| ios-8be77fca | failed | 30 | 1,050,230 | 4,691 | 223.9 | 71,038 | 68,788 | 945,408 |
| ios-ce68a34f | failed | 30 | 1,060,460 | 3,704 | 286.3 | 75,077 | 72,703 | 951,296 |
| ios-efebb1a5 | failed | 52 | 4,014,161 | 11,877 | 338.0 | 190,782 | 189,138 | 3,763,456 |
| ios-e9b777c2 | failed | 18 | 337,921 | 7,146 | 47.3 | 38,222 | 38,222 | 280,576 |

合计：

```text
traces: 10（有 usage）
prompt: 7,869,119
completion: 50,843
prompt/completion: ≈154.8x
```

3 个 `running` trace（`ios-375ff80d`、`ios-1b51fc1a`、`ios-de85c9a2`）没有 token 记录，也说明取消/中断后的证据不完整。

## 4. 结论

### 4.1 反馈方向成立，且实际更严重

- prompt/completion 不是 10x，而是 **10.6x–338x**
- 单个长注册 case 出现 **4,014,161 prompt / 11,877 completion**
- 单次调用 prompt 最高 **190,782**，p95 约 **189,138**
- 这不是“理论风险”，是周五真实数据

### 4.2 当前没有可靠预算

- `AOS_WEB_LLM_MAX_TOKENS_PER_CASE` **没有默认值**，项目也未设置
- 有预算时检查在 LLM 调用之后；本次请求已经发出并计费
- 因此当前无法阻止单 case 跑到百万级 prompt

### 4.3 现有历史压缩存在，但不是预算感知

- `AOS_IOS_HISTORY_STEPS` 默认 8：保留最近 8 步
- 更早步骤压成 digest（`prompt-history.ts`）
- 这是**固定步数压缩**，不随剩余预算/估算 prompt 变化
- 视觉截图、元素列表、验证/多 attempt 调用仍会让单次 prompt 快速增长

### 4.4 不能直接用 200k 作为全局默认

以周五数据看：

- 50k–100k 的短流程 case 可以落在 200k 内
- 注册长流程 case 会轻松超过 200k
- 如果直接设 200k 硬上限，可能在注册链路中途熔断，留下半注册状态

## 5. 建议的预算策略

### 5.1 分档而不是单点

建议项目/任务配置：

```jsonc
{
  "tokenBudget": {
    "soft": 1000000,              // 触发压缩/降级
    "hard": 2000000               // 硬熔断（示例，需项目确认）
  },
  "maxPromptTokens": 80000,       // 单次 prompt 软上限，超过先压缩
  "compressionThreshold": 0.75    // 剩余预算低于 75% 触发压缩
}
```

说明：

- `softTokenBudget` 用于“开始节约”，不失败。
- `maxTokens` 是硬熔断，必须有 reset/recovery。
- `maxPromptTokens` 是单次软上限：先减少历史/裁剪元素/关闭可选视觉，再决定是否失败。
- 不建议把 `maxTokensPerStep` 作为唯一硬限制。

### 5.2 压缩顺序

1. 减少历史步数（8 → 4，仍保留 digest）
2. 压缩元素列表（只保留可见/可操作/断言相关元素）
3. 对旧步骤做更强摘要
4. 保留当前 screen/断言/目标，不裁剪关键证据
5. 以上仍超 `maxPromptTokens` 才失败并复位

视觉调用不能盲目关闭：关闭后可能直接导致目标找不到；应先裁剪重复/无关视觉，再考虑降级。

### 5.3 熔断后的恢复

预算耗尽必须：

- `status = failed`，错误码 `budget-exceeded`
- 记录 `budgetUsed`（prompt/completion/cache/step）
- 执行 `reset`（至少 terminate/launch；可用 `app-internal-reset` 时优先）
- 标记是否处于“半注册/半登录”状态
- 不得只返回错误码后继续下一个 case

## 6. 还需要做的真实设备 Spike

本次只完成**数据侧**。仍需在一台 iOS 真机上验证：

1. 选一个已知成功的注册用例，设置 `softTokenBudget` + `maxTokens`
2. 在预算熔断时检查 App 是否停在半注册页面
3. 验证当前 `resetIosApp` 能否恢复；不能时验证 `app-internal-reset`
4. 记录恢复后重新执行是否成功、是否需要清理后端账号
5. 用 Android 同用例做对照，记录 proxy 是否能提供 token usage

验收：

- 熔断后不留下可继续注册的脏状态
- 重跑可完成核心断言
- 预算数据进入 run/status
- 两端至少能回答“是否可比较”

## 7. OTP 数据 Spike 的前置条件

OTP 侧当前没有可执行的供应商/后端接口，无法在本地完成。需要：

- 可用测试号码池与供应商 API
- 后端测试环境的限流/风控策略说明
- 清理/释放接口
- 固定的测试 OTP 或短信查询方式

在这些条件具备前，不建议把固定 24h 冷却或 `device_ip_binding` 直接写进 v1 默认值。

## 8. 当前决定

- 暂不设置全局硬 Token 默认值。
- 先做 **token 观测 + 软预算/压缩**，再按项目基线设硬上限。
- `maxTokensPerStep` 不作为唯一机制。
- OTP 冷却/风险字段保留在 v0.2 设计中，等待供应商/后端 Spike 后再定默认。
