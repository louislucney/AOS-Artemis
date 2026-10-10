# iOS 执行器理解能力强化（感知 / 循环 / 平台语义）

Status: implemented（2026-10-10；票 01–09 全部落地，票 00 已执行（视觉臂因无多模态模型未测，见文末「票 00 执行结果」）；实现记录见 DESIGN §13.59）

## Problem Statement

观察：同一份 `figma_generate_tests` 生成的用例，在 Android/ARTEMIS 上执行质量与通过率高于 iOS（AOS 模拟器执行器）。根因不在用例文本（`src/figma/test-gen.ts` 生成物平台中立），而在 iOS 执行器给决策模型的"感知上下文"与循环能力弱于 Android。

现状对比（Android/ARTEMIS vs AOS iOS 执行器）：

| 维度 | Android（artemis） | iOS（AOS 执行器） | 证据 |
|---|---|---|---|
| 截图 | 每轮 observation 带 JPEG 截图 | 仅可见文本元素 <3 或 `AOS_IOS_VISION_ALWAYS=1` 才附图，且由独立 vision 模型做决策 | `artemis/artemis/agents/flash/runner.py:340-396`；`src/ios/task-runner.ts:556-557` |
| 层级 | OCR 融合 `OCR Text:` 行 | 纯 idb/WDA 可访问性树；图标无 label 即"隐形" | `artemis/artemis/utils/visualization.py:306`；`src/ios/task-runner.ts:193-218` |
| 遮挡告警 | 互相遮挡（≥50% 重叠）输出 WARNING | 无 | `artemis/artemis/utils/visualization.py:173-255` |
| 历史 | 压缩历史 + 会话查询 | 仅最近 6 步单行 | `src/ios/task-runner.ts:24,238-241` |
| 无进展检测 | Pro 有规划/检查闭环 | 无（仅 system prompt 口头规则） | `src/ios/task-runner.ts:108` |
| 结束验证 | Pro Checker（默认 final） | 无；仅失败时合成 `test_summary`（`synthesized:true`） | `src/ios/task-runner.ts:418-429` |
| 失败日志 | adb logcat 可用 | 执行循环内不采集（日志仅套件后置） | `src/device/ios-log.ts`（无执行器接线） |

边界说明：`.scratch/ios-platform-parity/spec.md` 已将"层级 OCR 融合"（117 行）与"Pro 式 iOS 执行器"（111 行）列为 Out of Scope。本 spec 承接其中的"理解质量"部分，但**不做 Pro 全套**（无 Planner/双模型 Checker/notes），只做确定性的最小强化。

## Solution

四组小步改动，全部有显式开关、结构化标记与确定性降级；沿用 ADR-0005 原则（行为差异不静默）：

- **M1 感知**：每步视觉输入——多模态主模型直附截图；文本主模型经视觉感知产出结构化元素补充（OCR 等价，`sparse` 档沿用旧阈值）；层级遮挡告警。
- **M2 循环**：no-op 检测与策略提示；终态验证（单次 final checker）；历史压缩。
- **M3 平台语义**：平台约定收敛到 iOS 执行器系统提示词（`IOS_SYSTEM_PROMPT`），用例产物保持平台中立。
- **M4 排障**：失败任务设备日志采集与落盘；WDA/idb 观测解析失败重试一次。

## Review 决议（2026-10-10）

五个决策点（反馈结论全部采纳，细节修正见下）：

1. **附图默认策略**：开启。`AOS_IOS_VISION_MODE=auto` 下每步视觉输入（多模态主模型直附图；文本主模型每步视觉感知），token 成本换通过率；`sparse`/`off` 可降档/关闭。
2. **终态验证默认**：开启（`AOS_IOS_VERIFY=final`）；验证 fail 置任务 `failed`，且必须附失败证据（见决议 5）。
3. **真机日志缓冲**：默认开启（`AOS_IOS_LOG_FEEDBACK=0` 可关）。
4. **no-op 阈值**：1 步提示、3 步升级采纳；**排除 `wait` 动作**（显式等待不参与判定，防止误报）。
5. **失败日志不喂回循环**：采纳。只采集 + 落盘 + `mobile_inspect_trace` 可检索；喂回循环列 backlog。

