# iOS 适配方案（基于 ARTEMIS / AOS-ARTEMIS 架构）

> 状态：**v3 待评审 + P0 实测完成**（实测记录见附录 D）；**P2 slice 1–7 全部实施 + P3 slice 8/9 落地**——iOS 截图源、观察路由、动作层、`mobile_run_task` 执行器、视觉 fallback、trace 检查器、suite 闭环、崩溃取证；真机 UDID 识别已接入但未实测（见 DESIGN.md §13.41–§13.49）
> 日期：2026-10-05
> 关联：`DESIGN.md`（实施后更新）、`.scratch/` 诊断记录
> 修订记录：附录 A（第一轮）、B（第二轮）、C（第三轮 + council）。
> 前置结论：ARTEMIS 上游（google/artemis）仅支持 Android；iOS 适配是"替换设备与感知层"的扩展，不是改配置。

---

## 0. 结论摘要

- **可行**：Agent（Planner/Operator/Checker/Flash）、MCP 工具面、任务运行器、traces/notes/台账、LLM 路由与视觉引擎都可复用；新增 iOS 设备后端即可。
- **不另起独立 MCP server**：做进 AOS-ARTEMIS，保持与 Android 相同的工具名、schema、suite 用例格式与工具面。
- **成功标准（v3 修订）**：**同一套用例与工具面 + 证据链按平台能力对等**——不承诺"证据链完全相同"（Android 靠 logcat/crash buffer，iOS 靠 sysdiagnose/MetricKit/devicectl，形态结构性不同，见 §2.5）。
- **执行模型不变**：客户端主入口仍是 `mobile_run_task`；逐步操控工具只作 passthrough 给服务内子代理。
- **接口意图化 + 能力标志**：跨端接口表达意图，平台差异用 capability 降级，上层不写平台分支。
- **工具链（v3 修订）**：模拟器默认后端**不预设**——P0 用**双探针（idb vs WDA/XCUITest）**在同一模拟器对比后择一；`simctl` 始终作为零依赖兜底；真机候选顺序 idb → WDA 直连 → Appium（仅签名/会话）；`pymobiledevice3` 管真机隧道/日志。
- **坐标系显式约定（v3 新增）**：接口层统一 **logical point**，截图带 `scale`，任何从截图推导的坐标（视觉/OCR）必须换算后才可执行（见 §2.6）。
- **弹窗策略化 + 源头治理**：系统弹窗按 suite/case 规则按需拦截；模拟器优先用权限预授权把弹窗变环境噪音（见 §2.4）。
- **视觉一等公民但按档触发**：树 → OCR（Apple Vision 本地优先）→ 视觉；纯文本 active LLM 强制 fallback 专用视觉模型。
- **P0 = 可证伪 spike**：带定量 kill criteria；P0 的负面结论是决策输入，不是止损信号（见 §3）。
- **主要风险**：真机签名/配对、Xcode 大版本升级税（持续成本）、无 shell 的恢复语义、iOS 语义树质量、证据链能力差异。

---

## 1. 目标与非目标

**目标**

1. iOS 模拟器与真机的 UI 自动化（观察 → 决策 → 执行 → 验证闭环）；
2. 与 Android 共用：工具名/schema、`case-run` 用例 JSON、run.json 与截图证据、任务台账；
3. 路线分阶：确定性（D1）先行，智能（D2，ARTEMIS 代理）后置；
4. 感知可插拔：树优先、OCR 次之、视觉按需，模型选择对客户端透明；
5. **无 shell 约束从 D1 起就是一等约束**（不允许复制 Android 的 adb 式恢复捷径）。

**非目标**

1. 一步做到与 Android 功能完全对等（尤其证据链形态）；
2. 绕过 macOS/Xcode 工具链；不使用越狱手段；
3. 替代 Apple 官方构建/测试类 MCP，二者互补。

---

## 2. 架构

```
AI 客户端（Claude / Cursor / Agent）
        │  MCP（stdio / SSE）
        ▼
AOS-ARTEMIS MCP Server
  ├── 工具面（双端同名）
  │    ├── mobile_run_task(平台由项目/设备决定)     ← 客户端主入口
  │    ├── mobile_get_device_state（截图/层级；uri 契约见 §2.6）
  │    ├── analyze_screen（可选视觉；共用感知引擎；模型可配）
  │    └── mobile_* passthrough（给服务内子代理）
  ├── 任务运行器 / traces / notes / 台账（复用）
  └── 设备后端插件接口 DeviceBackend（+ capabilities）
        ├── Android：adb(+adb-safe) + accessibility helper   （现状）
        └── iOS：idb / WDA（P0 双探针后定默认）/ simctl（兜底）/ pymobiledevice3
```

### 2.1 统一设备抽象（意图语义 + 能力标志）

