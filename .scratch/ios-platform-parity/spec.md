# iOS 平台对等（契约层对齐）

Status: ready-for-agent

## Problem Statement

AOS-ARTEMIS 的 iOS 模拟器路径（AOS 侧反应式执行器 + idb/simctl）已经能跑任务，但与 Android/ARTEMIS 路径在「设计 → 用例 → 代码 → 执行 → 证据」全链路上不对等：

- **设计→代码**：iOS 完全没有 token 产物；缺口分析对 iOS 颜色全量误报、`@2x/@3x` 资产匹配误判；strings 缺跨 `.lproj` 冲突检测与 `.stringsdict` 合并、locale 不按 BCP-47 转换、Swift 硬编码文案不扫描；SVG 资源的落点不是合法 asset catalog 条目；双端仓中 iOS 被主栈静默遮蔽；工具描述过期。
- **执行**：`model` / `verification_level` / `explorer_mode` / `expected_output_desc` / `app_path` / `conversation_id` 被静默忽略；trace 只存在内存，进程重启后 `mobile_manage_task` / `mobile_inspect_trace` / `suite evidence` / `suite baseline` 穿透到 ARTEMIS 产生假字段与空结果；被中断的任务永远显示 running；inspect 的 search 不含屏幕文本、步骤截图语义错位（after=下一步观察）、无动作标注；套件 iOS 日志降级无标记透出、复位错误 reason 泄漏 `force-stop-failed`、任务统计双重记账；崩溃扫描不路由 iOS；`design_device_diff` 拒绝 iOS step 模式。

结果是：同一条处理流程无法完整跑在 iOS 上，调用方会在无感知中拿到降级或错误行为。

## Solution

按 `docs/adr/0005`（契约层对等、差异显式、模拟器验收）与 `CONTEXT.md` 的「平台对等」「显式降级」术语，对 iOS 路径做两类工作：

1. **设计→代码补齐**：iOS token 产物（Colors.xcassets + Swift 枚举）、缺口/资产/strings/扫描/检测/文档修正。
2. **执行补齐**：跨进程持久化与中断归因、inspect 增强（屏幕文本、真实 post 截图、动作标注）、崩溃扫描路由、diff step 放行、套件日志与统计小修；不能等价的能力一律改为显式降级（结构化标记 + 文档 + 测试）。

完成后：同一套客户端调用在 Android 与 iOS 上得到同形可用的工具契约与产物闭环；所有差异可见、可预期、有测试锁定。

## User Stories

