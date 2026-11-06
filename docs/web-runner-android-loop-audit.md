# Web Runner Android 测试闭环审计与补齐方案（历史，已废弃）

> **2026-11-06：Maestro web-runner 已移除，本文仅作历史审计记录；脚本 `check-android-runner-env.ps1` 已删除。Android 真机请用 `docs/android-mcp-native-testing.md`。**
>
> 日期：2026-11-05
> 状态：待评审；本文档只做审计/方案，不新增生产代码
> 范围：中心（macOS）→ Windows web-runner → vivo 真机 → Maestro 的 Android 下发/执行链路
> 相关提交：`c5fa506` / `3128b86` / `af6a79d` / `b07baa0` / `c7d5659` / `288aa66` / `6f504d8`
> 配套脚本：`scripts/check-android-runner-env.ps1`（另有一份可下载副本在 `dist-runner/check-android-runner-env.ps1`）

## 0. 阅读说明

- 本文把缺口分成两类：
  - **阻塞性缺口**：不补就无法跑业务用例，或跑了也无法判断结果。
  - **可容忍缺口**：当前仍能跑，但会降低效率/可诊断性/稳定性，可以排期。
- 本文不把“假设”写成“结论”；§5 给出每个假设的证伪条件与分支动作。
- 本文不给单一推荐路线；§8 只列依赖关系和“现在必须/可以推迟/可以并行”的事实。

## 1. 结论摘要

1. 当前链路不是“某条用例失败”，而是**环境、预检、证据回传**三处不完整。
2. 现有 9 个 web job **全部失败，没有成功样本**；安装修复后失败层从“安装”迁移到“Maestro 阶段”，但 Maestro 阶段从未成功（§2.3）。
3. 根因尚未确认；H1（两个 Maestro driver 包）是**最容易验证**的假设，不是已被证明的最可能根因。§5 的决策树规定了 H1 不成立时走 H2，而不是继续深挖 H1。
4. 环境契约目前依赖人工，且 Step 1 的代码验证依赖 Step 0 完成；本文把 Step 0 做成可执行脚本，避免“人记得做”。
5. 在环境、预检、证据三块补齐前，换 Appium 也会重复同样的调试过程。

## 2. 现场事实

### 2.1 当前环境

| 项 | 值 |
|---|---|
| 中心 | macOS，`192.168.3.91`（原 `192.168.102.165`） |
| 中心服务 | `8765`，PID `30431`，`GET /healthz` 正常 |
| 热修复/检查脚本服务 | `8899`（`dist-runner`），`http://192.168.3.91:8899` |
| Windows runner | `win-mini-01`，最后心跳 `2026-11-05T11:35:15Z`（19:35 本地），已离线 |
| Windows runner 配置 | 仍指向旧地址 `192.168.102.165:8765` |
| 设备 | vivo `V2453A`，Android 16，serial `10CF6609P900059` |
| Maestro | bundle `2.12.1`，JDK 21 |
| macOS 模拟器 | `emulator-5554`，`Resizable_Experimental`，Android 16（`sdk_gphone16k_arm64`） |
| 被测 Android 包 | `com.exxonmobil.mobil.gusp.uat`，`1.4.1`，versionCode `104010001`，protected APK（46MB） |
| 被测 iOS 包 | `com.exxonmobil.mobil.gusp.beta`，`1.4.1 (3)`，IPA（71MB） |

### 2.2 已确认正常的环节

- 中心 → runner：心跳、领取、设备租约、任务状态回写都成功过。
- runner → 设备：`adb install` / 已安装检测成功；最新结果已回填 `package.name=com.exxonmobil.mobil.gusp.uat`、`package.version=1.4.1`。
- 安装识别：APK 版本比较 + 已安装跳过已生效（`c5fa506`/`3128b86`）。
- 结果回传：结果 JSON 能入库、Excel 能写回。

### 2.3 任务样本与时间分布

当前项目全部 web job：