```ts
interface DeviceCapabilities {
  back: "system" | "gesture" | "none";     // Android: system；iOS: gesture/none
  keyboard: boolean;                        // 能否查询软键盘可见性
  alerts: "structured" | "none";            // 系统弹窗是否可结构化读取
  input: "direct" | "focus-required";       // 文本注入方式
  deepLink: boolean;                        // openUrl 支持
  permissionPreGrant: "simulator" | "none"; // 权限预授权（仅模拟器）
}

interface DeviceBackend {
  capabilities(): DeviceCapabilities;
  listDevices(): Promise<DeviceInfo[]>;
  install(app: string): Promise<void>;
  launch(bundleId: string, args?: string[]): Promise<void>;
  terminate(bundleId: string): Promise<void>;
  foregroundApp(): Promise<string | null>;
  openUrl(url: string): Promise<void>;                  // 深链/Universal Link
  screenshot(): Promise<{ data: Buffer; scale: number; logicalSize: Size }>;
  hierarchy(): Promise<UiNode[]>;
  tap(x: number, y: number): Promise<void>;             // logical point
  longPress(x: number, y: number, ms: number): Promise<void>;
  swipe(from: Point, to: Point, ms: number): Promise<void>;
  back(): Promise<void>;   // 仅平台原语（Android=keycode；iOS=左缘手势，单次、有界）；不可达返回结构化错误
  inputText(text: string): Promise<void>;  // 作用于“当前已聚焦元素”；聚焦是调用方职责
  pressHome(): Promise<void>;
  dismissKeyboard?(): Promise<void>;
  keyboardVisible?(): Promise<boolean>;
  grantPermission?(bundleId: string, service: string, mode: "grant" | "revoke" | "reset"): Promise<void>; // 仅模拟器
  alerts?(): Promise<AlertInfo[]>;
  acceptAlert?/dismissAlert?(index?): Promise<void>;
  logs(sinceMs?: number): Promise<string>;
}

interface UiNode {
  type: string;
  text: string;              // Android: text；iOS: label
  value: string;             // Android: text(输入态)/iOS: value —— 输入框断言核心（v3 提入核心）
  id: string;                // Android: resource-id；iOS: identifier
  desc: string;              // content-desc / accessibility label
  rect: Rect;                // logical point（§2.6）
  attrs: Record<string, string>;  // 平台扩展袋：traits/enabled/visible/checked/scrollable…
  children: UiNode[];
}
```

规则：

- **`back()` 只做平台原语**：单次手势/keycode，**不做树搜索与探索式点击**；失败返回结构化错误（`unsupported|unavailable`），树搜索式回退由上层（用例/Agent）编排（如 `tapText("返回")`），绝无静默坐标点击；
- `inputText` 不绑定目标元素；iOS 组合输入的前置校验由调用方通过 `keyboardVisible()` 完成；
- `case-run` 步骤词汇保持不变，由后端翻译。

### 2.2 iOS 设备层选型（v3：P0 双探针，不预设主力）

| 能力 | 候选 | 说明 |
|------|------|------|
| UI 树 / 动作 | **idb（`ui describe-all`/`ui tap`/`ui text`）** vs **WDA（XCUITest over HTTP）** | **P0 在同一模拟器双探针定量对比**（安装门槛 / describe 耗时 / tap 延迟 / 树质量 / 稳定性）后择一为默认 |
| 生命周期/安装/启动 | `simctl`（零依赖兜底，始终可用） | 模拟器生命周期正统；idb 亦可 |
| 截图/录屏 | idb `screenshot`/`record-video`、`simctl io` | 真机：WDA `/screenshot`、WDA MJPEG |
| 日志/崩溃 | `simctl spawn log` / `idevicesyslog` / `pymobiledevice3 syslog` | 崩溃见 §2.5 |
| 真机隧道/配对 | `pymobiledevice3`（iOS 17+ RemoteXPC） | libimobiledevice 补充 |
| WDA 构建/签名 | Appium XCUITest driver 或 `xcodebuild`（**仅工具链**） | 若 P0 选择 WDA 路线 |

事实校核（2026-10，已核对上游仓库）：

- idb 为 **MIT、活跃维护**（CI 持续、Swift 迁移中；构建要求 macOS 15+/Xcode 26+，需 doctor 检查并钉版本）——"维护名存实亡"的说法不成立；
- idb **模拟器免签名**；**真机仍需 Xcode 签名/设备信任**，需 P0 半天实测；
- idb 传输（gRPC/UDS）快于 HTTP，但**瓶颈在 XCTest/accessibility 查询本身**，"快几十倍"不成立；
- idb **不托管 WDA**；`simctl`/`pymobiledevice3` 是互补而非被替代；
- **Xcode 大版本升级税是持续成本**：idb/WDA/Appium 都随 Xcode 大版本跟进，按年度预算计入。

**P0 实测（2026-10-05，iPhone 17 Pro / iOS 26.5 模拟器；详见附录 D）**：idb 在模拟器上全面更快——label 定位+点击一步 516ms、坐标 tap 0.13–0.58s、nested 树 0.13–0.2s；WDA/Appium 对应为两步定位+点击 1.5–1.9s、source 0.4–0.9s。**结论：模拟器默认推荐 idb**，Appium/WDA 保留为弹窗结构化通道与真机候选。