反馈两个盲点的评估结论（含对反馈本身的修正）：

- **H1「坐标消费断层」成立，且比反馈更严重**：原设计要求视觉模型把像素 bounds ÷ scale 换算 pt——算术同样不该由模型承担。修正为：视觉模型只输出**截图像素 bounds**（不做任何换算）；执行器确定性换算 pt 并计算中心点，渲染与其他元素同构（决策 2）。**不采纳**"让视觉模型直接输出 tap_x/tap_y"（定位与算术都应留在确定性侧）。
- **C1「M3 注入位置」方向采纳、论据修正**：tests.json 保持平台中立正确；但不需要"检测到 iOS 再注入"——`src/ios/task-runner.ts` 本就是 iOS 专属执行器，平台约定属 `IOS_SYSTEM_PROMPT`（返回键、非 ASCII 输入规则已在 `task-runner.ts:105,107`）。M3 由"生成先验"改为"iOS 系统提示补全"，生成器零改动（决策 7）。"自相矛盾"说法不成立：Problem Statement 是根因诊断，M3 原为缓解项；但结论一致——用例产物保持中立更好。
- **验证防幻觉（反馈 3.1）方向采纳、机制修正**：以「`failed_items` 必须非空」作确定性门槛，**不采纳**"框不出截图区域就当验证无效"——后者会把真实失败放行（对测试工具而言假通过比假失败更危险），且与决议 2 冲突。`region` 仅作可选证据标注，不参与判定（决策 5）。
- **遮挡告警合并（反馈 3.2）采纳**：新增"主导遮挡层"单条全局告警 + 逐元素告警上限（决策 3）。
- **历史摘要（反馈 3.3）采纳**：摘要改为动作链序列（thought 首句 + action + outcome），不再堆屏幕文本（决策 6）。

### 二轮验证修正（v3）

- **验收协议工具修正（事实错误）**：原稿误用 `suite baseline`（某用例某步骤的像素基线，`suite-command.ts:257`）度量通过率；改用 `suite run` 报告对比 + `suite flake`（翻转矩阵/flaky 率，决策 10）。
- **感知节奏定义**：`AOS_IOS_VISION_MODE=auto|sparse|off`（见决策 1）——`auto` 每步视觉输入（多模态直附图；文本主模型每步视觉感知），`sparse` 保留旧阈值作省钱档。
- **no-op 判据修正**：元素签名为主并排除系统状态栏/系统 UI 节点；截图哈希裁剪上下系统带后再参与（见决策 4）。
- **验证观察修正**：`done` 后补一次 observation（best-effort），避免用动作前陈旧层级验证（见决策 5）。
- **删除 M3 规则②**（"打开应用用 launch"）：`lockedAppPackage` 已由执行器自动启动，模型无 bundleId 可用，规则会诱导编造（见决策 7）。
- **确定性补充**：V# 去重改为"规范化后完全相等或互相包含"；V# 独立配额（见决策 2）；票 03 验收含 `formatIosHierarchy` 契约与既有断言更新（见决策 3）。

### v3.1 增补（brainstorm 收敛）

- **票 00 前置（诊断先行）**：加一张 spike 票，先做失败归因与零代码 A/B，用数据校准 01-09 的优先级（见"票 00 前置"节）；M2 的 04/06 为 measured-gated。
- **验证兜底**：`hierarchy:"stale"` 且验证模型非多模态时直接 `unavailable`，不基于陈旧层级硬判（见决策 5）。
- **env 分层收口**：新增开关与既有执行器调参统一走 runtime 分层 env（项目 `.env` 打底、进程 env 覆盖），收口 §13.57 边界（见决策 1）。

## User Stories

