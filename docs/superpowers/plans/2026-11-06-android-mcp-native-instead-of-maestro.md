# Android 自动化改用 MCP 原生执行（不再以 Maestro 为主路线）

> 状态：**待 review**（本文件只调整方案，不继续写实现代码）
>
> 背景：项目最初希望直接复用 MCP 的 Android 执行能力；实际落地时走了 Maestro web-runner，现场在 vivo 真机上反复遇到 driver 重装、半装、`DeviceServerDiedException`、冷启动 120 秒超时。继续在 Maestro 上投入的收益已经低于成本。

## 1. 结论

Android 真机自动化改为 **MCP 原生执行**：

```text
Excel（.xlsx）
  → run_regression / excel-import
    → 用例集（taskDesc）
      → suite run / mobile_run_task
        → Runtime → Artemis
          → adb（本机或远程 ADB_SERVER_SOCKET）
            → ArtemisAccessibilityHelper.apk + uiautomator2/OCR
          → active LLM（测试人员选择的模型；POC 用 DeepSeek V4 Flash）
        → trace / data_engine.db / 结果
```

**不生成 Maestro YAML，不启动 web-runner，不需要 JDK/Maestro。**

## 2. 关键事实（代码现状）

- `run_regression` 已存在：`excelPath` → `importTestDocument` → 用例集 → `executeSuiteBatch` → `case-runner` → Android 走 `mobile_run_task`（`src/workflow/run-regression.ts`、`src/figma/case-runner.ts`）。
- `run_regression` / `suite run` **不 import** `src/web/script-generation.ts`，不会生成 Maestro 脚本。
- Maestro YAML 只由 `createWebJob`（网页测试任务，`executionMode=maestro`）触发；产物 `scripts` 资产只被 `src/runner/web-executors.ts`（web-runner）读取。
- `mobile_run_task` 不读 `scripts` 资产、不读 Maestro YAML；它按 `taskDesc` 由 Artemis 现场执行。
- Excel 导入的“中间产物”是 `taskDesc`（纯文本），由可见列（名称/步骤/预期/前置/测试数据）+ 隐藏执行器 sheet（`humanStepsHash` 匹配时复用）生成，不依赖 LLM。
- 现场证据：`maestro hierarchy` 能读到 App 的 `Login`、`Register now`、`resource-id=.../btn_register`，说明 **App 的 accessibility 层级可读**；Maestro 失败点是 driver/冷启动，不是 App 屏蔽。

## 3. 方案对比

| 方案 | 依赖 | 确定性 | 安装负担 | 结论 |
|---|---|---|---|---|
| **MCP 原生（Artemis）** | adb + 一个 helper APK + active LLM | 中（LLM 规划） | 低，helper 一次安装 | **采用** |
| Appium + UiAutomator2 | Appium server + driver + JDK/Node | 高 | 中高 | 备选；团队已有 Appium 时再评估 |
| ADB + OCR/坐标 | adb + OCR | 低 | 低 | accessibility 被屏蔽时的兜底，不作为主路线 |
| Espresso / UI Automator | App 源码 + 构建 | 最高 | 高 | 有源码/CI 时另立项目 |
| Maestro web-runner | JDK + Maestro + 两个 driver APK | 高 | 高（vivo 坑） | **不再作为 Android 新接入路线** |

选择 MCP 原生的理由：

1. 正是最初想复用的 MCP 代码路径，不是另起炉灶；
2. 设备端只装一个常驻 helper，避免每次任务重装 driver；
3. Excel 直接变 `taskDesc`，不需要维护 YAML 中间层；
4. 失败时有 trace、截图、OCR 文本，排查成本低。

代价：执行阶段消耗 LLM token，结果是非确定性规划。模型由测试人员选择（见 §4C）；POC 先用当前已配置的 DeepSeek V4 Flash，成本可接受。

## 4. 变更范围

### A. 入口（不新增管线）

- 主要入口：`run_regression`（Excel）与 `suite run`（已有 tests.json）。
- 单条验证：`mobile_run_task`。
- 不选 `scriptSetId`，不创建“网页测试”任务；native 路径不生成 Maestro 脚本。