### 2.3 感知策略（树 → OCR → 视觉）

1. **无障碍树优先**；
2. **OCR**：可见文本但树里没有（自绘/字体/图片文案）；**引擎优先 Apple Vision（`VNRecognizeTextRequest`，本地、中文可用、天然满足隐私要求）**，载体为 host 侧 Swift helper；不可用时回退既有 OCR API；
3. **视觉模型**：布局语义、图标含义、树与 OCR 都无法定位时；
4. **升档阈值（初值，P0 校准）**：树返回 **0 个可交互元素** 或 **文本覆盖率 < 10%** → 升 OCR；OCR 未命中目标 → 升视觉；每用例设**视觉调用预算**（初值 10 次）防失控；
5. **缓存与失效**：`frameHash = sha256(截图)` + 秒级 TTL 仅服务连续观察；**任何 mutating 动作（tap/input/swipe/back/openUrl）后立即失效**；
6. **模型选择与 fallback**：复用 AOS active LLM；**纯文本模型（如 DeepSeek-Chat）时视觉步骤必须 fallback 到配置的专用视觉模型**；preflight 做能力检查（与 Android `object_detector` 能力逻辑对齐）；支持本地模型开关；
7. **安全**：截图发外部模型前支持区域脱敏/本地模型策略。

### 2.4 系统弹窗策略（策略化 + 源头治理）

- **事实前提（P0 修正）**：iOS 系统弹窗归属 SpringBoard，**不在被测 App 的树里**；`idb ui describe-all` 描述的是**最前台窗口**——弹窗为前台时 idb **能看到**并用坐标点击关闭（实测 221ms），但此时 App 树被遮挡不可见；WDA/Appium 提供结构化 alert API（实测 `alert/text` 97ms、`alert/accept` 637ms）；idb 的 label(axbridge) 点击弹窗有动画竞态（element moved），需 label 重试 + 坐标兜底；
- **遗留弹窗会阻塞用例**（实测：Maps 小组件定位弹窗残留 → 设置页 start 检测失败）→ 观察/启动前必须执行**策略化清理**，规则随 suite/case 声明（`alerts.default: accept|dismiss`；case-run iOS 后端已实现）；
- **触发方式**：按需拦截（观察异常或 Agent 显式请求），不做每次观察前全量扫描；
- **规则**：suite/case 级 `alerts: { accept: [...], dismiss: [...], default: "keep" }`；默认 `keep`（首启权限弹窗可能是被测行为）；
- **源头治理**：模拟器用 `simctl privacy grant` 预授权（`capabilities.permissionPreGrant === "simulator"`），把可预见的弹窗变环境噪音；真机无等价能力，只能策略拦截或用例先行处理；
- 缺失结构化能力时降级为截图 + 视觉识别，标 `degraded`。

### 2.5 证据链能力矩阵（v3 新增，成功标准的一部分）

原则：**能力对等，不承诺形态相同**；每项标注"可用/降级/不可得"并落到 run.json。

| 证据 | Android（现状） | iOS 对应 | 对等性 |
|------|----------------|----------|--------|
| 步骤截图 | screencap | idb/WDA/simctl | ✅ 对等 |
| UI 层级 | uiautomator/helper XML | describe-all / WDA source | ✅ 对等（形态不同） |
| 应用日志 | logcat -T 窗口 | simctl log / idevicesyslog / syslog | ⚠️ 降级（无 `-T` 同语义窗口，需时间过滤） |
| 崩溃 | crash buffer + 签名去重 | `idevicecrashreport` / `simctl diagnose` / MetricKit（App 内） | ⚠️ 形态不同：无设备 crash buffer 等价物；首版采"崩溃上报文件 + syslog 关键字" |
| 任务轨迹 | traces/notes/data_engine | 复用（AOS 侧） | ✅ 对等 |
| 录屏 | scrcpy | simctl recordVideo / WDA MJPEG | ⚠️ 真机弱于 Android |

### 2.6 坐标系与度量约定（v3 新增）

- 接口层统一使用 **logical point**：iOS=point；Android=pixel（backend 负责与自身 px 的一致性）；
- `screenshot()` 必须返回 `{ data, scale, logicalSize }`，其中 `scale = 截图像素宽 ÷ logical 宽`（模拟器常为 2/3）;
- `rect`、`tap/longPress/swipe`、`output` 坐标一律 logical；**`analyze_screen` 的视觉输出也必须是 logical**（从截图像素推导后先 ÷scale）；
- `tapRel/swipeRel` 用 logicalSize 的比例，天然与 scale 无关；
- `mobile_get_device_state` 的截图返回 `uri`（**`file://` 或 `http(s)://` 由部署形态决定**；远端形态不可达时回退内联 image content），契约不绑定本机路径；
- **P0 验证项**：选一台 scale ≠ 1 的模拟器，断言 `截图像素 ÷ logical = scale` 且视觉/OCR → tap 的换算链路无偏移。