| 任务 | 开始（UTC） | 阶段 | 结果/错误类别 | PASS 用例 |
|---|---|---|---|---|
| `cb92074d` | 05:17 | 脚本解压 | `unzip ENOENT`（Windows） | 0 |
| `b1a7abea` | 06:03 | 安装 | `web-job-install-failed` | 0 |
| `9ec0319e` | 07:38 | 安装/结果 | 安装超时 + Excel mapping 409 | 0 |
| `fe3c8fee` | 08:01 | Maestro 启动 | `spawn maestro ENOENT`（路径解析） | 0 |
| `e2885ba6` | 08:33 | Maestro | `maestro-exit:1` | 0 |
| `3a8ccc1c` | 08:46 | Maestro | 无 JUnit，`viewHierarchy` 超时 | 0 |
| `03bacb23` | 09:04 | Maestro | `deviceInfo` 断连 | 0 |
| `b01dec64` | 10:48 | Maestro | `deviceInfo` 断连 | 0 |
| `df488953` | 11:21 | Maestro | `deviceInfo` 超时 120s | 0 |

样本偏差说明：

- **没有成功样本**，也没有“跑了一半、部分用例 PASS”的样本；不能从现有数据反推“成功的共同特征”。
- 失败是**连续集中**在 05:17–11:21 UTC 的同一环境/同一设备上，不是跨多天间歇出现；这不能单独证明 H2（USB 不稳定）成立，也不能排除它。
- 失败阶段已经迁移：安装/解压问题修复后，失败稳定落在 Maestro driver 层；这说明安装修复有效，但不等于 Maestro 可用。
- `deviceInfo` 与 `viewHierarchy` 交替出现，属于同一类“driver gRPC 会话断”，不是两个独立 bug。

### 2.4 模拟器 A/B（已完成）

- Maestro **2.11.0**：Settings 最小 flow（`launchApp` + `takeScreenshot`）PASS。
- Maestro **2.12.1**：Settings 最小 flow PASS。
- Esso APK 在模拟器：
  - 安装成功、`SplashActivity` 启动；
  - 随后 app 进程退出，前台回到 launcher；logcat 无 app FATAL，表现为“no app thread”；
  - 与 DexGuard 虚拟机检测一致，**模拟器不能作为 Esso 的验收环境**。
- 结论：Maestro 2.12.1 在 Android 16 模拟器上正常；问题不在“Maestro 通用不兼容”。

### 2.5 Maestro Android driver 机制

Maestro 2.12.1 的 `lib/maestro-client.jar` 内含两个 APK：

| APK | package | 作用 |
|---|---|---|
| `maestro-app.apk` | `dev.mobile.maestro` | driver app |
| `maestro-server.apk` | `dev.mobile.maestro.test` | instrumentation/server |

事实：

- `maestro test` 默认每次重装 driver + server（`--reinstall-driver` 默认开启）。
- 在需要安装确认的机型上，重装可能再次弹窗；未确认时 driver 可能处于半装/被杀状态。
- 已在模拟器验证：`--no-reinstall-driver` 在 driver 缺失时仍会触发安装；存在时跳过重装。
- 已实现（`6f504d8`）：两个包都在时加 `--no-reinstall-driver`；缺包时交给 Maestro 安装并打印缺失包；`AOS_MAESTRO_REINSTALL_DRIVER=1` 强制重装。
- **真机两个包是否都在，尚未确认**（见 §10）。

## 3. 自我审计：为什么会变成重复调试

1. **把任务失败当成单点 bug 修，而不是先建验证闭环**
   - 安装、iOS、诊断、driver 复用、面板版本都修了，但每轮验证仍是“重新下发一单”。
   - 失败层不断变化，修复是症状驱动，不是验证驱动。

2. **证据链没有回到中心**
   - logcat/截图/maestro.log 在 runner 的 job 目录；中心面板远程 artifact 链接不可用。
   - 每轮都要人工去 Windows 找文件，反馈慢且容易断。

3. **没有“已知可用”的基线**
   - 真机没有先跑过 Settings 最小 smoke；
   - 模拟器只能证明 Maestro 本身可用，不能证明“Windows + vivo + adb + driver”链路可用；
   - 在基线未建立前跑 DexGuard 保护的 Esso，失败原因必然混杂。

