# iOS ARTEMIS Phase 0 Spike 报告

> 2026-11-05 · Throwaway spike，不进入生产代码；设计评审后**暂停开发**  
> 设计文档：`docs/superpowers/specs/2026-11-05-ios-artemis-runtime-design.md`

## 目标

验证两件事：

1. `BaseDeviceDriver` + `UnifiedMobileControllerBase` 这层设备接缝能否用 iOS RPC 驱动。
2. ARTEMIS SDK `Agent.init` 是否能直接接受 iOS 设备上下文，而不改 agent core。

## 运行方式

```bash
node spikes/ios-artemis/run-spike.mjs
```

- `fake_device_rpc.mjs`：JSON-RPC fake device，600×1200 截图、scale=2、登录/成功两屏。
- `spike_controller.py`：实现 `IosRemoteDriver` + `IosMobileController`，驱动登录流程，并探测 `Agent.init`。
- Python 使用 `artemis/.venv/bin/python`，不连真实设备/Appium/LLM。

## 结果

### 通过：设备驱动/控制器接缝

`IosRemoteDriver` 通过 fake RPC 完成了：

- `initialize` → `screen` → 找到「账号」「密码」「登录」
- 点击账号 → `inputText("spike-user")`
- 点击密码 → `inputText("spike-pass")`
- 点击登录 → 第二屏出现「登录成功」
- `openUrl("https://example.com/spike")`
- `go_back()` 返回 `unsupported-on-ios`
- `shutdown`

关键验证：

- 元素 bounds 是像素（`[200,800][400,880]`），`BaseDeviceDriver.find_element` 返回像素中心 `(300,840)`。
- `IosRemoteDriver.tap` 按 scale=2 转成逻辑点 `(150,420)`，fake RPC 正确命中登录按钮。
- 通用 `UnifiedMobileControllerBase` 的 `tap_element` / `type_text` 不需要改。
- `open_url` / `erase_text` / `go_back` 必须由 iOS controller 覆盖；通用实现里有 `am start` / `input keyevent`。

### 阻塞：ARTEMIS `Agent.init` 仍是 Android-only

探测结果：

```json
{
  "ok": false,
  "error": "DevicePlatform.IOS is missing in third_party/mobile_use; Agent.init also forces DevicePlatform.ANDROID when device_id is passed"
}
```

具体发现：

1. `third_party/mobile_use/context.py` 的 `DevicePlatform` 只有 `ANDROID`，没有 `IOS`。
2. `artemis/sdk/agent.py` 的 `Agent.init` 在收到 `device_id` 时强制写 `device_platform = DevicePlatform.ANDROID`。
3. `_init_internal` 在非 cloud 模式下先检查 `which("adb")`，再 `_init_clients` / `_get_device_context`；这些路径都默认 ADB。
4. `artemis/mcp/adb_server.py::_get_controller` 默认 `adb.device_list()`，没有 iOS 分支。
5. `UnifiedMobileController` 的 `open_url` / `erase_text` / `go_back` 使用 Android shell；需要 iOS controller 覆盖。

## 结论

**条件性 Go。**

- 设备驱动/控制器层可行，坐标换算和通用 controller 行为已验证。
- ARTEMIS agent core 的 **planner/operator 不需要改**，但 **Agent.init / DevicePlatform / context / factory / MCP controller** 需要一小层 iOS 平台分支。
- 现在不应该直接建完整 Node device service；下一步应先做一个 **ARTEMIS 平台接缝 patch spike**：
  1. 给 `DevicePlatform` 加 `IOS`；
  2. `Agent.init` 按 platform 分支，iOS 跳过 `which("adb")` / ADB clients，注入 `IosRemoteDriver` 或 controller；
  3. `_get_controller` 支持 iOS UDID + RPC URL；
  4. `UnifiedMobileController` 的 iOS 子类覆盖 `open_url` / `erase_text` / `go_back`；
  5. 用 fake LLM 跑通 `Agent.run_task` 的最小任务。
- 这个 patch spike 通过后，再进入设计文档的 Phase 1（正式 Node device service + 真机/Appium）。

## 产出

- `spikes/ios-artemis/fake_device_rpc.mjs`
- `spikes/ios-artemis/spike_controller.py`
- `spikes/ios-artemis/run-spike.mjs`
- 本报告

## Android 隐式依赖（初步清单，Phase 1 完整审计）

Spike 只验证到 `Agent.init` 的入口；以下位置已知或高度可疑，Phase 1 必须逐项确认“跳过 / 适配 / 不支持”：

- `third_party/mobile_use/context.py`：`DevicePlatform` 只有 `ANDROID`
- `artemis/sdk/agent.py`：`Agent.init` 强制 `ANDROID`；`_init_internal` 检查 `adb`、`_init_clients`、`_get_device_context`、`_ensure_device_unlocked`、`install_apk`、`clean`
- `artemis/mcp/adb_server.py`：`_get_controller` 默认 `adb.device_list()`
- `artemis/drivers/factory.py`：默认 `AndroidAdbDriver`
- `artemis/controllers/unified_controller.py`：`open_url`/`erase_text`/`go_back` 使用 Android shell
- `artemis/clients/screen_client_factory.py` + `runtime/helper_manager.py`：UIAutomator helper
- `runtime/awake_service.py` / `device_pool.py` / `device_lock.py`：ADB 设备发现/保活/锁
- `mcp_server/tools/`：diagnose、device_state、logcat、shell、video、app install
- `data_engine` / `trace_store`：需验证 UI tree/OCR 与 iOS trace 的兼容性

完整审计结论应在 Phase 1 第 0 步写入设计文档 §18.2，再决定是否继续。

## 未验证

- WDA/Appium 真实 source 结构、元素去重、OCR/AX 融合。
- `Agent.run_task` 完整执行（被 `DevicePlatform.IOS` 阻塞）。
- Pro planner/checker/notes 在 iOS 上的行为。
- 真实设备上的 session/取消/超时。