1. 作为使用 AOS 的客户端，我想在 iOS 模拟器上跑 `mobile_run_task` 时拿到与 Android 同形的启动响应（含 `trace_id`/`device_serial`/`status`/`model`），以便同一套调用代码不用按平台分支。
2. 作为客户端，我想在传 `model:"Pro"` / `verification_level` / `explorer_mode` / `expected_output_desc` / `conversation_id` 时收到结构化说明（该参数在 iOS 不适用、实际执行模型是什么），以便我不会误以为参数生效。
3. 作为客户端，我想在 iOS 上传 `app_path` 时收到明确拒绝与替代指引（用已安装的 bundle id），以便不会被静默跳过污染用例有效性。
4. 作为客户端，我想在 MCP 进程重启后仍能用 `mobile_manage_task` 对 iOS trace 执行 status/stop/inject_instruction，以便跨进程管理任务。
5. 作为客户端，我想被中断的 iOS 任务（进程死亡、状态停在 running）在超时后被归为 interrupted，以便任务台账不会永远悬挂。
6. 作为客户端，我想 `mobile_inspect_trace` 的四个动作（view_summary / search / view_step_screenshots / view_step_details）在跨进程后仍可用，以便 CLI 与后续会话能排障。
7. 作为排障者，我想 search 能命中每一步的屏幕文本（元素摘要），以便像 Android 一样按界面文案定位到具体步骤。
8. 作为排障者，我想 `view_step_screenshots` 返回真实的动作后（post）截图与动作标注 overlay，以便核对点击位置与执行结果。
9. 作为排障者，我想 `view_step_details` 的响应包含 `device_serial` 字段，以便与 Android 响应对齐消费。
10. 作为测试执行者，我想套件在 iOS 失败用例上拿到可用的 `test_summary`（合成项带 `synthesized` 标记），以便失败分类可用且不误导。
11. 作为测试执行者，我想一次 iOS 套件运行为同一 trace 只记一行任务统计，以便 `aos_tasks` 不出现重复行。
12. 作为测试执行者，我想 iOS 任务启动失败也写入任务行，以便台账完整、失败可追踪。
13. 作为测试执行者，我想 iOS 应用复位失败返回 iOS 侧的错误 reason（不再是 `force-stop-failed`），以便归因正确。
14. 作为测试执行者，我想 `api-errors` 在 iOS 上尽力采集模拟器日志并匹配 `error-codes.json`；不可用时保留显式降级标记，以便闭环尽可能完整且诚实。
15. 作为排障者，我想 `aos_crashes scan` 能对 `ios-` trace 走宿主机 DiagnosticReports 采集（含进程异常退出后的补扫），以便崩溃取证在 iOS 上闭环。
16. 作为客户端，我想 `design_device_diff` 在 `mode:"step"` 下接受 iOS trace（失败步骤截图），以便失败步骤可用于设计对比。
17. 作为测试执行者，我想 `locked_app_package` 在 iOS 上限制执行器动作只能指向目标 app，以便锁定语义与 Android 一致。
18. 作为客户端，我想协作式 stop（不立即杀进程）的语义在响应与文档中明示，以便对停止时延有正确预期。
19. 作为客户端，我想 iOS 层级观察与 Android 的差异（无 OCR 融合）被文档与测试锁定，以便不会被当成 bug。
20. 作为客户端，我想 iOS 任务响应中缺失的 Android 字段（`stdout_log`/`stderr_log`/`notes_dir`）以显式 null 或不适用说明出现，以便字段消费方不会踩空。
21. 作为客户端，我想「无唤醒通知、用轮询」是文档化契约（响应明示），以便调度逻辑正确设计。
22. 作为设计工程师（使用 Figma/pen 流水线的 iOS 开发者），我想 `figma_import_tokens` / `pen_import_tokens` 在 iOS 栈生成 `Colors.xcassets` colorsets 与引用 asset 名的 Swift 枚举，以便颜色 token 真正落地 Xcode。
23. 作为设计工程师，我想 iOS token 产物与既有栈一样幂等（生成标记、unchanged、skipped_unmanaged、overwrite 语义），以便重复运行安全。
24. 作为设计工程师，我想缺口分析在 iOS 上能解析 colorset 与 Swift `Color(...)` 形式的颜色，以免把已存在的颜色全部报成缺失。
25. 作为设计工程师，我想资产匹配正确剥离 `@2x/@3x` 文件名再比对，以免误报资源缺口。
26. 作为设计工程师，我想默认 SVG 也写入 `<name>.imageset` + `Contents.json`（`preserves-vector-representation`），以便资源是合法的 asset catalog 条目。
27. 作为设计工程师，我想 `Contents.json` 只在图片导出成功后写入并统一走 hash 幂等，以免引用不存在的文件、不产生重复文件。
28. 作为设计工程师，我想 strings 导入在 iOS 上检测跨 `.lproj` 的冲突（与 Android 跨 `values*` 一致），以便冲突经 `resolutions.json` 闭环。
29. 作为设计工程师，我想 `.stringsdict` 支持解析、合并与冲突检测，以免覆盖人工维护的复数配置。
30. 作为设计工程师，我想 locale 按 BCP-47 转换为平台目录（iOS `zh-Hans.lproj`、Android `values-zh-rCN`），以便资源目录正确。
31. 作为设计工程师，我想 Swift 源码的硬编码文案被扫描，以便像 Android XML 一样提示未国际化文案。
32. 作为设计工程师，我想 iOS 的 scaffold 与 build brief 保持 SwiftUI 骨架输出，以便代码起步有据可依。
33. 作为设计工程师，我想 iOS 栈检测放宽为限深搜索 `xcodeproj/xcworkspace`（排除 `node_modules` 等），以免工程不在 `ios/` 目录时整条设计链路失效。
34. 作为双端项目的开发者，我想 tokens/assets/brief/gap/scaffold/screen-map 因主栈限制跳过其他检测栈时给出显式警告（列出被跳过的栈），以免误以为 iOS 已产出。
35. 作为使用者，我想工具描述与 README 与实际支持范围一致（含 iOS 与降级契约），以免被过期口径误导。
36. 作为仓库维护者，我想 DESIGN.md 同步这些契约与降级行为，以便是架构与决策的唯一事实源。
37. 作为仓库维护者，我想以上所有行为都有不依赖真机、PostgreSQL 与外网的测试，以便 CI 全绿。
38. 作为仓库维护者，我想 iOS 验收只承诺 macOS 模拟器、真机保持 best-effort 且文档注明，以便范围清晰。