1. 作为执行器使用者，我希望多模态模型默认每步都能看到截图，以便理解图标、图形化 UI（对齐 Android）。
2. 作为使用者（文本模型 + 独立视觉模型），我希望视觉模型产出"文本+中心坐标"的结构化补充元素并融合进层级，以便图标按钮不再不可见且无需自己做几何运算。
3. 作为使用者，我希望层级中疑似互相遮挡的元素带 WARNING（大面积遮挡层合并为单条），以便避免点到被覆盖元素且提示不膨胀。
4. 作为使用者，我希望动作后界面无变化时收到提示并换策略（`wait` 等显式等待除外），以便不陷入重复点击死循环。
5. 作为测试执行者，我希望模型自称完成时有独立验证并给出非空 failed_items 证据，以便 PASS/FAIL 可信。
6. 作为排障者，我希望长流程保留已发生事实（动作链压缩历史），而不是只看最近 6 步。
7. 作为测试执行者，我希望 iOS 平台约定（系统弹窗、返回键、非 ASCII 输入）由执行器系统提示统一承接，用例产物保持平台中立，以便同一份 tests.json 在双端复用互不污染。
8. 作为排障者，我希望失败任务的设备日志被采集并落盘到 trace，以便定位环境/应用问题。
9. 作为客户端，我希望新行为的开关与降级都有结构化标记与文档，以便预期一致。
10. 作为仓库维护者，我希望以上全部有不依赖真机 / PostgreSQL / 外网的测试。

## Implementation Decisions

### 票 00 前置（spike：失败归因 + 零代码 A/B，不产出产品代码）

0. **诊断先行**：
   - 对既有 iOS 失败 trace 做归因分类（`mobile_inspect_trace search` / `aos_tasks` / `suite report`），统计失败分布：找不到元素 / 坐标错 / 策略错 / 环境（键盘、弹窗）/ 输出格式错 / 其他；
   - 零代码对照实验：用现有开关 `AOS_IOS_VISION_ALWAYS=1` + `AOS_IOS_VISION_LLM=<强多模态条目>` 跑试点 tests.json，与默认配置对比通过率（现有代码的视觉路径已近似"每步多模态决策"）；
   - 产出：归因分布 + 对照结论，回写本 spec 并校准后续票优先级；M2 的 04/06 为 measured-gated（结论支持才执行；不成立则降为 backlog 并说明）；
   - 边界：trace 分析可离线做；A/B 需设备，作为立项实验而非 CI 项。

### M1 感知

1. **模型分流重构（票 01）**：`runLoop` 拆出"决策模型"与"感知来源"两条职责（现状：视觉路径由 `visionChat` 直接做决策，`src/ios/task-runner.ts:570-599`）：
   - 主模型多模态（`looksVisionCapable(active.model)`，`src/ios/vision.ts:12`）→ 每步将截图附到**主决策调用**（`messages` 带 `image_url`），决策仍由主模型做。
   - 主模型文本 + 可解析 `visionTarget` → 决策始终在主 chat；视觉模型只产出结构化感知文本（见 2），作为 prompt 补充段。
   - 无 `visionTarget` → 纯文本（现状）。
   - 开关：`AOS_IOS_VISION_MODE=auto|sparse|off`（默认 `auto`）：
     - `auto`：每步都有视觉输入——主模型多模态 → 截图直附主决策调用；文本主模型（有 visionTarget）→ 每步一次视觉感知（见 2）后融合进 prompt。
     - `sparse`：省钱档——文本主模型沿用旧阈值（可见文本 <3 才触发视觉感知）；多模态主模型仍每步附图。
     - `off`：纯文本，不调用视觉。
     - 兼容：`AOS_IOS_VISION_ALWAYS=1` 映射为 `auto`（语义近似：旧语义"强制走视觉路径"被 `auto` 覆盖，文档写明）；主模型文本且无 `visionTarget` 时 `auto` 等同 `off`，trace 记 warning（不静默）。
   - env 分层（v3.1 收口）：开关解析入口统一走 runtime 分层 env（项目 `.env` 打底、进程 env 覆盖，同 §13.57），新增开关与既有执行器调参（`AOS_IOS_MAX_STEPS` / `AOS_IOS_SETTLE_MS` / 视觉开关）一并迁移；行为变化=项目 `.env` 现在也生效（进程 env 仍优先），向后兼容。
   - trace：`IosTaskStep.perception` 扩展为 `"image" | "vision-text" | "text" | "text-degraded"`（现为 `src/ios/task-runner.ts:38`）；`vision` 元数据（model/source）保留并写入 `run.json`。