4. **环境没有锁住**
   - 中心 IP 变化、runner 仍连旧地址；
   - host id、网络、设备、Maestro 版本、driver 包版本都没有固定契约。

5. **没有防复发的门禁**
   - driver 缺包、锁屏、app 未安装/版本不符、网络不通，本应在跑 Maestro 前 fail fast；
   - 现在要等 120s 超时后再猜。

## 4. 闭环完整性（阻塞性 vs 可容忍）

目标闭环：

```text
环境就绪 → 预检 → 最小 smoke → 业务用例 → 证据回传 → 失败分类 → 修复/重跑 → 回归
```

| 环节 | 当前状态 | 缺环时能否跑业务用例 | 缺口类型 | 说明 |
|---|---|---|---|---|
| 环境就绪 | ❌ | 不能 | **阻塞性** | 中心 IP 变、runner 离线；现在连任务都领不到 |
| 预检 | ✅ 代码已实现，待真机验证 | 能跑 | — | 缺包/锁屏/app 版本不符时 typed failure（§13.312） |
| 最小 smoke | ⚠️ | 能跑，但没有基线 | 可容忍（证据缺口） | 真机链路是否可用未知 |
| 业务用例 | ❌ | 不能（当前卡在 driver） | **阻塞性** | 不是闭环环节缺失，而是执行结果 |
| 证据回传 | ✅ 代码已实现，待真机验证 | 成功/失败路径都能跑 | — | 诊断随结果上传，中心落盘并加入 evidence（§13.313） |
| 失败分类 | ⚠️ | 能跑，但只能看到 error/failed | 可容忍（效率） | 不能区分 driver/设备/安装/app/WebView |
| 修复/重跑 | ⚠️ | 能跑，但没有最小重试 | 可容忍（效率） | 每次都重新下发，成本高 |
| 回归 | ❌ | 能跑单次，不能稳定回归 | 可容忍（稳定性） | 没有固定 smoke 基线 |
| 防复发 | ❌ | 能跑，但会重复踩坑 | 可容忍（风险） | 没有门禁/readiness 视图 |

**当前能否使用**：

- 现在：**不能**，因为环境（网络/runner）是阻塞性缺口。
- 环境恢复后：可以尝试业务用例，但失败时不可诊断、无基线；建议至少补“最小 smoke + 证据回传”。

## 5. 根因假设与证伪决策树

### 5.1 假设表

| 假设 | 支持证据 | 证伪测试 | 成立时动作 | 不成立时动作 |
|---|---|---|---|---|
| H1 两个 Maestro driver 包缺失/重装被拦 | 默认重装；vivo 安装确认；手动只装了一个 | 真机 `pm path dev.mobile.maestro` + `pm path dev.mobile.maestro.test` | 补装缺失包；保留 `--no-reinstall-driver` | 进入 H2 |
| H2 Windows/vivo 的 adb/USB 长连接不稳定 | 只有持久 gRPC 断，短命令正常；连接 35～137s | 真机 Settings smoke（同一 Windows/vivo） | 换 USB 口/线/主机；迁 mac mini | 进入 H3 |
| H3 DexGuard 反自动化/反调试 | protected APK；模拟器启动即退出 | Settings 通过、Esso 启动/层级失败；测试包对比 | 要无 DexGuard 测试包；或黑盒 ADB/OCR | 进入 H4 |
| H4 WebView hierarchy 卡住 | APK 含 `android.webkit.WebView`/`WebViewClient` | Esso 能启动但 `viewHierarchy` 卡；devtools 开关对比 | `androidWebViewHierarchy: devtools`；Appium context | 进入 H5 |
| H5 Maestro 2.12.1 回归 | 2.12.1 才发布 3 天 | 模拟器已 PASS；真机降级 2.12.0/2.11.0 | 固定 2.12.0/2.11.0 | 进入 H6 |
| H6 app 后端/数据导致页面卡住 | 早期结果出现 `DB failed` | 手动打开 app 看 Register 页；检查网络 | 修数据/网络/测试数据准备 | 记录为新假设，不直接换引擎 |

