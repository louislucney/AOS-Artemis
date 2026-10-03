# Spec: API 错误 → 错误码匹配 → 通用处理判定 → 反馈进用例

> 状态：已实施（2026-10-02，票据 01–05 全绿；见 DESIGN §13.36）；范围 Android/ARTEMIS 先行。

## 背景与目标

真机测试执行期间，应用可能出现 API 请求错误（HTTP 4xx/5xx、超时、业务错误码）。当前闭环只能看到 UI 表现与（Pro 主动抓取的）日志，无法把"错误码 → 项目通用处理（error handler）→ 用例结果"确定性串起来。本特性目标：

1. 项目侧有一份**错误码注册表**（先人工维护，确定性强）；
2. 测试期间由 AOS 按 trace 时间窗**确定性采集设备日志**，匹配注册的错误码；
3. 按注册表判定"是否有通用处理命中"（handled / unhandled / observed）；
4. 结果**如实进入用例结果、证据、报告与生成反馈**；默认只作为证据/分类，不阻断通过（可用 `--fail-on api-error` 显式阻断）。

## 数据契约

### `.artemis/design/error-codes.json`（项目人工维护）

```json
{
  "version": 1,
  "codes": {
    "AUTH_401": {
      "match": "\\bHTTP\\s*401\\b|AuthInterceptor.*401",
      "handler": "relogin",
      "expect": "401 应跳转登录页",
      "handledPattern": "navigateToLogin|LoginActivity"
    },
    "ORDER_500": {
      "match": "\\b500\\b.*order",
      "expect": "订单接口 5xx 应展示通用错误页"
    }
  }
}
```

- `match`：必填，正则（字符串），在 trace 时间窗日志内匹配；
- `handler`/`expect`：可选的语义说明（写进报告）；
- `handledPattern`：可选正则；命中 → `handled`，未命中 → `unhandled`；缺省 → `observed`（无法判定，仅证据）；
- 非法正则/缺 match/空对象 → 记入注册表加载错误并忽略该条。

### `.artemis/traces/<traceId>/api-errors.json`（AOS 产物）

```json
{
  "traceId": "...",
  "serial": "emulator-5554",
  "window": { "startMs": 0, "endMs": 0 },
  "source": "logcat" ,
  "degraded": "no-serial | adb-not-found | device-offline | log-empty | registry-missing | registry-empty | collector-error",
  "errors": [
    { "code": "AUTH_401", "handler": "relogin", "expect": "401 应跳转登录页",
      "handled": false, "verdict": "unhandled", "count": 2,
      "firstAt": "10-02 04:11:42.319", "sample": "HTTP 401 Unauthorized ..." }
  ]
}
```

## 判定规则（确定性，ADR-0001）

- 采集：`adb -s <serial> logcat -v threadtime -d -T <windowStart - 5s>`（与崩溃采集同套路；设备时钟偏差探测失败按 0 处理并记 `clockWarning`）；日志裁剪上限与崩溃采集一致。
- 匹配：对每条规则 `match` 全局扫描日志文本，计数并取首个样例行；`handledPattern` 在同一文本内判定。
- 失败域优先级：崩溃（app-defect）> 环境（adb/device）> **未处理 API 错误（api-error）** > 数据环境 > 行为或设计差异 > 用例缺陷 > 未分类。
  - 仅 `unhandled` 触发 api-error 域；`observed`/`handled` 只作为证据不改变域。
- 报告与反馈如实透出：逐例 `apiErrors`、报告列、JUnit 内容、`suite feedback` 建议（默认只建议，不改写生成物）。

## 非目标（本期不做）

- 抓包/代理/HAR、响应体断言、非 Android 栈、按代码自动扫描错误码（后续票据）、把 api-error 默认设为阻断。