---

## 3. 分阶段路线（含粗估人日与 kill criteria）

### P0 — 可证伪 Spike（2–3 人日，模拟器为主 + 真机半天）

工作包（按优先级，超出时间盒时砍后两项）：

1. **双探针**：同一模拟器安装/使用 idb 与 WDA，产出对比表：安装门槛、`describe/source` 耗时、tap 延迟、树质量（节点/文本覆盖率）、连续 20 次动作稳定性；
2. **case-run 冒烟**：`--platform ios`（或后端探测）用**一条真实用例**（来自 starbuckstw mop-smoke）双端执行，暴露用例 schema 的 Android 式语义（resource-id/绝对坐标/adb 语义）；
3. **坐标系验证**：§2.6 的 scale≠1 断言；
4. **真机连通（半天）**：安装 + 启动 + 拉取崩溃日志（路径二选一记录）；
5. **弹窗/输入路径**：造一个权限弹窗记录可观测性与处理通道；聚焦→输入→`keyboardVisible()`；
6. **Maestro 对照**：**移至 P1 首周**（v3 收缩 P0）。

**Kill criteria（定量，任一不达标即输出决策输入并暂停推进）**：

- 树定位率：真实用例 ≥ 80% 步骤可由树 label/text 定位（不足则记录实测值与缺口）；
- 双端执行率：同一条用例 JSON 在 Android 与 iOS 模拟器均执行并留证（run.json + 截图）；
- 证据完整度：截图/层级/run.json/任务轨迹全部落盘；日志/崩溃按 §2.5 标注对等性；
- 真机连通：安装 + 启动 + 崩溃日志拉取成功；
- 双探针结论成文（含推荐默认与理由）。

**解释规则（预先约定）**：P0 的负面结论是决策输入（调阈值/换后端/缩小范围），**不是项目止损信号**；不得因单项失败否定 DeviceBackend 抽象本身。

### P1 — D1 确定性双端（5–10 人日）

- 抽取 `DeviceBackend`（含 capabilities）；**seam 引入即以 Android 全量测试为回归门禁**（行为不变）；
- iOS 实现（P0 选定的默认后端 + simctl 兜底）；用例双端共享（含 §2.6 坐标约定）；
- Maestro 对照结论定夺（仅影响 D1 执行器，不影响架构）；
- CI：macOS runner、串行、每 runner 1 模拟器。

### P2 — D2 智能（10–20 人日）

- artemis（Python）新增 `drivers/ios`（或 AOS 侧连接器），消费统一 `UiNode`；
- `mobile_run_task` 支持 iOS：plan/check/notes/traces 全链路；弹窗策略接入 Agent 循环；
- **恢复语义映射**：`am force-stop`→`terminate`；`pm clear`→**卸载重装，但注意 Keychain 卸载不清（iOS 10.3+），登录态可能幸存**——对策：用例优先走显式登出；模拟器可用 `simctl erase`；差异在 case schema 中声明；
- 验收含"纯文本 LLM 触发视觉 fallback 且有 trace 记录"。

### P3 — 真机与服务化（10–20 人日）

- 真机签名/配对自动化（依 P0/P1 结论选 idb 或 Appium 工具链）；设备池并发；
- 取证补强（§2.5 的降级项）；与设计流水线打通。

> 人日为粗估，P0 结束后校准。

---

## 4. 复用与改造清单

**直接复用**：`src/artemis/proxy.ts`、`assembly.ts`、`runtime.ts` 任务/重启语义、`suite`/`case-run` 格式、traces/notes、LLM registry、PG 台账、失败分类。

**新增**：`DeviceBackend` + capabilities（含 openUrl/grantPermission/dismissKeyboard）；iOS 实现（idb 与/或 WDA、simctl、pymobiledevice3）；`analyze_screen`（缓存/失效/脱敏/模型 fallback）；Apple Vision OCR helper；弹窗策略执行器；iOS 证据采集器（§2.5）；iOS 栈检测与 doctor 检查（Xcode、模拟器、idb/WDA、配对、证书有效期）。

**改造**：`mobile_get_device_state` 的 uri 契约与坐标元数据（双端一并修）；crash collector 接口；`case-run --platform` 与后端探测。

---

## 5. 风险与缓解（v3 更新）

