# iOS ARTEMIS 同级执行器设计（AOS iOS Agent Runtime）

> 2026-11-05 · 状态：**设计完成 + Phase 0 Spike 完成；开发暂停**（等待 Android/P0b 真机稳定）  
> 关联：`DESIGN.md` §13.306（Web LLM 执行接线）、`docs/superpowers/specs/2026-11-04-llm-execution-design.md`（R10 v3）、`docs/superpowers/plans/2026-11-04-web-llm-ios.md`（P0b）、`artemis/artemis/drivers/base.py`、`src/ios/`。

## 0. 决策摘要

| # | 决策 | 结论 |
|---|---|---|
| D1 | iOS 是否重写一套 agent | **不重写**。保留 ARTEMIS Python agent core，iOS 只新增设备驱动/控制器。 |
| D2 | iOS 设备层放哪 | **Node iOS Device Service**（复用现有 Appium/WDA 代码），ARTEMIS 通过本机 JSON-RPC 调用；同一 UDID 的设备锁跨进程生效。 |
| D3 | 观察数据契约 | 归一化为 ARTEMIS 现有 `ScreenData` / `ui_elements` / Android 风格 `ui_hierarchy_xml`；ARTEMIS 边界统一用**截图像素坐标**，Appium 边界用**逻辑点**。 |
| D4 | L1 文本证据 | iOS 截图走 ARTEMIS 同一套 OCR（`perform_ocr`），与 AX 文本用 `fuse_ocr_with_xml` 合并；OCR key 缺失时显式降级，不宣称 L1 等价。 |
| D5 | Android-only 能力 | 通过 `DeviceCapabilities` 显式声明；工具注册和 prompt 裁剪；不支持时返回 typed `unsupported-on-ios`，不静默降级。 |
| D6 | 上线方式 | `AOS_IOS_AGENT_RUNTIME=node|artemis` 开关；先 shadow 对比，再切默认；Node executor 保留回滚。 |
| D7 | 安装 | **本设计不解决 `.ipa` 安装**；ARTEMIS iOS 路径只接受设备上已安装的 bundle id，`app_path` 显式拒绝；URL/安装走独立 gateway install 方案。 |

目标一句话：**让同一份 Excel/taskDesc 在 Android 和 iOS 上跑同一套 planner/operator/checker/工具/证据管线，只有设备原语不同。**

## 1. 背景

当前 Web LLM 执行分两条路：

- Android：中心 `web llm-worker` → ARTEMIS Python 子进程 → `mobile_run_task` → Planner/Operator/Checker/DataEngine/Trace。
- iOS：中心 `web llm-worker` → AOS Node iOS 执行器（`src/ios/run-loop.ts`）→ Appium/WDA → 自有单循环 + verifier。

两端已对齐结果契约（PASS/FAIL/UNVERIFIED、`summaryStatus`、L1 锚点、超时取消、token 契约、secret fail-closed），但**测试行为**仍不同：

- ARTEMIS 有 Planner、Checker、notes、history compression、data engine、explorer、Pro/Flash 分层；iOS 只有单循环。
- Android L1 文本来自截图 OCR；iOS 来自 Accessibility 文本，自定义绘制文本可能漏检。
- Android 工具集包含 shell/logcat/录屏等；iOS 没有对应能力，但当前没有统一的 capability 声明。
- Android 产出 `data_engine.db`；iOS 只有 `status.json`/`run.json`，证据结构不同。

结果就是：**同样的用例，两端可能走出不同步骤、采到不同证据、得到不同结论**，而不是 PASS/FAIL 规则本身不同。

## 2. 目标与非目标

### 2.1 目标

1. iOS 真机任务由 ARTEMIS agent core 执行，使用与 Android 相同的 planner/operator/checker/tools/data engine/trace。
2. 设备层只实现原语：观察、点击、滑动、输入、启动/终止、前台应用、弹窗、截图。
3. 观察数据归一化后，现有 hierarchy parser、OCR fusion、checker、prompt 不需要按平台分叉。
4. L1 文本证据统一为「OCR + AX 合并」，两端使用同一判定函数与同一文本通道。
5. 能力差异显式化：iOS 不支持的 Android-only 工具必须报错，不能返回假成功。
6. 远程 iOS 真机复用现有 SSH `-R` Appium 隧道；LLM key 与 secret 只在中心。
7. 结果、trace、token、失败分类、取消/超时进入与 Android 相同的契约。
8. 可在 fake Appium / fake RPC 上完整测试，不依赖真实设备。

### 2.2 非目标

- `.ipa` 安装、签名、版本管理、gateway `/install`。ARTEMIS iOS 路径不传 `app_path`；现有 Node P0b 路径可继续接受 HTTP(S) URL，直到安装方案独立落地。
- 远程 iOS 模拟器（模拟器仍只用于本机 Maestro/调试）。
- 替换 Android `AndroidAdbDriver`。
- ARTEMIS 上游重构、多实例 HA、WSS 隧道。
- 重新实现 ARTEMIS 的 planner/checker 到 TypeScript。

### 2.3 反目标