### B. 设备接入

- 用 `ADB_SERVER_SOCKET` 或 `aos.config.jsonc` 的 `deviceHosts.android.adbHost` 指向设备宿主的 adb server。
- 设备宿主（Windows）只需要 adb，不需要 Node/JDK/Maestro；优先 SSH 隧道，实验 LAN 用防火墙限定来源 IP。
- 保留 `docs/android-mcp-native-testing.md` 作为接入/排障手册。
- 已提供 **Windows adb-host 小包**（约 8MB：platform-tools + 启动/防火墙脚本 + README，`npm run bundle:adb-host`）；面板「设备 → 接入执行机」可直接下载。macOS 本机可直接用系统 adb。

### C. 模型选择（开放项，复用 MCP 已有实现）

模型不是硬编码，测试人员可自行选择：

| 工具 | 作用 |
|---|---|
| `llm_list` | 查看项目全部 LLM 条目与当前 active 项（key masked） |
| `llm_switch` | 切换当前 active 条目；下一个 `mobile_run_task` 生效 |
| `aos_configure` | 新增/更新 provider/model/baseUrl/key，并可设为 active |
| `mobile_run_task.model` | Artemis 内部的 `Flash` / `Pro` 档位，不是厂商模型 |

- `run_regression` / `mobile_run_task` 使用当前 active LLM；切换后下一个任务生效。
- POC 默认用当前已配置的 DeepSeek V4 Flash，仅作示例；测试人员可换成其他已配置条目。`deepseek-flash` 是 V4 Flash 的当前稳定模型名（旧名 `deepseek-v4-flash` 由服务自动修复/接管）。
- 项目 `.env` 只做初始配置（`AOS_LLM_*`，`0600`）；执行前 `doctor` 检查。
- 缺 active LLM 时返回 `needs-setup`，不静默降级到 Maestro。
- 不在 runner/日志/trace/审计里落 key。

### D. Excel 与 taskDesc

- 继续使用 `importTestDocument`：可见列 + 隐藏执行器 sheet；`humanStepsHash` 未变则复用 taskDesc，变了重建并保留 caseId。
- `taskDesc` 带【真实数据】约束。
- 不引入 Maestro YAML、不引入脚本生成器调用。

### E. Maestro 现状

- **Phase 1/2 保留代码，标记 legacy**：已有 web 任务可继续用，但文档/面板不再推荐 Android 新接入。
- **Phase 3（可选，需单独确认）**：移除 web-runner / Maestro 脚本生成 / 面板网页测试入口 / toolchain 的 Maestro/JDK；属于大范围删减，不在本次变更内。

## 5. 实施阶段

### Phase 0：POC（设备可见后，1 条用例）

- [ ] 设备通过 adb 对 MCP 服务可见（本机 USB 或 `ADB_SERVER_SOCKET`）。
- [ ] `doctor` 显示 LLM 就绪、`aos_status.deviceHosts` 显示 adb 宿主可达。
- [ ] `mobile_run_task`：打开 `com.exxonmobil.mobil.gusp.uat` → 点 `Register now` → 截图/报告。
- [ ] 检查 trace：步骤、截图、OCR/层级；确认没有 Maestro/JUnit 依赖。
- [ ] 首次 helper 安装若被 OEM 拦截，用 `mobile_diagnose(attempt_fix=true)` 或手动确认。

### Phase 1：Excel 回归

- [ ] `run_regression` 传 `excelPath` + `device`（可选 `appPath` 安装 APK），先只跑 TC_01。
- [ ] 跑通后扩到 TC_01–TC_20；记录通过率、失败域、耗时、token。
- [ ] 校验结果：`run.gate`、trace、Excel 回写/报告（按现有 `run_regression` 能力）。
- [ ] 若个别用例受保护 App/OCR 限制，先标记为 `UNVERIFIED`/人工复核，不伪造 PASS。

### Phase 2：默认口径与兼容