## Implementation Decisions

1. **原则**：遵循 `docs/adr/0005`——契约层对等（入参语义、响应字段、产物与闭环），内部实现可薄；凡无法等价的差异必须显式降级（结构化标记 + 文档 + 测试），禁止静默忽略与伪造数据。
2. **参数语义（执行器）**：iOS 执行器接受 `model` / `verification_level` / `explorer_mode` / `expected_output_desc` / `conversation_id` 参数，响应顶层**恒有**机器可读 `warnings[]`（无常量为空数组；条目如 `{code:"param_ignored", field, actual}`，列出不适用参数与实际生效值），而非仅自然语言说明；同一字段集在 AOS 响应包装层对双端同构化（Android 响应补空 `warnings: []`，纯增量、不动 artemis 子模块）。**分层规则**：咨询性参数（model 类）→ 接受 + `warnings`；前置条件参数（`app_path`）→ 明确拒绝并指引改用 `locked_app_package`（套件不转发 `app_path`，拒绝不影响任何既有流程）。
3. **跨进程持久化**：iOS 运行目录继续持有 `run.json` / `status.json`（含步骤、截图路径、元素文本摘要、vision 信息），写入使用原子写（当前为普通写，本次一并修正）；运行元数据记录 owner pid、进程启动时间与 `platform` 字段（`run.json` 已有，`status.json` 补上）；manage/inspect 采用「内存 → 磁盘」两级查找，函数签名与既有 iOS 设备状态入口对齐（runtime + args + 可注入依赖，deps 提供 clock/liveness 探测；fs/tracesDir 沿用真实临时目录，不新增未用 seam）；磁盘 fallback 归因前做进程存活校验——pid 存活则保持 running/stale 并提示「可能仍由该进程执行」；仅确认死亡、或超时且无存活 pid 时才置中断态——落盘与响应复用既有终态词 `orphaned`（`TERMINAL_TASK_STATUSES` 已含，`aos_tasks` 据此自动收尾），票面「interrupted」按此映射理解（可配置，默认 30 分钟；超时基准为 `status.json` 最后写入时间，即心跳语义，同主机无时钟漂移）。平台判别改为读持久化 `platform` 字段，`ios-` 前缀仅作旧 trace 的 fallback；旧版本产生的无 `run.json`/`status.json` 内存 trace 查不到属预期（版本边界写入文档）。
4. **inspect 增强**：每步持久化屏幕元素文本摘要并纳入 search 索引；动作执行后经可配置 settle 延迟再补真实 post 截图（默认值与上下限写入契约，时间换准确度；overlay 画在已截图像上，不需要额外参数）；按需生成动作标注 overlay（复用既有图像标注能力，失败不影响主流程，显式降级）；overlay 坐标必须做 point↔pixel 换算（@2x/@3x 是 iOS 标注错位的高频 bug 源，单列测试要点）；`view_step_details` 响应补 `device_serial`；语义澄清：Android 本就是同一步 pre/post（`after` 在失败/拦截时存在），iOS 现状 `after=下一步` 是错位，本次是向对齐修正，双端目标语义 = 同一步 pre/post；iOS 保持 JSON 响应形态并将与 ARTEMIS 的形态差异写入文档；每步双截图 + 文本摘要的体积与耗时预算见「风险与预算」。
5. **test_summary**：iOS 仅失败时合成的汇总必须带 `synthesized: true` 可选标记（同步任务状态类型），不得伪装成真实断言计数。
6. **任务统计**：iOS 套件路径只记一行（执行器侧记录；套件侧按持久化 `platform` 字段跳过自身记账，`ios-` 前缀作 fallback）；启动失败同样写入任务行。
7. **套件**：复位失败 reason 归 iOS 侧（不再包装成 `force-stop-failed`）；新增可注入的 iOS 日志采集器（`simctl log` best-effort：谓词过滤到目标进程、设超时与条数上限、不得阻塞套件；按任务时间窗采集并匹配 `error-codes.json`）；采集不可用时保留显式降级标记（`source:"none"` + degraded 原因）。
8. **崩溃**：`aos_crashes scan` 与批量扫描按持久化 `platform` 字段（`ios-` 前缀 fallback）路由到 DiagnosticReports 采集器；补扫按有界延迟/重试（崩溃报告异步落盘）并用「进程名 + 时间窗」匹配；执行器异常退出时保留补扫机会。
9. **差异对比**：`design_device_diff` step 模式对 iOS 放行（去掉 `platform="ios"` 拒绝）；跨进程可用性依赖第 3 条。
10. **app 锁定**：`locked_app_package` 存在时，执行器动作仅允许 `launch` / `terminate` / `openUrl` 指向该 bundle id。前台逃逸（universal link 拉起 Safari、SpringBoard 弹窗抢前台）为已知限制：ARTEMIS standalone 路径未发现周期性前台校验，iOS 做到同层动作约束即事实对等；「周期性前台校验」列入 backlog（含核对上游行为），文档同注明。
11. **iOS token 产物**：`ios-native` 档案的 token 输出文件指向生成的 Swift 枚举；同时生成 `Colors.xcassets` colorset（每 token 一个 colorset，R/G/B/A 浮点组件，含生成标记）与引用 asset 名的 Swift 枚举；命名做确定性规范化（colorset 名与 token 名、Swift 成员名 camel、asset 引用保持一致且可回读）；幂等与 overwrite 语义对齐既有栈 token 文件；canonical `tokens.json` 不变。
12. **缺口分析（iOS）**：颜色提取支持的形式清单——colorset JSON（浮点组件）、Swift `Color(red:green:blue:opacity:)`、`Color("assetName")`（经 colorset 解析）；其余形式声明不识别（诚实口径）。资产 basename 规范化剥离 `@2x/@3x` 后再匹配。
13. **资产导入（iOS）**：SVG 默认也以 `<name>.imageset` + `Contents.json`（`preserves-vector-representation`）落盘；`Contents.json` 仅在图片导出成功后写入，并统一走 hash/`duplicate_of` 幂等路径。
14. **strings（iOS）**：增加跨 `.lproj` 冲突检测；`.stringsdict` 解析、合并与冲突；locale 按 BCP-47 转换映射（iOS `zh-Hans`；Android 维持项目既有 `values-zh-rCN` 形式，不切 `b+`；边界用例 `zh-Hant-HK`、`pt-BR`/`pt-PT` 进 fixtures）；Swift 硬编码文案扫描采用保守 API 白名单（如 `Text(...)` / `Label(...)` / `.navigationTitle(...)` 等已知需国际化的 API），排除 `NSLocalizedString` 包裹、URL、数字与纯符号，并在报告中标注为启发式规则（可能误报）。
15. **栈检测**：iOS 检测放宽为限深搜索 `*.xcodeproj|*.xcworkspace`（排除 `node_modules`、构建产物等），不再硬要求 `ios/` 目录。
16. **多栈产出**：tokens/assets/brief/gap/scaffold/screen-map 因主栈限制跳过其他检测栈时，响应带显式 warning（被跳过栈列表）；全栈分别产出为 backlog。
17. **文档**：工具描述、README、DESIGN.md 同步实际支持范围与降级契约（含 `design_device_diff` 等过期口径修正）。
18. **测试缝接口变更**：manage/inspect 函数签名（runtime + args + deps）、套件 options 新增 iOS 日志采集注入项；其余均为内部实现，经既有缝测试。
19. **交付里程碑**：分两个里程碑——M1 执行与证据链（票据 01–07）、M2 设计代码化（票据 08–12）；M2 在技术上不依赖 M1，可并行或跟进，但 M1 优先落地。M1 内部建议顺序：01（跨进程持久化，02/07 的共同前置）→ 03/04/05/06 → 02/07；每票独立可合、独立可回滚。