- 在 TypeScript 里继续扩一套 iOS agent，然后靠人工对齐行为。
- 把 Android-only 工具映射成 iOS no-op。
- 把 Accessibility 文本直接当成 OCR 证据。
- 把原始截图/secret 发给 LLM 或落盘。
- 用 summary 的 `passed>0` 直接判 PASS 而忽略未决项。

## 3. 约束与假设

- ARTEMIS 是 submodule（当前父仓库 pin `351ca84`）；下游改动以 `patches/artemis/*.patch` 分发，`npm run artemis:patch` 应用。
- 中心 `web llm-worker` 已能按 host 取 `web_runners.gateway.appiumUrl`，并通过 SSH `-R` 访问 runner Appium。
- iOS 真机由 Appium + XCUITest/WDA 驱动；iOS 18+ 需要 Remote XPC 隧道（由宿主维护）。
- Node 22+、TypeScript ESM + NodeNext + strict；测试运行 `dist/`。
- ARTEMIS 的坐标契约是**物理像素**；Appium XCUITest 的 tap/rect 是**逻辑点**。
- 没有真实设备时，所有验收必须能在 fake Appium / fake RPC 上完成。
- 本设计假设 iOS Appium 可返回 page source、screenshot、activeAppInfo；若某个 WDA 版本不支持，按 capability 降级并显式写 warning。
- OCR 采用可插拔 provider；Android 与 iOS 必须使用同一个 provider，否则 L1 文本不可比。Google Vision 只是其中一个选项，不强制。
- iOS web LLM 的 UDID 互斥必须跨进程：Node executor、device service、`mobile_get_device_state` 不能同时开同一台设备的 WDA session。

## 4. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│ 中心 web llm-worker                                           │
│  - 领取 executionMode=llm job                                 │
│  - 按 host 取 gateway.appiumUrl                               │
│  - 准备 secret / Excel / package                              │
│  - 启动 ARTEMIS Python 子进程（AOS_LLM_HOOKS=1）              │
└──────────────────────────────┬───────────────────────────────┘
                               │ mobile_run_task(task_desc, device_serial=UDID, ...)
┌──────────────────────────────▼───────────────────────────────┐
│ ARTEMIS (Python, 中心)                                        │
│  Planner / Operator / Checker / Explorer / DataEngine / Trace │
│  BaseDeviceDriver                                             │
│        │                                                      │
│  IosRemoteDriver（薄 RPC 客户端）                              │
└────────┼─────────────────────────────────────────────────────┘
         │ JSON-RPC 2.0 over loopback HTTP
┌────────▼─────────────────────────────────────────────────────┐
│ AOS iOS Device Service (Node, 中心)                           │
│  - 复用 src/ios/appium（AppiumClient / SessionManager）        │
│  - 观察归一化、坐标换算、能力声明、错误映射                    │
│  - 跨进程 UDID 锁；不持久化原始截图                              │
│  - 不调用 LLM、不持有 key、不解析 taskDesc                     │
└────────┼─────────────────────────────────────────────────────┘
         │ Appium HTTP（现有 SSH -R 隧道）