| 风险 | 缓解 |
|------|------|
| 真机签名/配对（idb 不豁免） | P0 半天连通 + P1 实测两条路径；真机后置但**不晚于 P2 前插一次 smoke** |
| Xcode 大版本升级税（持续） | 年度预算计入；doctor 钉版本；CI 固定 runner 镜像 |
| 模拟器先行制造假信心 | P0/P1 即按真机能力矩阵设计；无 shell 约束从 D1 生效；P2 前真机 smoke |
| 无 shell，恢复手段少 | 恢复语义映射表（含 Keychain 差异）；terminate/simctl erase；不做"应用内清数据"承诺 |
| iOS 语义树质量差（RN/Flutter/WebView） | 按屏自适应升档（§2.3 阈值）；Apple Vision；用例准入限制（无视觉时禁跑依赖视觉的用例） |
| 证据链能力不等价 | §2.5 矩阵显式标注降级；首版崩溃采"上报文件 + syslog" |
| 弹窗误吞被测场景 | 默认 `keep` + 模拟器预授权治理源头 |
| 视觉误判/幻觉坐标 | logical 坐标约定（§2.6）+ 树/OCR 复核；坐标兜底标 degraded |
| 纯文本 LLM 无法看图 | 强制 fallback 专用视觉模型 + preflight 能力检查 |
| 截图隐私 | 本地 Vision OCR 优先；外部模型前脱敏；日志不落图 |
| 单供应商风险（idb/WDA 二选一） | P0 双探针定量对比；simctl 零依赖兜底 |

---

## 6. 验收标准与测试矩阵

### 测试矩阵（v3 新增）

- iOS 模拟器：最近两个 iOS 大版本 × {小屏、大屏} 各一台；
- 真机：1 台（P0 连通，P2 起入矩阵）；
- Android 回归：现有矩阵不变，seam 引入起全量测试为门禁；
- 稳定性预算：D1 **不自动重试**；flake 记为缺陷并记录场景；`waitText` 默认超时 P0 双端实测后固化（允许双端不同）；CI macOS runner 串行、每 runner 1 模拟器。

### 验收

| 阶段 | 验收 |
|------|------|
| P0 | §3 的五项 kill criteria 全部有结论（成文）；一条真实用例双端执行；scale≠1 验证通过；双探针/真机/弹窗/输入路径结论齐备 |
| P1 | Android 全量测试与线上下行为不变；iOS 模拟器 3 条冒烟用例 PASS；无重装/无长链约束沿用；Maestro 结论定夺 |
| P2 | `mobile_run_task(ios)` 完成一次真实任务；trace/notes/截图/失败分类落 `.artemis/`；**纯文本 active LLM 场景触发视觉 fallback 且有 trace** |
| P3 | 真机完成 安装 → 执行 → 崩溃采集 闭环（按 §2.5 对等性标注） |

---

## 7. 决策记录（v3）

| # | 决策 | 状态 |
|---|------|------|
| 1 | 模拟器默认后端：**idb**（P0 实测支持：更快、label 一键定位、弹窗前台可坐标处理）；Appium/WDA 保留为弹窗结构化与真机候选；simctl 零依赖兜底 | **定（P0 实测）**；真机路径待有设备后实测 |
| 2 | 模拟器优先，真机后置但不全后置（P0 半天连通、P2 前 smoke） | **定** |
| 3 | 引入 idb 为候选（MIT、活跃维护）；simctl/pymobiledevice3 互补 | **定** |
| 4 | 设备抽象落 AOS(TS) 侧统一接口 + capabilities；Python 只消费统一 `UiNode` | **定** |
| 5 | 视觉模型 fallback + preflight 能力检查；坐标统一 logical point | **定** |
| 6 | Maestro **不进入 AOS 服务**（不新增其 300MB+/JDK 依赖与独立驱动栈；不纳入 D1 主执行器）；**iOS 项目侧保留**为可选执行器/对照（`starbuckstw/cases/maestro/`，用户级安装 `~/.aos/maestro`，与 AOS 依赖无关） | **定** |
| 7 | 真机签名最终选型（idb vs WDA+Appium） | 开放 → **P0 结束日定** |

> 规则：所有开放项在 P0 结束日（或表中注明的更早节点）给出结论，不得漂移。

---

## 附录 A：第一轮外部提案取舍记录

| 外部提案主张 | 取舍 |
|--------------|------|
| 视觉识别封装在 MCP 服务内、对客户端透明 | ✅ 采纳（§2.3/§4） |
| `analyze_screen_with_vision` 单工具绑定"截图+分析" | ❌ 不采纳为主接口（无法缓存/复用）；观察工具分离，另留可选融合工具 |
| 把 tap/swipe/input 逐步暴露给客户端驱动 | ❌ 不作主路径；保留 passthrough 给服务内子代理 |
| 另起独立 iOS MCP server | ❌ 分叉生态；做进 AOS-ARTEMIS |
| "TypeScript + XCUITest" 直接组合 | ⚠️ 表述不成立（XCUITest 是 Swift/ObjC；TS 经 WDA/Appium/idb） |
| "无障碍树优先 + 视觉兜底" | ✅ 采纳并升级三档 |

## 附录 B：第二轮外部评审取舍记录