### 5.2 排除决策树

```text
开始
│
├─ H1: pm path 两个 driver 包
│   ├─ 任一缺失 → H1 成立：补装/修复 driver → 重跑 Settings smoke
│   └─ 都在 → H1 不成立 → H2
│
├─ H2: 真机 Settings smoke（同一 Windows/vivo）
│   ├─ FAIL → H2 成立：换 USB/线/主机，或迁 mac mini → 重跑 smoke
│   └─ PASS → H2 不成立 → H3
│
├─ H3: Settings PASS，Esso 启动/层级失败
│   ├─ 是 → H3 成立：要无 DexGuard 测试包（或黑盒自动化）→ 重跑 TC_01
│   └─ 否 → H4
│
├─ H4: Esso 能启动但 viewHierarchy 卡
│   ├─ 是 → H4 成立：devtools hierarchy / Appium context → 重跑
│   └─ 否 → H5
│
├─ H5: 降级 Maestro 2.12.0/2.11.0
│   ├─ 成功 → H5 成立：固定版本
│   └─ 仍失败 → H6
│
└─ H6: 手动打开 app/检查后端
    ├─ 页面卡/DB failed → H6 成立：修数据/网络/测试数据
    └─ 正常 → 回到 H2/H3，重新采集证据（不要继续猜）
```

说明：H1 排第一是因为**验证成本最低**，不是因为它已被证明最可能。H1 不成立时，决策树强制进入 H2，不允许继续在 H1 上追加推测。

## 6. 补齐方案

### Step 0：环境契约（脚本化）

目标：把“人记得做”变成“脚本跑过才算过”。

```powershell
# 在 Windows runner 上下载并执行（脚本同时放在仓库 scripts/ 下）
Invoke-WebRequest -UseBasicParsing `
  http://192.168.3.91:8899/check-android-runner-env.ps1 `
  -OutFile check-android-runner-env.ps1

powershell -ExecutionPolicy Bypass -File .\check-android-runner-env.ps1 `
  -CenterHost 192.168.3.91 `
  -Serial 10CF6609P900059 `
  -Root C:\RUNNER\mobile-testing-runner-0.1.0-win32-x64 `
  -AppPackage com.exxonmobil.mobil.gusp.uat `
  -ExpectedVersionCode 104010001
```

检查项：

- 中心 `8765` / `8899` 可达
- `adb` 存在
- `adb devices -l` 中目标 serial 为 `device`
- `dev.mobile.maestro` 与 `dev.mobile.maestro.test` 都存在
- 屏幕唤醒、未锁屏（解析 `dumpsys power` / `dumpsys window`）
- 被测 app 已安装、versionCode 对比
- Maestro 可执行文件存在

退出码：

- `0`：无 FAIL（可以有 WARN）
- `1`：至少一个 FAIL（环境未就绪）
- `2`：脚本自身异常（保留给后续扩展）

Step 0 与 Step 1 的关系：**Step 1 的预检代码复用同一组检查，Step 0 不通过时 Step 1 的验证没有意义**。两者不是“人工 vs 代码”的分工，而是“同一个契约的脚本版与运行时版”。

### Step 1：预检门禁（运行时，已实现，待真机验证）

2026-11-05 后续：已实现（`DESIGN.md` §13.312）；在 runner 执行 Maestro 前，把 Step 0 的关键检查变成 typed failure：

- 设备在线：`adb devices` 包含目标 serial；
- driver 两包：`pm path`；
- 屏幕状态；
- app 已安装/versionCode；
- Maestro 可执行/版本。

失败分类：`maestro-driver-missing` / `device-locked` / `app-not-installed` / `adb-offline`。

防误报：

- 预检失败时保留原始命令与输出；
- 提供 `AOS_PREFLIGHT=0` 显式跳过；
- 先用 Step 0 脚本在同一台机器验证，再接入执行器；
- 单元测试覆盖“缺一个包”“锁屏”“adb 不在”的分支。

### Step 2：真机最小 smoke