2. **视觉结构化感知（票 02，依赖 01）**：文本主模型路径下，视觉调用改为"感知提示词"：输入截图 + 屏幕像素尺寸，要求输出 JSON 数组 `[{text, bounds_px:[l,t,r,b]}]`——**bounds 用截图像素坐标，不做任何换算**（分工：模型只负责定位，算术全部留给执行器）。执行器按 `scale = 像素宽 ÷ 逻辑宽` 确定性换算为逻辑 pt（scale 未知时丢弃该行并计数），计算中心点，渲染为与其他元素同构的一行：`[V#] (模型视觉，可能有误) OCR Text: '...' | Center: (x,y) | Bounds: [l,t][r,b]`（pt）。
   - 去重（确定性）：与任一可见节点的 label/value 做规范化（trim）比较——完全相等或一方包含另一方 → 丢弃该 V# 行。
   - 预算：V# 行独立配额（上限 30 行），追加在元素列表之后，不挤占 200 行元素预算；bounds 非法/越界项丢弃并计数入 trace。视觉调用失败照旧 `vision_degraded` 降级纯文本。
   - 不做 macOS Vision framework OCR（需 Swift helper，超预算）——列为 backlog。
3. **遮挡告警（票 03）**：把 `artemis/artemis/utils/visualization.py:173-255` 算法移植为 TS 纯函数：两元素重叠面积比 ≥50% 输出 WARNING；排除同心父子包含（一个被另一个包含、中心距 < 最大边 20%、且面积比 >2 倍）；最多列 2 个 + `(+N more)`。应用到两个渲染点：执行器 `formatScreenForPrompt`（`src/ios/task-runner.ts:193-218`）与 `mobile_get_device_state` 的 `formatIosHierarchy`（`src/tools/ios-state.ts:65-100`）。行尾追加 `(WARNING: may overlap with [i], possible occlusion)`；元素 <2 或解析无 bounds 时跳过。
   - **合并规则（防 prompt 膨胀）**：某元素构成"主导遮挡层"（被其 ≥50% 覆盖的有文本元素 ≥3 个、且自身面积 ≥ 屏幕面积 40%，典型为键盘/授权弹窗）时，不逐元素输出，改为单条全局行：`检测到疑似大面积遮挡层 [i]（可能为键盘/弹窗）；建议先用 alerts/关闭操作处理再继续`；其余逐元素 WARNING 按重叠比取前 5 条。
   - **契约影响**：`formatIosHierarchy` 输出（0-1000 归一化）已被 DESIGN §13.42 与 parity spec story 19 测试锁定；票 03 验收必须同步更新文档与既有断言（执行器 prompt 快照测试同），否则 build 必红。

### M2 循环

4. **no-op 检测（票 04）**：每步动作后对比 pre/post：
   - 主判据：元素签名 sha256（type + label + value + 四周取整 bounds 排序；**排除系统状态栏/系统 UI 节点**——真机时钟/电量变化会破坏判据）。
   - 辅助：截图字节哈希先裁剪上下系统带（比例可配，默认≈5%）再比较；截图不可得时以签名单独判定。
   - 双不变 → 步骤记 `noop: true`；连续 ≥1 时下一轮 prompt 顶部加提示"上一步后界面没有变化：请核对元素列表，考虑先滑动/等待/收起键盘后重试"；连续 ≥3 升级为"建议换一个策略，否则可能持续无进展"，trace 步骤记 `noopStreak`。连续相同 `action+params` 两次也触发同样提示。**`wait` 动作不参与 no-op 判定**（显式等待预期无变化；feedback 修正）。纯确定性，不增加 LLM 调用。