| 反馈 | 判定 | 处理 |
|------|------|------|
| C1 `DeviceBackend` Android 化 | 问题成立、药方修正 | `back()` 保留意图语义 + capability 降级；`inputText` 不绑 tap；另加 `keyboardVisible()` |
| C2 iOS 系统弹窗幽灵拦截 | ✅ 采纳（机制修正） | §2.4 策略化按需拦截（默认 keep）+ 预授权治理 |
| H1 弃 Appium、idb 主力 | 方向采纳、细节纠正 | 事实校核（真机仍需签名、"几十倍"夸张、不托管 WDA、不替代 simctl）；Appium 降为签名/会话备选 |
| 方案 A Maestro | 部分采纳 | 定位为对照 spike（v3 移至 P1 首周） |
| 方案 B 纯视觉直驱 | 不采纳为主路径 | 保留为三档最后一档 |
| 方案 C 混合双轨 | 骨架采纳、三点修正 | D1 label/text 优先；结构化弹窗 API；按屏/按步自适应 |
| 决策 5 视觉 fallback | ✅ 采纳 | §2.3 第 6 条 + preflight |

## 附录 C：第三轮评审 + Council 取舍记录（v3）

| 反馈/声部 | 判定 | 处理 |
|-----------|------|------|
| 坐标系（point vs pixel）未约定 | ✅ 成立 | §2.6 新增，覆盖 `analyze_screen` 输出；P0 scale≠1 断言 |
| 本地 URI 与服务化矛盾 | ✅ 成立（跨端既有） | §2.6 uri 契约（file/http 由部署定）+ 双端一并修 |
| 缺 openUrl / 权限预授权 / 键盘收起 | ✅ 成立 | §2.1 capability + 方法（预授权仅模拟器）；§2.4 源头治理 |
| 缓存需 mutating 后立即失效 | ✅ 成立 | §2.3 第 5 条 |
| 卸载重装 ≠ `pm clear`（Keychain 残留） | ✅ 成立 | §3 P2 恢复映射 + case schema 声明 + `simctl erase` |
| P0 范围过大 | ✅ 成立 | P0 收缩为 5 项 + kill criteria；Maestro 移 P1 |
| UiNode 有损 | ✅ 成立 | `value` 提入核心 + `attrs` 扩展袋 |
| `back()` 分层耦合 | 部分成立 | §2.1：仅平台原语、有界、结构化错误；树搜索回退由上层编排 |
| 升档阈值/OCR 选型缺失 | ✅ 成立 | §2.3 阈值初值 + Apple Vision 本地 OCR |
| 弹窗进程隔离事实 | ✅ 成立 | §2.4 事实前提 |
| 测试矩阵/稳定性预算/CI 成本 | ✅ 成立 | §6 测试矩阵 |
| Council：idb 预先定主力不妥（2 声部反对） | 采纳 | §2.2/§7 改 **P0 双探针后择一**，不预设 |
| Council：真机不可全后置 | 采纳 | P0 半天连通 + P2 前 smoke |
| Council：以 P0 为可证伪过程（kill criteria）| 采纳 | §3 kill criteria + 解释规则 |
| Council："双端同一证据链"是空头支票 | 采纳 | §0 成功标准改"能力对等"；§2.5 证据矩阵 + iOS 取证专章 |
| Council：用例 schema 的 Android 语义是真门槛 | 采纳 | P0 用一条真实用例双端执行暴露差异 |
| Council 事实修正 | 记录 | "idb 维护名存实亡"与仓库实测不符；"idb 不产 accessibility 树"不准确（`ui describe-all` 存在）；双探针结论不受影响 |

---

## 附录 D：P0 实测记录（2026-10-05）

环境：macOS（Xcode 27.0 / iOS 26.5 runtime）、iPhone 17 Pro 模拟器、idb 1.6.5（brew）、Appium 3.8.0 + appium-xcuitest-driver 12.15.0。

### D1 双探针对比（warm）

| 指标 | WDA（Appium） | idb 1.6.5 |
|------|---------------|-----------|
| 树/source | 40.6KB / 168 节点 / 0.4–0.9s | flat 5.9KB/15 元素、nested 14 节点 / 0.13–0.2s（accessibility 元素级，含全部 cell label） |
| label 定位+点击 | 两步：find 39–361ms + click 1.5–1.9s | 一步 `ui tap --match-key AXLabel` **516ms** |
| 坐标 tap | 1.24s（W3C actions） | **0.13–0.58s** |
| 截图 | 63–143ms，PNG 1206×2622 px | 153–229ms，PNG 1206×2622 px（`--units points` 不改变输出尺寸） |
| 弹窗 | 结构化 API：text 97ms / accept 637ms | 前台窗口可见；坐标点击 221ms；label 点击有动画竞态 |
| 启动 App | session 首启 33.3s（含 WDA 构建）/ 后 4.3s | launch 首次 5.6s / 后 **0.28s** |
| 获取成本 | npm driver + WDA 首次构建 | brew companion（约 30MB+，本次网络受限约 20min） |

### D2 坐标系验证（§2.6 kill criterion）