┌────────▼─────────────────────────────────────────────────────┐
│ iPhone 真机（runner 侧）                                       │
└──────────────────────────────────────────────────────────────┘
```

### 4.1 为什么不是其它方案

| 方案 | 结论 | 原因 |
|---|---|---|
| A. Python 直接写 Appium driver | 可行但不选 | 需要把 Appium/WDA 会话、重试、截图、元素解析在 Python 再写一遍，和 `src/ios` 重复。 |
| **B. Python 薄 driver + Node 设备服务** | **选此** | agent core 不变；设备层复用现有 TS 实现；RPC 契约可测。 |
| C. 继续扩 TS iOS executor | 不选 | planner/checker/data engine 要重写，长期必然漂移。 |
| D. 把 ARTEMIS 翻成 TS | 不选 | 工作量最大，失去 Python hooks 与现有 agent 资产。 |
| E. 只用 Maestro/XCUITest | 不选 | 没有自适应 agent、证据与 checker。 |

## 5. 组件设计

### 5.1 `IosRemoteDriver`（Python，ARTEMIS 侧）

实现 `artemis.drivers.base.BaseDeviceDriver`，只做协议转换：

- `device_id`：iOS UDID。
- `screen_size`：来自 `initialize` 的物理像素尺寸。
- `connect/disconnect`：创建/关闭 RPC session；不直接连 Appium。
- `get_screen_data`：调用 `screen`，把归一化元素转换为 `ScreenData`。
- `tap/long_press/swipe/swipe_direction`：像素坐标，本地除以 `scale` 后调用 RPC 的逻辑点坐标。
- `input_text`：调用 `inputText`；是否清空由参数决定。
- `press_key`：home/enter/delete 映射；`back` 由 capability 拒绝。
- `launch_app/stop_app`：bundle id。
- `get_current_package`：`currentApp`。
- `execute_shell`：抛 `UnsupportedOnIosError`；driver 只连 device RPC，不读 `AOS_APPIUM_URL`。
- `start_video_recording/stop_video_recording`：可选；不支持时抛 typed error。
- `find_element` 使用基类默认实现（依赖 `ui_elements` 的 `text`/`content-desc`/`bounds`）。

建议放在独立包 `aos_ios_driver`，只对 ARTEMIS factory 打一个小 patch；避免把整个 driver 写进上游 submodule。

### 5.2 `IosMobileController`（Python）

继承 `UnifiedMobileController`，覆盖 Android-specific 的通用方法：

- `open_url`：调用 RPC `openUrl`（WDA deep link），不再拼 `am start`。
- `erase_text`：调用 RPC `eraseText`（WDA select-all + delete），不再拼 `input keyevent`。
- `go_back`：iOS 无系统返回键，返回 `unsupported-on-ios`；prompt 里也明确提示。
- `press_enter` / `go_home`：映射 `pressKey`。
- `take_screenshot`：使用 `ScreenData.screenshot_base64`。

### 5.3 AOS iOS Device Service（Node，中心）

复用现有 `src/ios/appium/`：

- `AppiumClient`：HTTP 调用。
- `SessionManager`：同 UDID FIFO、session 复用/过期。
- `makeWdaDevice` / `IosDevice`：tap/swipe/input/nodes/screenshot/size/alerts。
- 新增 `src/ios/device-service/`：
  - `server.ts`：JSON-RPC HTTP server，loopback。
  - `session.ts`：RPC session → Appium session 的映射与 TTL。
  - `lock.ts`：跨进程 UDID 锁（pid + mtime + TTL；Node executor 共用）。
  - `observe.ts`：WDA source → 归一化 elements + Android 风格 XML。
  - `coords.ts`：像素/逻辑点换算。
  - `capabilities.ts`：iOS 能力表。
- 可以嵌入 `web llm-worker` 启动（懒启动），也可独立命令：

```bash
node dist/cli.js ios-device-service --port 15100 --appium-url http://127.0.0.1:15038
```

默认绑定 `127.0.0.1`；`AOS_IOS_DEVICE_RPC_TOKEN` 可选，设置后要求 `Authorization: Bearer`。

设备服务**不**：
- 不读取 Excel/taskDesc。
- 不调用 LLM。
- 不持有 LLM key。
- 不写项目 trace（trace 由 ARTEMIS 写）。
- 不记录 action 参数（可能含 secret）。

### 5.4 路由与 Runtime

- `AOS_IOS_AGENT_RUNTIME=node`（默认，过渡期）：保持当前 P0b 路径。
- `AOS_IOS_AGENT_RUNTIME=artemis`：`Runtime.maybeIosCall("mobile_run_task")` 不再拦截 iOS UDID，交给 ARTEMIS 子进程。Node executor 与 device service 共用 UDID 锁；切换期间不允许并发跑同一台设备。
- ARTEMIS 子进程环境注入：
  - `AOS_IOS_DEVICE_RPC_URL`
  - `AOS_IOS_DEVICE_RPC_TOKEN`（可选）
  - `ARTEMIS_MOBILE_PLATFORM=ios`（或 `ARTEMIS_IOS_UDID`）
  - **不注入 `AOS_APPIUM_URL`**：Appium URL 由 worker 在 `initialize` 时传给 device service，避免服务级默认值选错 host。
- `mobile_run_task` 参数：
  - `device_serial`: iOS UDID。
  - `locked_app_package`: bundle id（设备已安装）。
  - `app_path`: ARTEMIS iOS 路径**显式拒绝**（`unsupported-on-ios:app-install`）；安装走独立工作流。
  - `model`: Flash/Pro 继续有效。
  - `verification_level` / `explorer_mode`: 继续有效，由 ARTEMIS 解释。
- `mobile_manage_task` / `mobile_inspect_trace`：继续由 ARTEMIS 处理；AOS 只做响应归一化。

## 6. 设备 RPC 契约

### 6.1 传输

- JSON-RPC 2.0 over HTTP/1.1，`POST /rpc`。
- 默认 `127.0.0.1:15100`（`AOS_IOS_DEVICE_RPC_PORT`）。
- 请求：`{ "jsonrpc":"2.0", "id":"<uuid>", "method":"screen", "params":{...} }`
- 响应：`{ "jsonrpc":"2.0", "id":"<uuid>", "result":{...} }` 或 `{ "error": { "code": "...", "message": "...", "data": {...} } }`
- 超时：观察/动作默认 30s；启动/安装 120s。
- 所有 session 方法必须带 `sessionId`。

### 6.2 方法

| 方法 | 参数 | 返回 |
|---|---|---|
| `initialize` | `{udid, appiumUrl, bundleId?, signing?, appium?}` | `{sessionId, info}` |
| `shutdown` | `{sessionId}` | `{ok}` |
| `info` | `{sessionId}` | `DeviceInfo` |
| `screen` | `{sessionId, includeSource?, includeScreenshot?}` | `Observation` |
| `tap` | `{sessionId, x, y, durationMs?, times?}` | `{ok}` |
| `longPress` | `{sessionId, x, y, durationMs?}` | `{ok}` |
| `swipe` | `{sessionId, x1, y1, x2, y2, durationMs?}` | `{ok}` |
| `swipeDirection` | `{sessionId, direction, durationMs?}` | `{ok}` |
| `inputText` | `{sessionId, text, clearExisting?}` | `{ok, mode}` |
| `pressKey` | `{sessionId, key}` | `{ok}` |
| `launchApp` | `{sessionId, bundleId}` | `{ok}` |
| `terminateApp` | `{sessionId, bundleId}` | `{ok}` |
| `openUrl` | `{sessionId, url}` | `{ok}` |
| `currentApp` | `{sessionId}` | `{bundleId}` |
| `alerts` | `{sessionId, action}` | `{handled, tapped}` |
| `eraseText` | `{sessionId, chars?}` | `{ok}` |
| `startRecording` / `stopRecording` | `{sessionId}` | `{path?}` |
| `health` | `{}` | `{ok, appium, devices}` |
| `lock` / `unlock` | `{udid, owner, ttlMs}` | `{acquired}` / `{released}` |

坐标约定：**RPC 边界用逻辑点**（与 Appium 一致）；`IosRemoteDriver` 负责像素↔点换算。`Observation` 同时给出 `widthPx/heightPx/scale`，元素 `bounds` 用像素。`initialize` 的 `signing`（`orgId`/`signingId`/`wdaBundleId`）与 `appium`（超时/重试）由 worker 按项目与环境解析后显式传入，device service 不读项目 `.env`。

### 6.3 Observation

```json
{
  "widthPx": 1170,
  "heightPx": 2532,
  "scale": 3,
  "orientation": "portrait",
  "bundleId": "com.example.app",
  "elements": [
    {
      "type": "XCUIElementTypeButton",
      "text": "登录",
      "value": "",
      "resource_id": "login",
      "bounds": [30, 120, 300, 180],
      "parsed_bounds": { "left": 30, "top": 120, "right": 300, "bottom": 180 },
      "enabled": true,
      "visible": true,
      "focused": false,
      "children": []
    }
  ],
  "hierarchyXml": "<hierarchy>...</hierarchy>",
  "screenshotBase64": "iVBORw0KGgo...",
  "screenshotPath": null,
  "alerts": []
}
```

- `elements` 必须是**扁平或树形均可**，但每个元素都要有 `bounds` 字符串或 `parsed_bounds`；`text`/`value`/`resource_id` 与 Android 字段对齐。
- `hierarchyXml` 生成 Android 兼容 XML：
  - `<node class="..." text="..." content-desc="..." resource-id="..." package="..." bounds="[l,t][r,b]" enabled="true" visible="true">`
  - 根节点带 `package`（bundle id）与屏幕宽高。
- 同一元素去重：相同 `bounds+text+resource_id` 只留一个；优先保留可点击/有 accessibility 的叶子。
- 默认只给 `screenshotBase64`；`screenshotPath` 仅 `AOS_IOS_DEVICE_SCREENSHOT_MODE=file` 时出现，临时文件 0600、session 关闭即删。不把未脱敏截图长期留在 `.artemis/ios-device/`。

### 6.4 错误码

| code | 含义 | ARTEMIS 映射 |
|---|---|---|
| `device-unavailable` | 设备断开/UDID 不存在 | 任务 failed，`ios-device-unavailable` |
| `appium-unavailable` | Appium `/status` 不健康 | `ios-appium-unavailable` |
| `session-busy` | 同 UDID 已有任务 | 排队或 `device-busy` |
| `session-expired` | session 超时 | 重连一次，再失败 |
| `wda-unavailable` | WDA 未就绪/隧道断 | `ios-wda-unavailable` |
| `unsupported-on-ios` | 调用了 Android-only 能力 | 工具层返回明确错误 |
| `invalid-coordinate` | 坐标越界/NaN | 动作失败，不点击 |
| `timeout` | 动作/观察超时 | 重试一次，再失败 |
| `internal` | 未分类 | 任务 failed，保留堆栈 |

## 7. 观察、OCR 与 L1 一致性

### 7.1 文本通道与 OCR provider

iOS 有两个文本来源：

1. **Accessibility 文本**：`label` / `value` / `identifier`。
2. **截图 OCR**：同一个 OCR provider 对 iOS/Android 截图识别。

OCR 不绑定 Google Vision，设计为 provider 抽象：

```ts
interface OcrProvider {
  name: string;
  available(): Promise<boolean>;
  recognize(png: Buffer, opts?: { lang?: string }): Promise<Array<{
    text: string;
    position: Array<{ x: number; y: number }>;
  }>>;
}
```

可选 provider：

| provider | 类型 | 优点 | 代价/约束 |
|---|---|---|---|
| `google-vision` | 云 API | 现有 ARTEMIS 已支持；中英识别稳定 | 需要 key、按量计费、图片出网 |
| `azure-vision` | 云 API | 企业合规选项多；中文支持好 | 需要 endpoint/key、出网 |
| `baidu-ocr` / `tencent-ocr` / `aliyun-ocr` | 云 API | 国内网络与中文场景友好 | 需要厂商 key/签名；出网 |
| `rapidocr` | 本地 ONNX | 无外部 key、跨平台、中文/英文、CPU 可跑 | 需要安装模型依赖；准确率需用 UI 截图校准 |
| `paddleocr` | 本地 Python | 中文强、可离线 | 依赖重、模型体积大、启动慢 |
| `apple-vision` | 本地 macOS | 无外部 key、系统级中文识别 | 只能跑在 macOS；要求中心或 runner 是 macOS；跨端一致性需 Android 也走同一 provider |

默认策略 `AOS_OCR_PROVIDER=auto`：

1. 显式配置的 provider；
2. 有 Google Vision key → `google-vision`；
3. 有 Azure/Baidu/Tencent/Aliyun key → 对应 provider；
4. 安装了 `rapidocr` → `rapidocr`；
5. 都没有 → AX-only，写 `ios-ocr-degraded` / `ocr-unavailable`，不宣称 L1 等价。

配置建议：

- `AOS_OCR_PROVIDER=auto|google-vision|azure-vision|baidu-ocr|tencent-ocr|aliyun-ocr|rapidocr|paddleocr|apple-vision|off`
- `OCR_API_KEY` / `VISION_API_KEY`（沿用 ARTEMIS 约定）
- `AOS_OCR_ENDPOINT`、`AOS_OCR_API_KEY`（云厂商）
- `AOS_OCR_LANG=zh-Hans,en`
- `AOS_OCR_TIMEOUT_MS`（默认 15s）
- `doctor` / `aos_status` 显示 provider、available、最近错误。

对齐 Android 的做法：

- 观察时把 AX 文本写入 `ui_elements` 的 `text`/`content-desc`。
- 对截图执行**同一 provider**的 OCR；provider 输出归一化为 `{text, position}`，`fuse_ocr_with_xml` 无需改动。
- 用 `fuse_ocr_with_xml` 把 OCR 结果与归一化 XML 融合；iOS 的 `hierarchyXml` 已是 Android 兼容结构。
- L1 从融合后的文本通道取标签，而不是单独从 AX 取。
- OCR 失败/未配置：降级为 AX，并在 trace/状态中写 `ios-ocr-degraded` warning；不能静默假装 OCR 成功。
- **禁止 Android 用 Google Vision、iOS 用 Apple Vision** 这类混用；provider 必须项目级统一，否则跨端 L1 不可比。

建议：先用 `auto`，有现成 Google Vision key 就复用；没有 key 时用 `rapidocr` 做离线基线。Phase 2 用一组真实 UI 截图比较 `google-vision` 与 `rapidocr` 的中文/数字/小字号命中率，再定长期默认。

### 7.2 证据与 trace

Android 已有 `data_engine.db` + `status.json`。iOS ARTEMIS 路径目标：

- `status.json`：必须。
- `data_engine.db`：P1 目标；先验证 DataEngine 能接受 iOS 截图/层级/OCR，再把它变成 iOS LLM 的必需工件。
- `run.json`：ARTEMIS 原生 trace；若与 AOS iOS 现有 `run.json` 结构不同，AOS 结果适配层按平台读取，不强行合并。
- **执行器标记**：trace 目录写 `meta.json` / `status.json` 字段 `executor: "ios-artemis" | "ios-node"`；AOS ingest、`mobile_inspect_trace`、面板、`suite` 按标记选 reader，并兼容无标记的旧 Node trace。回滚不迁移数据。
- 截图：写入 ARTEMIS trace 目录；Python hooks 在写盘前脱敏。

### 7.3 判定

- `test_summary`、checker、L1、L2、L3 由 ARTEMIS 产生，**ARTEMIS summary 是主判据**；AOS `checkExpectedTexts` 只在 ARTEMIS 证据不可用时兜底。
- 两边都有结论且不一致时：记录 `l1-disagreement`，降级 `UNVERIFIED`，不静默取其中一个。
- 失败分类映射：
  - `device-unavailable` / `appium-unavailable` / `wda-unavailable` → 环境失败。
  - `unsupported-on-ios` → 用例/工具能力问题，不判应用缺陷。
  - checker 失败 → 应用/行为失败。
- 无 L1/L2 → `UNVERIFIED`；summary 有未决项 → 不判 PASS（与现有 `summaryStatus` 一致）。

## 8. 能力模型

### 8.1 `DeviceCapabilities`

```ts
interface DeviceCapabilities {
  platform: "ios";
  back: false;
  home: true;
  shell: false;
  systemLogs: "none"; // v1 不做宿主日志通道；后续单独加 runner log RPC
  video: "appium" | "none";
  alerts: true;
  appLaunch: true;
  appInstall: false; // 本设计外
  ocr: "artemis" | "none";
  orientation: boolean;
}
```

### 8.2 工具与 prompt

- 工具注册时按 capability 过滤：
  - `execute_shell`/`adb` 相关工具：iOS 不注册。
  - `press_key("back")`：注册但返回 `unsupported-on-ios`，或直接不暴露；建议不暴露，prompt 明确“iOS 无返回键”。
  - 系统日志：若宿主有 `idevicesyslog`，暴露只读日志工具；否则不暴露。
- `mobile_run_task` 的 rules/prompt 注入 iOS profile：
  - 用 bundle id，不是 package。
  - 无 back；用界面返回控件。
  - 输入非 ASCII 需要先聚焦输入框。
  - 不要调用 shell/adb。
- 模型调用未暴露工具时，工具层仍返回 typed error，防止旧 prompt 或幻觉调用。

## 9. 安全与脱敏

- LLM 调用只在 ARTEMIS；`AOS_LLM_HOOKS=1` 生效，现有 Python hooks 覆盖：
  - LLM message 文本/图片（H1）
  - 观察层 screenshot/hierarchy（H2）
  - 动作注入（H3）
  - storage/trace 写入（H4）
- Node device service：
  - 只处理设备原语，不解析 taskDesc，不调用 LLM。
  - 不持久化 action 参数；日志只记 method/session/UDID/耗时/状态。
  - 返回原始截图给 ARTEMIS；ARTEMIS hooks 负责发给模型/落盘前脱敏。
  - 如果未来设备服务下沉到 runner，RPC 必须走 SSH 隧道 + token，不裸暴露。
- secret：
  - `AOS_LLM_SECRET_FILE` 0600；ARTEMIS 在动作执行瞬间解析 `<secret:alias>`。
  - RPC action 可能携带已解析 secret；device service 必须内存处理、不落日志/不落盘。
  - 未绑定 account-like 文本在入口拒绝，两端一致。
- iOS 特有：
  - 文本输入走 `/keys` 或 WDA；不要用会回显明文的日志。
  - 系统弹窗/权限框的按钮文本也要脱敏后再进模型。

## 10. 部署与拓扑

### 10.1 第一版（中心设备服务）

- `web llm-worker` 启动时 lazy 启动 iOS Device Service（loopback）。
- ARTEMIS 子进程通过 `AOS_IOS_DEVICE_RPC_URL` 连接。
- Appium 仍在 runner，经现有 SSH `-R` 暴露到中心 loopback。
- 优点：改动小，复用现有 P0b 隧道；缺点：Appium 暴露在中心 loopback（已有现状）。

### 10.2 后续（runner 设备服务）

- 把 Node Device Service 下沉到 runner，Appium 只监听 runner 本机。
- 中心通过 SSH `-R` 只暴露 device RPC 端口。
- ARTEMIS driver 不变，只改 RPC URL。
- 适合多 runner、减少中心攻击面。

### 10.3 时序

1. worker 领取 iOS LLM job。
2. 读取 `web_runners.gateway.appiumUrl`、UDID、bundle id、secret。
3. 启动/复用 ARTEMIS 子进程，注入 device RPC URL 与 iOS 平台标记。
4. `mobile_run_task` → ARTEMIS planner → `IosRemoteDriver` → device RPC → Appium → iPhone。
5. 观察返回 → ARTEMIS OCR/fusion/checker → 下一步动作。
6. 终态 → status/trace/data_engine → AOS ingest → Excel/门禁。
7. 关闭/释放 session 与设备租约。

## 11. 实施计划

### Phase 0：Spike（2–3 天，throwaway）

用户已确认“先探索，功能稳定后再开展”。Spike 只验证架构可行性，不进入生产代码，不承诺测试覆盖。

- 用 fake Appium 返回固定 source/screenshot（一个登录页 + 一个成功页）。
- fake OpenAI-compatible LLM 返回脚本化动作，避免真实 token 成本。
- 实现最小 `screen`/`tap`/`swipe`/`inputText` RPC 与 `IosRemoteDriver` + controller shim。
- 让 ARTEMIS 现有 `mobile_run_task` 跑通一条“打开应用 → 输入 → 点击 → done”。
- 验证：
  - ARTEMIS agent core 不需要改 planner/operator；
  - 坐标 scale、截图、hierarchy 能被现有 checker 读取；
  - 每步 RPC 开销可接受（本地 loopback）。
- 产出：可行性报告（go/no-go）、需要 patch 的 ARTEMIS 文件清单、性能数据、未预期阻塞。
- **决策门**：Spike 报告通过后才进入 Phase 1；不通过则停止或改为 Python 直连 Appium 的备选方案。

### Phase 0 结果（2026-11-05）

Spike 已完成，报告：`spikes/ios-artemis/REPORT.md`。

- **通过**：`IosRemoteDriver` + `UnifiedMobileControllerBase` 完成登录流程；像素→逻辑点 scale 换算、元素查找、输入、点击、`openUrl`、`back` 拒绝均符合预期。
- **阻塞**：`Agent.init` 仍是 Android-only：
  - `DevicePlatform` 没有 `IOS`；
  - `Agent.init` 强制 `DevicePlatform.ANDROID`；
  - `_init_internal` 检查 `adb` + 初始化 ADB clients；
  - `_get_controller` 默认 `adb.device_list()`。
- **结论**：planner/operator 不改，但 `DevicePlatform` / `Agent.init` / context / factory / MCP controller 需要一小层 iOS 平台分支。

### Phase 1：MVP（1–2 周）

先做 **ARTEMIS 平台接缝 patch spike**，再做 Node Device Service：

1. `third_party/mobile_use` 增加 `DevicePlatform.IOS`；
2. `Agent.init` 按 platform 分支，iOS 跳过 `which("adb")` / ADB clients，注入 `IosRemoteDriver` 或 controller；
3. `_get_controller` 支持 iOS UDID + RPC URL；
4. `IosMobileController` 覆盖 `open_url`/`erase_text`/`go_back`；
5. 用 fake LLM + fake RPC 跑通 `Agent.run_task` 最小任务；
6. 通过后再建正式 Node Device Service（`initialize`/`info`/`screen`/`tap`/`longPress`/`swipe`/`inputText`/`pressKey`/`launchApp`/`terminateApp`/`currentApp`/`alerts`）；
7. AOS routing flag + ARTEMIS env 注入；
8. status.json/run.json 落盘；AOS 结果适配层能读；
9. fake Appium + fake RPC 单测。

### Phase 2：证据与行为对齐（2–3 周）

- WDA source → Android 兼容 XML/elements。
- OCR + AX 融合；`ios-ocr-degraded` 降级。
- `data_engine.db` 生成与校验；token usage 从 ARTEMIS 读取。
- capability 表、工具过滤、prompt/rules。
- 跨端 golden tests：同一 observation fixture 在 Android/iOS driver 上产出相同 `ui_elements`/文本/L1。
- 失败分类、取消/超时、session 冲突。

### Phase 3：真机硬化（1–2 周）

- 真实 iPhone + Appium/WDA（含 Remote XPC 隧道）。
- 多设备/同 UDID 并发、session 过期、App 前后台切换。
- 弹窗/权限/键盘/滚动边界。
- 真机验收：登录、列表滚动、表单校验、错误弹窗、取消/超时。

### Phase 4：切换与清理（3–5 天）

- shadow 模式：**不并发跑同一台设备**。同一 iOS job 先跑生产 executor，再在同一设备上复位/重装后跑另一 executor（sequential A/B），只记录差异不写回；或使用录制的 observation/action 流离线回放。并发 shadow 在单设备上不可行，不纳入计划。
- 指标达标后 `AOS_IOS_AGENT_RUNTIME=artemis` 默认。
- Node iOS executor 保留用于本地模拟器/回滚。
- 文档、DESIGN、AGENTS 更新。

## 12. 测试与验收

### 12.1 单元/契约

- RPC schema、错误码、超时、token。
- 坐标换算：3x 屏、横屏、不同 WDA scale。
- WDA source → elements/XML：文本、bounds、重复节点、系统弹窗。
- OCR 融合：AX 有/OCR 有/两者都有/两者都无。
- capability：不支持工具返回 typed error，不 no-op。
- secret：action 日志/错误/trace 0 命中。

### 12.2 跨端一致性

- 同一 observation fixture：
  - Android driver 与 iOS driver 产出相同字段的 `ui_elements`。
  - L1 文本集合一致（允许顺序差异）。
  - `summaryStatus`/checker 结论一致。
- 同一 taskDesc 在 fake 两端跑：
  - 步骤数、工具调用序列、失败分类可比对。
  - 差异必须能归因到 capability 或设备行为，而不是 agent 逻辑。
- 真实设备 golden set：登录、滚动、弹窗、表单、网络错误。

### 12.3 验收标准

1. ARTEMIS `mobile_run_task` 在 iOS 真机上完成一条任务，planner/operator 代码无平台分支。
2. iOS 产出 `status.json`，Phase 2 后产出 `data_engine.db`。
3. 截图 OCR + AX 融合后的文本能命中 Android 同样的 L1 预期。
4. iOS 不支持的工具返回 `unsupported-on-ios`，没有假成功。
5. 同一 golden case 在两端结论一致；差异有明确 `failureReason`。
6. LLM prompt、trace、run/status、日志中 secret grep 0 命中。
7. `npm run build && npm test && npm run lint` 全绿；Python 单测通过。

## 13. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| ARTEMIS 内部大量 Android 假设 | 工具静默 no-op | capability 表 + 工具过滤 + typed error；先跑工具清单审计 |
| `Agent.init`/`DevicePlatform` Android-only | iOS 无法启动 agent | Phase 1 先做平台接缝 patch spike；不先建完整设备服务 |
| WDA source 慢/大 | 每步延迟高 | 裁剪、缓存、超时、只取可见节点；必要时走截图视觉 |
| 坐标 scale 错 | 点击偏、遮罩错 | RPC 边界明确像素/点；单测覆盖 2x/3x/横屏 |
| OCR 成本/准确率 | L1 不稳 | 只在关键帧 OCR；AX 优先；融合去重；失败显式降级 |
| OCR key 缺失 | iOS 退化为 AX | `ios-ocr-degraded` warning；L1 仍可用 AX；不假装 OCR |
| Appium session 冲突 | 任务失败 | 同 UDID FIFO、session TTL、busy 错误 |
| ARTEMIS submodule 维护 | 上游更新冲突 | driver 独立包 + 小 patch；`npm run artemis:patch` 重放；版本守卫 |
| 设备服务在中心 | 攻击面/延迟 | 第一版 loopback + token；后续下沉 runner |
| 安装未解决 | 无法跑新包 | 独立 gateway install；本设计只接受预装/URL |

## 14. 迁移与回滚

- 开关：`AOS_IOS_AGENT_RUNTIME=node|artemis`，默认 `node`。
- Shadow：`AOS_IOS_AGENT_SHADOW=1` 时同一 job 额外跑 ARTEMIS，记录步骤/证据/结论差异，不写回 Excel。
- 切换条件（默认门禁，可由负责人调整）：
  - fake 跨端 golden tests 全绿；
  - 真实设备 5 条 golden case（登录、列表滚动、弹窗、表单校验、空/网络错误）各跑 3 次，结论一致率 ≥ 90%；
  - L1 文本覆盖：同一 OCR provider 下，iOS OCR+AX 能覆盖 Android 同一预期锚点的比例 ≥ 95%；
  - 无 secret 泄漏（prompt/trace/run/status/日志 grep 0）；
  - 观察 P95 ≤ 2.5s/步（不含 OCR），OCR P95 ≤ 3s/帧；
  - `unsupported-on-ios` 不出现假成功。
- 回滚：切回 `node`，无需数据迁移；iOS ARTEMIS 的 trace 保留但不再读取。
- 观测指标：任务成功率、L1 命中率、OCR 降级率、unsupported tool 次数、每步延迟、token/用例、session 冲突率；golden set 与阈值由测试负责人固定后再进入 Phase 4。

## 15. 已确认与剩余问题

已确认：
- **真实设备资源可随时提供**（至少一台 iOS 18+ 真机 + macOS runner + WDA 隧道），Phase 3 可在 Spike/Phase 1 后安排。
- **OCR 不强制 Google Vision**；采用 provider 抽象，项目级统一 provider。Phase 2 先比较 Google Vision 与本地 RapidOCR，再定长期默认。
- **先探索、后开展**：Phase 0 Spike 通过决策门后才进入正式实现；Spike 为 throwaway，不污染生产代码。
- `data_engine.db`：Phase 2 目标，Phase 1 不阻断。
- golden set：默认由测试负责人签字；文档已给出建议集合。

剩余问题（不阻塞 Spike）：
1. **长期 OCR provider**：在有 Google Vision key 的情况下，是继续用云 API，还是优先本地 RapidOCR 以去掉外部依赖和按量成本？
2. **golden set 内容确认**：登录、列表滚动、弹窗、表单校验、空/网络错误这 5 条是否覆盖你们的核心业务？需要替换哪条？

已在本设计内定：
- 设备服务第一版中心 loopback，后续可下沉 runner。
- `back` 不暴露；`systemLogs` v1 为 `none`。
- `app_path` 在 ARTEMIS iOS 路径拒绝。
- shadow 不做同设备并发，改 sequential A/B + 离线回放。
- UDID 锁跨进程；原始截图不长期落盘。
- ARTEMIS summary 为主判据，AOS L1 只兜底；冲突降级 UNVERIFIED。

## 16. 开放的实现选择（builder 可决定）

- JSON-RPC vs 简单 REST：默认 JSON-RPC 2.0，错误码统一。
- screenshot 默认 base64；file 模式只用于显式优化，必须 0600 + 会话结束删除。
- OCR provider 默认 `auto`：有云 key 用云，无 key 用 `rapidocr`；长期默认由 Phase 2 样本校准决定。
- driver 放独立 Python 包还是 ARTEMIS patch：优先独立包 + 小 factory patch。
- OCR 是否缓存：按 screenshot sha256 缓存，默认开启。
- 观测缓存：同一步内 `screen` 结果可复用，跨动作不缓存。

---

**一句话总结**：iOS 不再维护第二套 agent；把 iOS 做成 ARTEMIS 的 `BaseDeviceDriver` 后端，用 Node 设备服务复用现有 Appium/WDA 能力，用同一套 OCR/checker/trace 产出证据。这样 Android 和 iOS 的差异只剩设备原语和显式 capability，而不是测试行为。

## 17. 当前状态与恢复条件（2026-11-05）

**状态：暂停开发。**

已完成：

- 架构设计、接口、能力矩阵、OCR provider、部署/测试/回滚方案；
- Phase 0 throwaway Spike（`spikes/ios-artemis/REPORT.md`）：
  - `IosRemoteDriver` + `UnifiedMobileControllerBase` 登录流程通过；
  - 像素→逻辑点 scale 换算通过；
  - 发现 `Agent.init`/`DevicePlatform` 仍是 Android-only。

暂停原因：

- 当前优先级是 Android 远程 LLM 与 iOS P0b 的真机稳定；
- iOS ARTEMIS 平台的下一步需要改动 ARTEMIS 的 `DevicePlatform`/`Agent.init`/controller 工厂，属于正式实现前置，不在“探索”阶段继续。

恢复条件（全部满足后再启动 Phase 1）：

1. Android 远程 LLM P0 真机端到端通过；
2. iOS P0b 真机验收通过（Appium 隧道、bounds 样本、`.ipa`/预装、登录页脱敏、Excel 写回）；
3. 确认长期 OCR provider（云 API 或本地 RapidOCR）与成本；
4. 重新评审 Phase 1 的 ARTEMIS 平台接缝 patch 范围；
5. 真实设备与 macOS runner 档期确认（已确认可随时提供，仍需排期）。

暂停期间不做：

- 不修改 ARTEMIS submodule 的 `DevicePlatform`/`Agent.init`；
- 不新增 Node device service 生产代码；
- 不添加 `AOS_IOS_AGENT_RUNTIME` 路由开关；
- 不改变现有 iOS P0b 与 Android 行为。

恢复时的第一步：

> 只做 **ARTEMIS 平台接缝 patch spike**：`DevicePlatform.IOS`、`Agent.init` 平台分支、`_get_controller` iOS 分支、iOS controller 覆盖，然后用 fake LLM + fake RPC 跑通 `Agent.run_task`。通过后再进入正式 Node device service。