5. **终态验证（票 05）**：`done(success=true)` 时先做一次验证调用（`AOS_IOS_VERIFY=final|off`，默认 `final`）：输入任务、自称 summary、最终 post 截图（若有）、以及 `done` 后补采的 observation（best-effort 一次 `nodes()`；失败则退回最后已知层级并标 `hierarchy:"stale"`，仅截图验证），输出 `{"pass":bool,"reason":str,"failed_items":[{item_text,evidence,region?}]}`；提示词明确"只依据当前界面与任务目标判断，不要采信自称，失败必须列出具体不符项"。结果处理：
   - 验证模型：默认与决策同 chat；`AOS_IOS_VERIFY_LLM` 可指定独立条目（防自我确认偏好）；截图仅在所选模型多模态时附上，否则纯层级验证；`test_summary` 记 `verification_model`。
   - pass → 照常 `completed`；`test_summary` 改为真实结构（`passed:1, failed:0, synthesized:false, verification:"model-final"`）。
   - fail → 任务置 `failed`，summary 前缀"验证未通过："，`failed_items` 采用模型输出；每项 `evidence` 附最终 post 截图相对路径（人工可复核），可选 `region` 仅作证据标注、不参与判定。
   - **防幻觉门槛（feedback 修正）**：`failed_items` 为空/全为空项时视为验证无效，降级 `unavailable`；仅"框不出区域"不构成降级条件。
   - **陈旧层级兜底（v3.1）**：补采失败（`hierarchy:"stale"`）且验证模型非多模态时，直接标 `unavailable`（不基于陈旧层级硬判）；验证模型多模态时可用最终截图继续。
   - 验证调用失败/不可解析 → 保持 `completed`，`test_summary.verification:"unavailable"` + warning（不阻塞）。
   - `done(success=false)` / `fail` / 超步数 → 现有合成逻辑不变（`synthesized:true`）。
6. **历史压缩（票 06）**：history 段 = 最近 `AOS_IOS_HISTORY_STEPS`（默认 8，限 4–20）步逐行明细 + 更早步骤的**动作链摘要**（每步一行：`thought` 首句（≤40 字）+ action + outcome；不再堆屏幕文本 dump，屏幕摘要仅在跳屏转折步保留一条），≤800 字符。不再无提示截断；摘要内容随 `run.json` 落盘便于复现。

### M3 平台语义

7. **iOS 系统提示补全（票 07，原"生成先验"缩小范围）**：平台约定属执行器系统提示词，**`tests.json` / `tests.md` / `tests.xlsx` 保持平台中立、零改动**（生成器不加 `platform` 参数/字段，不做"检测 iOS"——`src/ios/task-runner.ts` 本就是 iOS 专属执行器），同一份用例可在双端复用。
   - `IOS_SYSTEM_PROMPT`（`src/ios/task-runner.ts:85-110`）补全：系统权限/系统弹窗出现时优先用 `alerts` 处理再继续。返回键与非 ASCII 输入规则已在（105/107 行），不重复；"打开应用"由执行器自动启动 `lockedAppPackage`（`task-runner.ts:521-529`）承接，**不加"让模型自行 launch"的规则**（模型无 bundleId 可用，会诱导编造）。
   - "应用需已安装 / 套件 `--app` 指定 bundle"属套件操作前置（`suite run --app`，DESIGN §13.47），按现有口径文档化，不进入用例产物。

### M4 排障

8. **失败日志采集（票 08）**：任务因 `fail` / 超步数 / 执行异常 / 观察失败进入失败终态前，采集任务时间窗设备日志（best-effort、有界）：
   - 模拟器：复用 `IosLogCollector` 时间窗过滤（`src/device/ios-log.ts`），进程名取 `lockedAppPackage` 尾段。
   - 真机：任务启动时开启 idevicesyslog 环形缓冲（上限 200 行、仅内存；`AOS_IOS_LOG_FEEDBACK=0` 关闭），失败终态落盘缓冲。
   - 落盘 `logs/device.log`，标注 `source`/degraded 原因；失败 summary 追加"设备日志已采集（N 行，来源 X）"；`mobile_inspect_trace search` 可检索（复用整步 JSON 检索）。**不自动重试**；日志喂回循环列为 backlog。