## Testing Decisions

- **好测试的标准**：只测外部行为——入口的输入输出、落盘产物、响应标记与降级字段；不测私有实现细节；不依赖真实设备、PostgreSQL 与外网（沿用内存 store/pg-mem、假子进程、临时项目目录）。
- **沿用既有先例（按测试套件名）**：iOS 执行器（fake device + scripted chat）、iOS inspect（内存态 + diff）、套件 iOS（SuiteProxy + status fixtures + options 注入）、崩溃（collector 注入）、diff（StubProxy + stubDevice）、tokens（纯函数 + tmp 目录）、assets/strings/stack（tmp 目录 fixtures）。
- **本次覆盖的模块与要点**：
  - 执行器：参数说明字段（含双端同构化：Android 侧空 `warnings`）、`app_path` 拒绝、app 锁定动作限制与已知限制文档、post 截图计数与其 settle 时序、point↔pixel overlay、屏幕文本持久化。
  - manage/inspect：磁盘 fallback（run.json/status.json fixtures）、platform 字段路由、中断超时归因（注入 clock/liveness）、search 屏幕文本、`device_serial` 字段、post/overlay 语义、旧 trace 边界。
  - 套件：单行统计、启动失败入账、iOS reset reason、日志采集器注入（fake exec，含谓词/上限）、api-errors 降级标记。
  - 崩溃：platform 路由与有界补扫（fake collector）。
  - diff：iOS step 放行 + 跨进程。
  - 设计→代码：colorsets/Swift 枚举内容与幂等、gap 颜色解析（colorset/Swift fixtures，含形式清单边界）、`@2x/@3x` 匹配、SVG imageset 与 `Contents.json` 时序/幂等、strings 冲突/stringsdict/locale（边界 fixtures：`zh-Hant-HK`、`pt-BR`/`pt-PT`）/硬编码扫描、检测放宽 fixtures、多栈警告。