- `window/rect` = 402×874 **pt**；截图 = 1206×2622 **px** → scale = 3，与推算一致；
- `idb screenshot --units points` 实测输出仍为像素尺寸 → 后端必须显式 ÷scale，视觉/OCR 输出坐标尤需换算。

### D3 弹窗路径（§2.4）

- WDA/Appium：`alert/text` 97ms、`alert/accept` 637ms、accept 后 404（闭环）；
- idb：前台弹窗可见（允许一次/使用App时允许/不允许），坐标点击 221ms 关闭；
- **遗留弹窗阻塞实证**：Maps 小组件定位弹窗残留 → 设置页 start 检测失败；case-run iOS 后端已实现策略化清理（`caseDef.alerts.default: accept|dismiss`），清理后冒烟通过。

### D4 case-run iOS 冒烟（同一 suite schema）

- `cases/ios-smoke.json`（`platform: ios`，系统 App：设置）→ `node tools/case-run.mjs run --suite cases/ios-smoke.json`：
  `TC-IOS-000 PASS`（设置 → 通用导航；4 步；证据 `.artemis/design/runs/_ios/ios-smoke-general.png`；run.json 含 `platform: ios`）；
- Android 侧同 schema 运行待设备恢复后补（当前手机不在线）；实现上已是同一 runner + 同一用例 JSON。

### D4.5 输入路径补充（idb 侧实测）

- **ASCII**：`idb ui text abc` rc 0（224ms）；`ui text` 走键码；
- **CJK 不支持**：`idb ui text 通用` → `Exception: No keycode found for 通`（键码表无中文）；
- **CJK 绕行（可用）**：`idb ui set-value --api ax --value 通用 <x> <y>` → rc 0（139ms），树内该元素 `AXValue="通用"` 可回读；语义为**替换**（set），非逐键输入；`--api axbridge` 亦可（334ms，偶发 broken pipe）；
- 需要"真实键盘事件"语义时回退 WDA/Appium `/keys`（probe 实测成功）；
- 实现细节：idb 坐标参数必须**整型**（浮点会报 `ui tap expects 'x y' coordinates`）；
- **case-run 已落地 `inputText` 步骤**：Android=`input text`（空格转 `%s`）；iOS=ASCII 走 `ui text`、CJK 走 `set-value --api ax`（步骤记 `degraded`），支持 `atText/at` 先聚焦；冒烟 `TC-IOS-001`（输入"关于本机"→过滤回读）PASS。

### D5 P0 清单状态

| 项 | 状态 |
|----|------|
| 双探针 | ✅（推荐模拟器 idb 主力） |
| 坐标系 | ✅ |
| 弹窗路径 | ✅（含遗留弹窗阻塞实证与 policy 实现） |
| 输入路径 | ✅（WDA：focus→keys→回读；idb：ASCII rc0、CJK 用 `set-value --api ax` 绕行） |
| case-run 双端冒烟 | ◐ iOS 侧 ✅；Android 侧待设备 |
| 真机连通 | ⏭️ 无 iPhone，延后 |
| Maestro 对照 | ✅（见 D6；结论：不纳入主执行器） |

### D6 Maestro 对照（2026-10-06）

安装：Maestro CLI 2.11.0（`maestro.zip` 300MB；brew formula 连带 openjdk/cairo 依赖链较重；网络受限时改为 `gh-proxy.com` 手动下载 + 系统 Java 21，sha256 校验一致）。

| 维度 | case-run + idb（现方案） | Maestro 2.11（YAML flows） |
|------|--------------------------|------------------------------|
| 用例编写 | JSON 步骤 + 显式超时 | YAML 声明式、自动等待；相对选择器/条件/循环 |
| 本组用例耗时 | TC-IOS-000 4.99s / TC-IOS-001 5.07s（同一次运行内） | ios-general ~16.5s ×3 / ios-search ~16.3s ×3（每次含 CLI + 驱动会话启动） |
| 稳定性 | 2/2 PASS（idb 后端） | 6/6 PASS（修正后；初版失败均为用例问题而非工具不稳） |
| CJK 输入 | `set-value --api ax`（替换语义，标 degraded） | `inputText` 原生可用（XCUITest typeText） |
| 选择器歧义 | 文本/值匹配（无相对选择器） | 同样遇到"搜索行 vs 底部搜索框"歧义，需 `point` 兜底 |
| 截图证据 | 落项目 `.artemis/`（run.json 关联） | 相对路径写入 Maestro artifacts（`takeScreenshot` 拒绝绝对路径） |
| 台账/闭环 | 三阶段幂等 / 网络门禁 / 失败分类 / `--from` 续跑 | 独立 CLI 与驱动栈；产物不入 run.json |
| 获取成本 | brew companion ~30MB（+CLI） | 300MB zip + JDK 依赖链 |