9. **观测解析重试（票 09）**：真机 WDA `nodes()` 解析失败（`IosHierarchyParseError` → `parse_failed`，`src/ios/appium/service.ts:94-102`）时 300ms 后重试一次，仍失败才降级截图；模拟器 idb `describe-all` 失败同样重试一次。次数可配 `AOS_IOS_OBSERVE_RETRY`（默认 1）；重试不改变既有降级语义与错误码。

### 验收方法（量化"理解变好"）

10. **验收协议**（review 后补进票据验收标准）：选一份已生成的 tests.json（试点项目），在 iOS 模拟器上：
    - 改动前 `suite run --device <UDID> --app <bundle>` 跑基线，保存报告（用例级 PASS/FAIL 计数）；
    - 改动后重复跑，对比两份 `suite run` 报告的通过用例集合；如需稳定性与翻转矩阵，用 `suite flake` 重复采样对比（`suite baseline` 是像素基线，不用于通过率）；
    - 人工抽查 `mobile_inspect_trace` 的步骤截图、`perception` 字段与新增 trace 字段。
    - 目标：同模型同设备通过率不低于基线，且至少一个已知失败用例转 PASS（不承诺固定数值）。

## Testing Decisions

- 只测外部行为：注入 fake chat 捕获 messages（断言含 `image_url` / `OCR Text:` 行与 `Center:` / 遮挡 WARNING 与合并行 / no-op 提示）、trace 字段、`test_summary` 形态、工具入参出参。
- 沿既有缝：iOS 执行器（fake device + scripted chat，`StartIosTaskDeps` 已支持 chat/visionChat/device 注入，`src/ios/task-runner.ts:72-83`）；`ios-state`（fake WDA）；日志（fake exec）；新增纯函数（遮挡 / px→pt 换算与中心点 / no-op 签名 / 历史摘要）独立单测。
- 覆盖要点：M1 分支矩阵（多模态直通 / vision-text 每步 / `sparse` 阈值 / `off` / 文本主模型无 vision 降级）、开关分层解析（项目 `.env` < 进程 env 覆盖）、bounds_px→pt 换算、越界丢弃、V# 去重（相等/包含）与独立配额、遮挡合并阈值；M2 阈值与提示（noop 1/3、`wait` 不触发、系统节点排除与系统带裁剪、验证 pass/fail/unavailable、`failed_items` 空→unavailable、`hierarchy:"stale"` × 非多模态→unavailable）；M3 系统提示快照 + 断言 `figma_generate_tests` 产物零变化；M4 采集开关与降级、09 重试一次且错误语义不变。
- 运行：`npm run build && npm test && npm run lint` 全绿；不依赖真机 / PG / 外网。相关测试文件：`test/ios-task-runner.test.js`、`test/ios-vision.test.js`、`test/ios-device-state.test.js`、`test/ios-log.test.js`、`test/ios-appium-*.test.js`、`test/figma-testgen.test.js`（回归锁）。

## 风险与预算

- **token 成本**：`auto` 下文本主模型每步一次视觉感知（LLM 调用≈翻倍）＋ 多模态主模型每步附图（prompt token 增长）；`sparse` 退回旧阈值、`off` 完全关闭；文档给出估算。
- **视觉感知质量**：模型视觉可能误读；行内标注"可能有误"，去重 + 非法 bounds 丢弃；失败不阻塞主流程。
- **no-op 判据为启发式**：系统节点排除与系统带裁剪是近似；宁可漏报（少提示）不误报，判定与 `noopStreak` 写 trace 便于复盘。
- **验证误判**：final 验证是模型判断而非硬断言；默认与 Android Pro 默认（final）一致，可 `off` 关闭；验证 fail 置 failed 后，套件分域沿用现有 failure taxonomy。
- **真机环形缓冲**：idevicesyslog 长驻占用；200 行上限 + 可关闭；不改动既有套件采集路径。
- **默认行为变化**：`AOS_IOS_VISION_ALWAYS=1` 映射为 `auto`（语义近似，文档写明）；默认从"仅低文本时附图"变为"每步视觉输入"，属可感知变化，需 DESIGN 同步（客户端无接口变化）。
- **每步 IO 预算**：新增截图哈希与签名（内存计算）、失败时单次日志采集，均不改变每步两次截图与 settle 契约。