```powershell
cd C:\RUNNER\mobile-testing-runner-0.1.0-win32-x64

@"
appId: com.android.settings
---
- launchApp
- takeScreenshot: smoke
"@ | Set-Content -Encoding utf8 smoke.yaml

.\tools\platform-tools\adb.exe devices -l
.\tools\maestro\bin\maestro.bat test --udid 10CF6609P900059 smoke.yaml
```

- PASS → 进入 Step 4；
- FAIL → 按 §5 决策树走 H2/H5，不进入 Esso。

### Step 3：证据回传（已实现，待真机验证）

2026-11-05 后续：已实现（`DESIGN.md` §13.313）；把失败诊断回到中心：

- `logcat.txt`（截断文本可直接入结果）
- `window.txt`
- `screen.png`（base64 或中心存储）
- `maestro.log`
- 远程 artifact 链接修复（面板可直接打开 runner 文件）

约束：

- 单文件/总量上限，超过截断；
- 异步/失败不影响主结果；
- 保留期与清理策略；
- 提供 `AOS_DIAGNOSTICS=0` 关闭。

### Step 4：业务用例

- 最小 smoke 通过后，再下发 `TC_01`。
- 失败按 H1～H6 分类，不把“driver 失败”当“用例失败”。
- DexGuard 明确拦截时，优先要测试包，不先换引擎。

### Step 5：引擎/测试包决策

见 §7，不在本文预设结论。

## 7. 方案对比（含切换成本）

| 方案 | 适用 | 一次性切换成本 | 持续成本 | 风险 | 回退 |
|---|---|---|---|---|---|
| 继续 Maestro + 测试包 | 现有脚本集/Excel 已存在 | 0（已在用） | 低 | DexGuard 必须放行测试构建 | 保留现有执行器 |
| mac mini 作为 Android runner | 怀疑 Windows USB/adb | 低（移设备、配 host id） | 低/中（多一台机器） | vivo/Maestro 问题仍可能存在 | 切回 Windows runner |
| Appium + UiAutomator2 | WebView/混合应用、需要 context | 中高（脚本集转换、Appium 安装） | 中（Appium/driver 维护、CI/面板适配） | DexGuard 仍可能拦 instrumentation | 保留 Maestro 执行器，双引擎 |
| ARTEMIS 原生/LLM | 套件回归/Excel 用例 | 高（Windows 部署 Python/venv、任务模型适配） | 中/高（LLM 成本/非确定性） | 与现有 web job 模型不同 | 保留现有执行器 |
| Espresso/UIAutomator | 应用源码可控、追求稳定 | 高（每 app 构建 test APK、流水线） | 中（每 app 维护） | 不通用 | 不替换通用执行器 |
| Maestro Cloud/device farm | 外包设备/driver | 中（接入/账号） | 高（按量/订阅） | 数据出网/合规 | 保留本地执行器 |

## 8. 决策点：现在必须做 vs 可以推迟

### 8.1 现在必须做（有依赖顺序）

1. **恢复网络/runner 在线**（Step 0 脚本退出 0）
2. **确认两个 driver 包**（H1 的证伪）
3. **真机 Settings smoke**（H2 的证伪）

这三步是串行依赖：网络不通 → 无法确认包/跑 smoke；包缺失 → smoke 也不可信。

### 8.2 可以并行

- Step 1 预检代码（已完成；仍需真机验证）
- Step 3 证据回传（已完成；仍需真机验证）
- 中心静态 IP/DHCP 保留/DNS 名

### 8.3 可以推迟

- B：迁 Android 到 mac mini（等 H2 成立再做）
- C：要 DexGuard 测试包（等 H3 成立再做）
- D：Appium PoC（等 H4 成立且 H2 已排除再做）
- 执行器抽象（等引擎选择确定后再做）
- iOS Web job 接线（独立线，不阻塞 Android）

### 8.4 决策规则（不做预设推荐）

- Settings smoke 失败 → 先做 B（换 host/设备）或 H5（降级 Maestro），不碰 Appium。
- Settings smoke 通过、Esso 被 DexGuard 拦 → 先做 C（测试包），不碰 Appium。
- Settings smoke 通过、Esso 能启动但 WebView hierarchy 卡 → 做 H4（devtools/Appium context）。
- Settings smoke 通过、Esso 业务用例正常 → B/C/D 都不需要现在做。

