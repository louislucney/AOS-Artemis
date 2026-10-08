# 05 — iOS：demo 后门 release 屏蔽（Debug 保留）

**What to build:** `MOPItemDetailDemoEntry` / `MOPHomeDemoEntry` 等启动参数入口仅在 Debug 构建可用（`#if DEBUG`），release/UAT 包不再响应 `-MOPItemDetailDemo*` / `-MOPHomeDemo*`；Debug 保留，现有 demo 直进用例不受影响。作为审计项登记。

**Blocked by:** None

**Status:** resolved

- [ ] `isDemoRequested` 系列加 `#if DEBUG` 保护（含 AppDelegate 调用点）
- [ ] release 构建验证：不响应参数（构建/静态检查）
- [ ] 记录到 iOS 仓库文档（安全/审计条目）

## Comments

- 2026-10-08 实施：5 个 DemoEntry（ItemDetail/Home/ReviewOrder/Landing/OrderStatus）的 `isDemoRequested` 以 `#if defined(DEBUG) || defined(DEV_VERSION) || defined(UAT_VERSION)` 收口，生产编译期返回 NO；选择该条件是因为测试 scheme 使用 "Debug UAT" 配置（定义 UAT_VERSION，未定义 DEBUG）。
- 验证：`build-for-testing` 成功；`MOPEndToEndFlowUITests` 实测通过（40.8s），Debug UAT 下 demo 链路不受影响。