## Out of Scope

- Pro 全套（Planner、多层 Checker、notes / `expected_output_desc` 生效、`conversation_id` 唤醒）。
- macOS Vision framework OCR 本体（Swift helper）。
- 日志喂回循环的自动恢复重试。
- Android 侧任何改动（含 `artemis` 子模块）。
- 真机端到端验收（保持 best-effort；模拟器为验收面）。
- 用例产物（tests.json/tests.md/tests.xlsx）的平台字段与提示注入——决议：用例保持平台中立，平台语义由执行器系统提示承接。
- `.pen` 与设计→代码链路（属 `ios-platform-parity` 范围，本 spec 只碰执行与平台语义）。

## Further Notes

- 关联：`.scratch/ios-platform-parity/spec.md`（承接其 Out of Scope 的 OCR 融合与部分执行器能力）、`docs/adr/0005-ios-contract-level-parity.md`、`CONTEXT.md`（平台对等 / 显式降级）；实现后需同步 `DESIGN.md`（§6.9 / §13.44 / §13.45 相邻章节）与 `README.md`（开关与降级口径）。
- 票据拆分（review 后建 Jira）：**票 00 前置（spike：失败归因 + 零代码 A/B）** → M1 = 01 模型分流直通 / 02 视觉结构化 / 03 遮挡告警；M2 = 04 no-op / 05 终态验证 / 06 历史压缩（04/06 measured-gated，由票 00 结论决定）；M3 = 07 iOS 系统提示补全（原生成先验，范围缩小）；M4 = 08 失败日志 / 09 观测重试。依赖：01 → 02；其余互相独立、可并行、可单独回滚。
- 完工标准（沿用仓库约定）：`npm run build && npm test && npm run lint` 全绿；行为/接口变更同步 `DESIGN.md`，用法变更同步 `README.md`；测试不依赖真机 / PostgreSQL / 外网。

## 票 00 执行结果（2026-10-10）

- **环境**：macOS + iPhone 18 Pro Max 模拟器（`604E430A-…`）+ idb/Appium；active LLM `deepseek-flash`（文本模型）。**无多模态条目、无本地多模态模型（ollama/lmstudio/mlx 均无）→ 视觉臂（原"零代码 A/B"的 `AOS_IOS_VISION_LLM` 路径）在本环境不可执行**。
- **归因池**：仓库既有 iOS trace 仅 5 条 2026-10-06 观察冒烟（1 步完成、无失败），无历史失败可归因；改用自建试点用例 4 条（`.artemis/design/pilot-tests.json`：设置 App 的 关于本机 / 外观 / 搜索 Wi / 返回导航），对新旧两个构建做对照。
- **A/B 结果**（同一设备、同一模型、同一 tests）：
  - 旧构建（HEAD `72dca22`，独立 worktree 构建）：3/4 通过；步数 3/2/4/4。
  - 新构建（本批）：3/4 通过；步数一致；3 个成功用例终态验证全 `passed` 且证据正确（如"型号名称 iPhone 18 Pro Max / iOS 27.0"）。
  - 唯一失败两版相同：`搜索 Wi` 在 iOS 设置搜索返回"未找到"，模型动作与判断均正确——属**用例缺陷/数据环境**（应搜索 "Wi-Fi"/"wifi" 或英文 locale），非执行器理解问题。
- **缺陷收获（真实观察）**：全屏容器节点（`Bounds=[0,0][1000,1000]`，label 与页面同名）触发遮挡告警洪水 → 已修：面积 >90% 屏的结构性节点不参与告警（单测覆盖），复验后层级输出正常。
- **结论与校准**：本批次（验证/历史/no-op/平台规则）在可测范围内无回归、验证链端到端可用；**M1 感知收益仍未量化**，需在具备 VL 条目的环境补跑 `AOS_IOS_VISION_MODE=off|auto` 对照后才能定论；`AOS_IOS_VERIFY=final` 约为每个成功用例 +1 次 LLM 调用（+3~10s）。搜索用例建议修正措辞后纳入常规回归。