- **运行方式**：先 `npm run build` 再 `node --test`（`npm test`）；新增测试遵循 `test/*.test.js` 命名与既有 helpers。

## 风险与预算

- **每步 IO 预算**：每步两次截图（观察 + post）+ 元素文本摘要落盘；默认 30 步量级可接受，traces 体积随步数线性增长，沿用 `AOS_IOS_MAX_STEPS` 作步数上限保护。
- **post 截图 settle 延迟**：默认值与上下限进契约（默认 200ms、范围 0–2000ms、可配置）；延迟计入步进间隔。
- **长任务心跳**：interrupted 归因基准 = `status.json` 最后写入时间（心跳语义）；若未来步骤间静默变长，需同步补充心跳或调整阈值。
- **平台判别迁移**：`ios-` 前缀 → 持久化 `platform` 字段；迁移期并存（字段优先、前缀 fallback），旧 trace 边界写入文档。
- **iOS 日志采集上限**：`simctl log` 按谓词 + 超时 + 条数上限，超限即放弃并标降级，禁止 best-effort 变 hang。
- **崩溃补扫**：DiagnosticReports 异步落盘，补扫有界延迟/重试；「崩溃记录可能延迟入库」是预期而非 bug。
- **旧 trace 兼容**：升级前产生的纯内存 iOS trace（无 `run.json`/`status.json`）在新版本下查不到，属预期行为。

## Out of Scope

- ARTEMIS Pro 式 iOS 执行器（Planner/Checker/notes/`expected_output_desc` 生效）。
- `conversation_id` 唤醒通知（保持轮询，文档化契约）。
- 真机验收（路径保留、best-effort，不承诺）。
- scaffold 注册 Xcode 工程（`pbxproj` 管理）。
- `app_path` 的 `simctl install` 等价（backlog）。
- 全部检测栈分别产出（本次只做显式警告；全栈产出 backlog）。
- 层级观察的 OCR 融合。
- `locked_app_package` 的周期性前台校验（backlog，含核对上游行为）。
- `.xcstrings` 与 colorset dark appearances。
- 修改 `artemis` 子模块（全部改动在 AOS 侧）。

## Further Notes

- 已落文档：`CONTEXT.md`（平台对等、显式降级）、`docs/adr/0005-ios-contract-level-parity.md`。
- 完工标准（沿用仓库约定）：`npm run build && npm test && npm run lint` 全绿；行为/接口变更同步 `DESIGN.md`，用法变更同步 `README.md`；测试不依赖真机/PostgreSQL/外网。
- 验收设备：macOS 模拟器（idb → simctl）；真机路径文档注明未验证。
- 既有注入点可直接复用：simctl/idb 执行注入、`SuiteRunOptions`、`CrashScanner` collector、`loadTestRuntime`。
- 评审已考虑并拒绝：以 SQLite 替代 JSON trace 文件（TS 侧无 sqlite 依赖、`node:sqlite` 需 Node ≥22.5 而 engines 为 `>=20`，且默认 30 步规模不需要；改以原子写修复写损坏风险）；对齐 SwiftGen 输出（其输出随模板/版本漂移，真正互操作点是标准 colorset）；参数 fail-fast 拒绝（会破坏套件 `--model` 转发，改用机器可读 `warnings[]`）。