- [ ] 文档/面板把 MCP 原生标为 Android 默认；Maestro 标 legacy（已完成文档与 panel 文案，待 review）。
- [x] Maestro 路线已移除：web-runner/脚本生成/runner 打包/CLI 删除；`createWebJob` 对 maestro 返回 409，面板表单隐藏，历史 Web 任务/结果只读。
- [x] 补一次 `run_regression`/`mobile_run_task` 的集成测试或 smoke 说明（不依赖真实设备的部分用现有 fake）。

### Phase 3：移除 Maestro（可选，需单独批准）

- [ ] 删除/下线 web-runner、Maestro 脚本生成、面板网页测试入口、toolchain 中的 JDK/Maestro。
- [ ] 迁移/归档已有 scripts 资产与 web 任务历史。
- [ ] 更新 DESIGN/README/测试；这会是一次独立的大改动。

## 6. 验收标准

1. 设备宿主不安装 JDK/Maestro，只靠 adb 即可执行 `mobile_run_task`。
2. `mobile_run_task` 在真实 vivo 设备上完成 TC_01（打开 App → 点 `Register now`），trace 可查。
3. `run_regression` 能直接用 Excel 跑用例；过程中**不生成 `flows/*.yaml`、不引用 `scripts` 资产**。
4. 结果不伪造 PASS；失败有失败域/证据；缺 LLM 时显式 `needs-setup`。
5. 已有 Maestro web 任务在 legacy 模式下不受影响（Phase 3 前）。
6. 构建/测试/lint 全绿（实现阶段执行）。

## 7. 风险与回滚

| 风险 | 处理 |
|---|---|
| LLM 非确定性/ token 成本 | 由测试人员选择模型（`llm_switch`）；POC 先用 Flash、小步验证、失败用例人工复核；先不追求 20 条全自动 |
| vivo 拦截 helper 安装/后台冻结 | `mobile_diagnose(attempt_fix=true)`、预装 helper、必要时换设备 |
| 远程 adb 暴露 | 优先 SSH 隧道；LAN 仅限实验并限定来源 IP |
| Excel 步骤歧义 | 列映射、taskDesc 复核、隐藏 sheet 复用；必要时先规范 Excel |
| 受保护 App 不暴露层级 | 已确认可读；若后续变化，退到 ADB + OCR/坐标兜底，不回 Maestro |
| 误删 Maestro 影响旧任务 | Phase 3 前保留 legacy；删除需单独评审与迁移 |

## 8. 待 review 的决策

| # | 决策 | 建议默认 |
|---|---|---|
| D1 | 设备怎么接：手机插 Mac / Windows adb / SSH 隧道 | POC 先插 Mac；生产用 SSH 隧道或限定来源 IP 的 LAN |
| D2 | Maestro 代码：保留 legacy / 立即删除 | 保留 legacy，Phase 3 再删 |
| D3 | 是否做 device-host 小包 | 已实现 Windows adb-host 小包（约 8MB），面板可下载 |
| D4 | 面板“网页测试”入口 | 已移除；历史只读 |
| D5 | Excel 首批范围 | 先 TC_01，跑通后 TC_01–TC_20 |

> **模型选择不是待定项**：按现有 MCP 能力由测试人员在项目内选择（`llm_list` / `llm_switch` / `aos_configure`）；`run_regression` 使用当前 active LLM，切换后下一个任务生效。POC 默认的 DeepSeek V4 Flash 只是当前配置示例。

## 9. 已落地（本次待 review 的文档/文案）

- `docs/android-mcp-native-testing.md`：接入与排障手册。
- `README.md`、`docs/接入指南.md`、`docs/windows-runner-quickstart.md`、`AGENTS.md`：链接与说明。
- `scripts/build-runner-bundle.mjs`：压缩包 README 改为“MCP 原生推荐、Maestro legacy”，Windows 包已重建。
- `src/console/pages.ts`：面板“接入执行机”文案改为 MCP 原生推荐、runner 包仅 legacy。

> 这些改动不改变 Maestro 代码行为；只是把 Android 新接入的默认口径切到 MCP 原生。实现阶段从 Phase 0 开始。