## 9. 实施风险与回滚

| 变更 | 做错了会怎样 | 缓解 | 回滚 |
|---|---|---|---|
| Step 0 网络/IP 变更 | 其他机器/服务连不上；runner 再次离线 | 先 DHCP 保留/固定 DNS；变更前记录旧配置；通知所有 runner | 恢复旧 IP/路由 |
| Step 0 设备设置 | 误关开发者选项/权限，后续无法安装 | 只改锁屏/省电/权限监控；逐项记录 | 恢复原设置 |
| Step 1 预检 | 包名拼错/解析误判 → 所有任务被阻断 | 先用 Step 0 脚本验证；保留命令输出；单测覆盖；`AOS_PREFLIGHT=0` 旁路 | 关闭预检开关，回退代码 |
| Step 1 锁屏判断 | 不同 ROM 输出差异 → 误报锁屏 | 锁屏判断先 WARN 后 FAIL；收集多机型输出 | 降级为 WARN |
| Step 3 证据上传 | logcat/截图过大 → 磁盘/带宽打满 | 单文件/总量上限、截断、异步、保留期 | `AOS_DIAGNOSTICS=0` |
| driver 复用 | Maestro 升级后旧 driver 不兼容 | `AOS_MAESTRO_REINSTALL_DRIVER=1` 强制重装 | 去掉 `--no-reinstall-driver` |
| 安装跳过 | 版本解析错误 → 用了旧包 | `AOS_WEB_FORCE_INSTALL=1`；版本未知时保守跳过并告警 | 强制重装 |
| 面板版本展示 | 平台识别错误 → 版本号错位 | 扩展名/平台映射单测；未知平台回退全局 version | 回退 UI 改动 |

## 10. 待确认信息（集中）

1. Windows 到 `192.168.3.91` 的 `8765`/`8899` 是否可达。
2. 真机 `pm path dev.mobile.maestro` 与 `pm path dev.mobile.maestro.test` 的结果。
3. 真机 Settings smoke 是否 PASS。
4. 失败任务的 Maestro log 中 driver 安装相关行（`Installing driver/server`、`Failed`、`DeviceServerDied`）。
5. iOS：是否本次一起处理（web 项目 `platforms`、iOS 脚本集、mac mini、iOS 18+ 隧道）。

## 11. 验收标准（Definition of Done）

- [ ] Windows runner 在线，心跳 < 60s。
- [ ] Step 0 脚本退出码 0。
- [ ] 预检在 driver 缺包/锁屏/app 未装时立即失败并给出分类（代码已完成，待真机验证）。
- [ ] 真机 Settings smoke PASS。
- [ ] 失败任务的 logcat/截图/maestro.log 能在中心查看（代码已完成，待真机验证）。
- [ ] Esso `TC_01` PASS，或失败原因被明确分类并附中心可读证据。
- [ ] 有一条固定 smoke 基线，后续改动先跑基线再跑业务用例。

## 12. 参考

- `DESIGN.md`（仓库根）§13.308（Android/iOS 安装识别）、§13.309（文件台账 hosts）、§13.310（安装包按平台展示）、§13.311（Maestro driver 复用）
- `docs/接入指南.md`、`docs/windows-runner-quickstart.md`（仓库内）
- `src/runner/web-executors.ts`（Maestro 执行/诊断）
- `src/runner/web-job-workspace.ts`（安装识别）
- `scripts/check-android-runner-env.ps1`（环境契约脚本）
- Maestro Known Issues：https://docs.maestro.dev/extra-materials/troubleshooting/known-issues
- Maestro CLI 2.12.1 release：https://github.com/mobile-dev-inc/maestro/releases/tag/cli-2.12.1

## 13. 文档范围

- 本文档整理本身不新增生产代码；`scripts/check-android-runner-env.ps1` 是诊断脚本。
- 没有重新下发任务。
- 没有假定根因；等待 §10 的输出再决策。