**结论（决策 6）**：Maestro **不进入 AOS 服务**——AOS-ARTEMIS 不新增该依赖（300MB zip + JDK 链、独立驱动栈、产物不入台账），D1 主执行器仍为 case-run + DeviceBackend；**iOS 项目侧保留**为可选执行器/对照（`starbuckstw/cases/maestro/`；安装位置 `~/.aos/maestro` 用户级，非服务依赖）。可借鉴项：自动等待语义、相对选择器、CJK `inputText` 直达（可评估把 CJK 输入从 `set-value` 升级为 WDA keys / typeText）。

**iOS 26 布局事实**：Settings 搜索框在**底部**（约 93% 高度），顶部为标题区——两套工具本轮各踩一次，用例适配时需注意。

### D7 P1 进度（2026-10-06）

| P1 交付项 | 状态 |
|-----------|------|
| iOS 默认后端（idb）+ **simctl 兜底** | ✅ launch/openurl/screenshot 兜底已实现；simctl 命令独立验证（截图 1206×2622、launch 返回 pid）；`ios-smoke` 回归 2/2 PASS |
| 用例双端共享（同 schema + §2.6 坐标） | ✅ 同一 runner/JSON；Android 侧执行待设备 |
| `DeviceBackend` 模块化抽取 | ✅ `tools/device-backend.mjs`（21 函数 / 24 导出：双端门面 + capabilities + simctl 兜底 + idb/adb-safe 助手）；case-run 瘦身至 743 行；回归 `build`/`list`/`ios-smoke 2/2` 通过；**AOS 服务侧统一接口接入留待 P2** |
| P2 slice 1（AOS 侧 iOS 截图源） | ✅ `src/device/ios.ts`（idb→simctl）+ `design_device_diff`/`compare_design_and_device` 的 `platform:"ios"`（DESIGN §13.41；14 例测试） |
| P2 slice 2（观察路由） | ✅ `mobile_get_device_state`：UDID 判据自动路由 AOS iOS 后端（screenshot → `live_screenshots/*.png`；hierarchy → idb 简化列表；`src/tools/ios-state.ts`，DESIGN §13.42；10 例测试） |
| P2 slice 3（动作层） | ✅ `src/device/ios-actions.ts`：`makeIosDevice`（tap/swipe/inputText/launch/terminate/openUrl/nodes/size/screenshot/handleAlerts；idb→simctl 回退），DESIGN §13.43；11 例测试 + 模拟器冒烟（无 MCP 暴露，待 P2 runner 消费） |
| P2 slice 4（`mobile_run_task` 路由 + 最小执行器） | ✅ `mobile_run_task`（UDID 判据）→ AOS 执行器（层级观察 + active LLM 单动作 JSON 循环 + shots/run.json/status.json）；`mobile_manage_task` status/stop/inject；`src/llm/chat.ts`、`src/ios/task-runner.ts`，DESIGN §13.44；10 例测试 + 真 DeepSeek/模拟器端到端验收 |
| P2 slice 5（视觉 fallback） | ✅ `src/ios/vision.ts`：视觉目标解析（`AOS_IOS_VISION_LLM`/`AOS_IOS_VISION_MODEL`/active 多模态启发）+ 按需附图（层级质量差或 `AOS_IOS_VISION_ALWAYS=1`）+ 失败降级记录（`vision_degraded`/`perception`），DESIGN §13.45；P2 验收项“纯文本 LLM 触发视觉 fallback 且有 trace”达成 |
| P2 slice 6（trace 检查器 + 路由下沉） | ✅ `mobile_inspect_trace` 四动作（view_summary/view_step_details/view_step_screenshots/search）按 iOS trace 路由；路由下沉到 Runtime 代理层使 `design_device_diff(mode:"step")` 可对 iOS 失败步骤自动锚定并对比（DESIGN §13.46；6 例测试） |
| P2 slice 7（suite 用例闭环） | ✅ `suite run --device <UDID>` 由 AOS 执行器跑用例：iOS 复位（`resetIosApp`，idb terminate+launch）、`--app` 自动启动、日志显式降级 `ios-log-unsupported`、失败经 test_summary 走既有分域（DESIGN §13.47；7 例测试 + 真机 CLI 验收两次 PASS） |
| P3 slice 8（崩溃取证 + evidence） | ✅ `src/crash/ios.ts` 采集宿主机 DiagnosticReports `.ips`（窗口+签名+索引去重），`aos_crashes` kind=`ios`，`suite evidence` 失败项/锚点/崩溃引用对 iOS 可用（DESIGN §13.48；4 例测试） |
| P3 slice 9（真机 UDID 识别） | ◐ `classifyIosSerial`（模拟器 UUID / 真机 8-16 / 40-hex）贯通 state/runner/reset/suite；真机跳过 simctl 校验走 idb best-effort——**无 iPhone 未实测**，签名/配对（P3 前置）待做（DESIGN §13.49） |
| Android 回归门禁 | ⏸ 待设备在线 |
| Maestro 决策 | ✅ 见 D6（不纳入主执行器） |
| CI（macOS runner、串行） | ⏸ 未配置 |
