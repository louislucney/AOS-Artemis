# Retro：Android 真机自动化三天返工（Maestro → MCP 原生 → 远端 runner）

> 日期：2026-11-08
>
> 状态：待 review（先固化事实与闸门，不改代码）
>
> 范围：2026-11-06 16:02 — 2026-11-08 11:04（周五真机首测 → 周日 0.2.3 复跑）；以及 11-08 晚间服务启动时暴露的存量 PG 迁移缺陷。
>
> 方法：Matt Pocock `retro`（改环境与流程，不追责个人）＋ 事实/根因/闸门三段式。
>
> 目的：把“为什么三天还没闭环”写成可核对的事实，并把“下次怎样才算完成”固化成可执行的验收闸门。本文只记录决策与流程，不改变运行时行为。

## 1. 结论

这不是“一个测试脚本改了三天”。实际是四件事叠加：

1. **起点选型错了**：最初的目标是复用 MCP 的 Android 执行能力，实际却先走了 Maestro web-runner；在真实环境（Windows 宿主、vivo 真机、公司代理）里，Maestro 的安装/驱动成本是致命约束，而选型时把它排在了“确定性”之后。
2. **架构边界没有先对齐**：runner 是下发/回传的桥，MCP（Artemis）是执行核心；中间一度试图让 MCP 直接接管，产生返工。
3. **验收粒度错了**：把“能编译、单测过、包能打出来”当成“交付可用”，没有在干净 Windows 主机上跑通 `setup → runner 上线 → 单用例下发 → 进度 → trace/结果回写` 的端到端链路。于是每次交付都由用户在 Windows/真机上试，一次暴露一个缺陷。
4. **会话与范围失控**：整个返工横跨周五到周日三天；主会话本身跨两天（周六 10:15 — 周日 11:04，90 条人工指令 / 2,616 条 assistant 消息 / 2 次 compaction），中途并行做面板 UX、审计、对比页；删 Maestro 时还连带删掉了“下发任务”入口。

“测试脚本”本身不是主因：Maestro YAML 是错误中间产物；改走 MCP 原生后，用例内容是 Excel → `taskDesc`，真正的失败点在执行环境的安装、启动、LLM/代理、进度上报和结果回写。

## 2. 事实

### 2.1 时间线

| 时间 | 在做什么 | 观察到的失败/结果 | 证据 |
|---|---|---|---|
| 11-06 16:02–18:41 | Maestro 真机首测 | vivo 上 driver 重装/半装、`DeviceServerDiedException`、冷启动 120s 超时；用户 16:53 指出安装负担，17:20 明确“一开始想引用 MCP 的代码”；18:41 用户拍板“删 Maestro” | 会话 `ses_e5177...`；计划 `2026-11-06-android-mcp-native-instead-of-maestro.md:5` |
| 11-06 18:42–11-07 00:45 | 转 MCP 原生 + adb-host 包 | 防火墙、Zscaler、Windows adb 暴露；用户指出 macOS 也能 adb、文档乱改、“这个问题已经反复出现” | 提交 `9135ca4`、`3cdad3d`、`316f3cd`；会话 `ses_e5177...` |
| 11-07 09:24–12:29 | runner 与 MCP 的边界、打包 | 用户纠正“runner 是桥、MCP 是辅佐”，并质疑“是不是一直都是你的幻想，没有真正的闭环”；随后暴露离线依赖、LLM key、中心项目路径等交付问题 | 会话 `ses_e4c35...` 09:50/09:54/10:50/12:22 |
| 11-07 12:29–17:00 | 离线包、venv、面板入口 | 解压 10 多分钟、批处理引号错误（`'H' is not recognized`）、重复记录；16:16 用户发现删 Maestro 把“下发任务”也删了 | 会话 `ses_e4c35...` 14:57/15:15/16:16；提交 `3cdad3d`、`a234a03` |
| 11-07 16:50–21:00 | 面板 UX 改造（与 runner 修复并行） | 16:00–21:59 共 43 个提交，其中大量 panel/UX/可读性 | `git log --since="2026-11-07 16:00" --until="2026-11-07 22:00"` |
| 11-07 21:56–11-08 01:45 | 真机执行闭环 | 启动 App 后无动作、trace 文件找不到、runner 实例冲突；01:27 用户指出“通信机制设计失败，不能反馈正确信息，还得翻 stdout.log” | 会话 `ses_e4c35...` 23:48–01:27；提交 `88887b1`、`68339f3`、`29dae48`、`6de121d` |
| 11-08 10:22–11:04 | 0.2.3 包复跑 | 仍有双字符输出（`使使用用内内置置…`）；11:02 任务领取后仍出现中心 LLM/代理告警；会话暂停 | 会话 `ses_e4c35...` 10:22/11:02 |
| 11-08 22:30–23:40 | 重启服务 | 发现存量 PG 迁移顺序缺陷：`excel_writeback_journal_pending_idx` 在补 `status` 列之前创建，导致整个 PG 装配降级到文件台账 | 本次修复；`test/db-init-tolerance.test.js` 6/6 |

### 2.2 返工不是同一个 bug 重复

远端链路至少暴露了 6 类独立缺口，每类都是真机跑到才出现：

- 认证：host token 与 LLM 代理的 `X-AOS-Host-Id` 约束（`9984a13`）。
- 网络：公司代理拦截发往中心 LAN 的 Python 请求（`35f420c`，DESIGN §13.329）。
- 地址：中心 URL / artifact 地址 / runner 可见性（`a234a03`、`da5c271`）。
- 应用：只下发用例与安装包时不会主动 launch（DESIGN §13.326）。
- 可观测：进度、失败证据、失败即停（`88887b1`、`68339f3`、`29dae48`、`6de121d`，DESIGN §13.328）。
- 交付：离线依赖、venv、解压、批处理引号、LLM key/中心项目路径提示。

这些都是合理修复，但**发现方式全部依赖用户手工回传 Windows/真机现场**，而不是交付前的自动验收。

### 2.3 起点决策的直接证据

- 2026-10-28 的远端计划明确写“**本计划只做 Maestro 执行链路**”（`docs/superpowers/plans/2026-10-28-web-remote-execution.md:22`）。
- 2026-11-06 的转向计划写明：“项目最初希望直接复用 MCP 的 Android 执行能力；实际落地时走了 Maestro web-runner”（`docs/superpowers/plans/2026-11-06-android-mcp-native-instead-of-maestro.md:5`）。
- 同一计划的对比表把 Maestro 的“确定性”评为高，把安装负担放在末列（同文件 `:42`）；真实环境里安装/驱动成本才是致命约束。
- 用户在周五 17:20 明确表示：原本想直接引用 MCP 的代码，是执行侧建议了 Maestro，执行到现在“它不怎么行”。

### 2.4 已有机制与真实缺口（对反馈的校正）

反馈里“当前 trace 和结果回写无法区分 App Bug / LLM 幻觉 / 环境超时”这句话只对了一半。

**已有：**

- `FailureDomain` 已有 `app-defect` / `environment` / `api-error` / `data-environment` / `behavior-or-design` / `design-inference` / `case-defect` / `unclassified`（`src/artemis/failure-taxonomy.ts:4-12`），环境与应用缺陷不是同一个域。
- `tests.json` / taskDesc 已带 `【AOS-EXPECT】` 的 assert/explore 步骤；iOS 执行器逐步核对并输出 `scriptHits` / `script_adherence`（DESIGN §13.32x，`DESIGN.md:383`）。
- 已有 `suite flake --runs N`、`--fail-on-flaky` 与 owner 签字的 quarantine（`DESIGN.md:393-396`），不是从零发明。

**缺口：**

- `suite run` 的逐例终态取 Artemis `status=completed`（`src/figma/case-runner.ts:405-409`）；`script_adherence` 只用于失败域分类，不参与 PASS/FAIL（`DESIGN.md:383` 明示“建议级”）。LLM 漏步但 App 没报错时，仍可能 PASS。
- `FailureDomain` 没有 `llm-failure` / `planner-failure`；模型拒答、格式错、死循环只能落到 `behavior-or-design` / `case-defect` / `unclassified`，不能自动重试或隔离。
- `verify_jira_issue` 的“强断言”只按 `scriptProvenance.asserts > 0` 分类（`src/workflow/verify-jira.ts:87-91`），不独立复核 assert 是否真的出现；强断言失败依赖用例整体 status，而不是逐条断言结果。
- 没有运行时 token 预算/熔断；`aos_usage` 明确标注“成本代理，不是计费”（`DESIGN.md:2467-2473`），web 结果虽有 `tokenUsage`，但不是门禁。

**结论**：反馈的“确定性 / 断言 / 成本”是真缺口；“无法区分”是过度表述。正确修法是在现有域与 `【AOS-EXPECT】` 上补硬闸门，而不是先推翻执行栈。

## 3. 根因

### 3.1 选型目标函数错了

把“确定性”排在“安装/运维成本”之前，却没有先在真实设备上做一次时间盒 spike。Maestro 的失败不是代码写错，而是**在错误的环境约束下选了它**：Windows 宿主、vivo 真机、公司代理、测试人员不想每台机器装 JDK + 两个 driver APK。

**教训**：执行栈选型的第一道闸门不是对比表，而是在目标设备上跑通一条最小用例；1 小时内过不了安装/冷启动/单例执行，就止损。

### 3.2 架构边界没有先对齐

用户对拓扑的定义很明确：runner 在下发端，MCP/Artemis 在执行端；中间一度试图让 MCP 直接接管，导致返工和“没有真正闭环”的质疑（11-07 09:50/09:54）。

**教训**：先写一页“谁下发、谁执行、谁存储、谁回传”的边界图，拿到用户确认，再写代码；边界图不进代码评审，不允许开工。

### 3.3 验收粒度错了

`check:runner-bundle` 只检查包内文件是否包含标记（`scripts/check-runner-bundle.mjs:41-48`），不验证行为。真正的验收链跨两台机器、两种系统、代理、PG 和真机；没有一条脚本在交付前跑过它，于是用户成为唯一的集成测试环境。

**教训**：交付定义必须是端到端证据，不是编译/单测/打包。没有 trace、面板进度和结果回写证据，不算完成。

### 3.4 会话与范围失控

- 主会话跨两天、2 次 compaction；已确认的事实（macOS 能 adb、runner 不该填 LLM key、不该填中心项目路径）被反复重新讨论。
- 删 Maestro 的同时删掉了“下发任务”入口（16:16），说明改动没有以用户任务为中心做回归。
- 16:00–21:59 的 43 个提交里混入大量面板 UX/可读性工作，关键路径被拉长。

**教训**：集成期冻结非关键路径；每个阶段结束写交接文档，不靠一条超长会话承载全部上下文。

## 4. 改进：下次怎样才算完成

### 4.1 P0 端到端验收闸门（唯一“完成”定义）

环境：干净 Windows 10/11 x64（仅 Node 20+、uv；不得预装项目代码或手工改过的环境）＋ 一台 Android 真机（USB 调试）＋ 一个最小用例（1 条 Excel 用例或 1 条 suite case）＋ 可选 `appPackage`。

| # | 步骤 | 通过标准 | 证据 |
|---|---|---|---|
| 1 | 下载离线包并校验 | `aos-artemis-runner-<ver>-win32-x64-offline.zip` 的 sha256 与发布记录一致 | 包名、sha256 |
| 2 | 解压到含空格路径 | 解压 ≤ 3 分钟；无乱码/双字符输出 | 解压日志 |
| 3 | `setup.cmd` | 不提示 LLM key、不提示中心项目路径；依赖安装成功 | setup 输出 |
| 4 | `configure.cmd` | 只填 Center URL、Runner token、Host ID；写 `.env` | `.env` 键名（不打印值） |
| 5 | `runner.cmd` | 60 秒内面板显示主机在线；无 PowerShell 弹窗；无代理告警 | 面板截图、runner 日志 |
| 6 | 下发单用例任务 | runner 领取；面板显示百分比/当前消息；App 被启动并执行动作 | 任务 id、进度截图 |
| 7 | 结果回写 | 任务终态明确；trace 有步骤；失败证据可点开；Excel（若映射）写回 | trace id、结果截图 |
| 8 | 失败注入 | 停掉中心 LLM 代理或杀掉 Artemis 子进程：任务在 180 秒内 `failed` 且错误类型明确，不得假 running 15 分钟 | 任务 id、错误码 |
| 9 | 确定性基线 | 同一用例连续 5 次（`suite flake --runs 5`）结果一致：全 PASS 或全 FAIL，失败域一致；不一致 → owner 签字 quarantine，不计回归通过率 | flake 报告、quarantine 条目 |
| 10 | 硬断言 | 每条回归用例至少 1 条 hard assert（`【AOS-EXPECT】kind=assert` 或 `acceptance.json` / UI 语义）；终态必须由确定性节点/文本检查支撑；只有 LLM “completed” 而无硬断言 → `inconclusive`，不得 PASS | tests.json、trace、adherence、报告 |
| 11 | 成本闸（**后续项，不挡本次闭环**） | 记录每例 `tokenUsage`；设定单例/单批预算；超限告警或中止；不得用行业均价代替实测 | token 报告、预算配置 |

**只有 1–8 全部通过，才允许说“runner 链路通”；1–10 全部通过，才允许说“回归测试可用”。** 第 11 步是闭环之后的成本治理，按当前决定暂缓，不进入本次门禁。任一步失败：记录为一条独立缺陷，只修该缺陷，不在同一次改多个点。

**失败域补充**：在现有 `FailureDomain` 上增加 `llm-failure`（模型拒答/格式错/规划死循环/工具调用异常）。归类优先级保持“强信号优先”：崩溃/环境/API/数据 > `llm-failure` > `design-inference` / `behavior-or-design` > `case-defect` > `unclassified`。只有经裁决确认的 `app-defect` 允许自动建 Jira；`behavior-or-design` / `design-inference` 先人工裁决，不直接报 Bug（“断言不通过”不等于应用缺陷，也可能是用例或设计变更）。`llm-failure` 自动重试一次后隔离，`environment` 转人工/重跑，`case-defect` 回生成侧。5 次是最低门槛，关键用例用 `suite flake --runs 10`，不要对全量用例每天做 10 次。

### 4.2 P0 决策闸门

- **新执行栈**：先在目标设备上做 ≤ 60 分钟 spike；过不了安装/冷启动/单例执行，立即止损，不进入计划。
- **架构边界**：一页图（下发/执行/存储/回传）＋ 用户确认，先于代码。
- **范围**：集成期只允许关键路径改动；UX/审计/对比页等一律延后，记入待办，不混入同一天。
- **顺序**：先闭环，再优化成本；没有一次完整绿色链路之前，不做 token 预算门禁（当前决定：第 11 步暂缓）。
- **会话**：一个阶段一个会话（不超过 1 天）；结束写交接：事实、未决失败、复现命令、下一步。恢复时读交接，不读全量转录。

### 4.3 P1 工程闸门

- 每个跨主机/跨环境缺陷必须补一个契约测试；修完 `npm test` 全绿（除显式 quarantine）。
- `check:runner-bundle` 的检查项与测试夹具必须同步；新增标记时同一次提交更新 fixture，不留红。
- 包发布记录必须包含：版本、sha256、构建时间、包含的环境变量标记、验收任务 id/trace id。
- 服务启动/存量库升级也要有“旧库形态”回归（本次 PG 迁移顺序缺陷即此类）：迁移语句只允许在补列之后建依赖索引。

### 4.4 落地物（本文 review 通过后再做）

| 文件 | 作用 | 完成标准 |
|---|---|---|
| `scripts/runner-smoke.mjs`（新增） | 把 4.1 的 1–8 串成可重复脚本，逐跳打印 PASS/FAIL 与证据路径 | 干净 Windows 上 exit 0；失败时指出断点 |
| `test/runner-bundle-contract.test.js` | 同步 `check:runner-bundle.mjs:41-48` 的代理/通知标记 | `npm test` 全绿 |
| `docs/windows-runner-quickstart.md` | 把 4.1 的 1–8 步写进用户手册 | 用户按文档可独立完成 |
| `package.json`（可选） | `verify:runner`：契约检查 + 冒烟入口 | 一条命令可复跑 |
| `suite flake` + `quarantine.json`（复用现有） | 跑 4.1 第 9 步；隔离条目带 owner/signedAt | 5 次结果一致；不一致有签字隔离 |
| 运行时硬断言（改动 `case-runner`/执行器） | 跑 4.1 第 10 步；无硬断言的用例判 `inconclusive` | 断言缺失不会出现 PASS |
| 预算配置（新增 env，如 `AOS_SUITE_TOKEN_BUDGET`）（**暂缓**） | 闭环后跑 4.1 第 11 步；按实际 `tokenUsage` 熔断 | 超限告警/中止 |

不在本文范围：修改 runner 行为、补新功能、继续面板 UX。先让 4.1 的 1–8 在 0.2.5 包上拿到一次全绿证据；第 9–11 步是“回归可用”的附加闸门，需另开实现任务。

### 4.5 替代方案评估（不在本次范围，先试点再决策）

反馈提出 Appium/云真机/混合三条路。三条都值得评估，但都不能替代“先在当前栈上做确定性验证”；否则会重复“换栈 → 再返工”。

| 方案 | 真实收益 | 真实代价/风险 | 何时采用 |
|---|---|---|---|
| A. Appium 2.x + UiAutomator2 | 执行路径确定；生态成熟；无 LLM 运行时成本 | 仍需 JDK/Node/Android SDK + UiAutomator2 driver APK；locator/等待仍会 flaky；用例生成、断言、证据、结果回写要重新接一遍 | 当前栈在 4.1 第 9 步连续失败，且失败可归因于 LLM 规划而非环境 |
| B. 云真机（WeTest/EMAS/BrowserStack） | 免本地驱动/USB/代理；自带录像/日志 | 需过数据安全/合规/预算；公司代理可能同样拦云 API；设备型号/系统版本受平台限制 | 本地硬件/代理是主要瓶颈，且允许上传 App 与截图 |
| C. 混合（LLM 生成 Appium/Maestro 脚本，传统框架执行） | 运行时确定；LLM 只做生成与 self-healing | 重新引入脚本生命周期/版本/维护；和当前“去 Maestro 脚本生成”的决策相反；生成质量仍需验证 | A 试点证明 Appium 可跑，且脚本维护成本可接受 |

**决策规则**：不因一次失败换栈。先跑 4.1 的 1–11；若第 9/10 步失败且证据指向 LLM 规划，再开 1 天 Appium spike（同一台 vivo、同 3 条用例、同一套断言），用 5 次一致性、单例 token、setup 时间、证据质量四项对比。云真机/混合只在 A 的 spike 数据出来后评估。

### 4.6 反馈逐条评估

| 反馈点 | 判定 | 依据 | 处置 |
|---|---|---|---|
| LLM 非确定性 → 假 PASS/随机 FAIL | **成立（核心）** | `src/figma/case-runner.ts:405-409` 终态取 `status=completed`；adherence 仅用于分类；无 `llm-failure` 域 | 4.1 第 9/10 步；补 `llm-failure` |
| 无法区分 App Bug/LLM 幻觉/环境超时 | **部分成立** | 已有 environment/app-defect/data-environment 等域（`src/artemis/failure-taxonomy.ts:4-12`）；缺 LLM 域与“漏步但 completed” | 保留现有域，补 `llm-failure`；只有 app-defect 建单 |
| Token 成本失控 | **成立（缺口，按决定暂缓）** | 无预算/熔断；`DESIGN.md:2467-2473` 明确“成本代理不是计费”；13.46 元/百万有信通院 2026 报告依据 | 先闭环；闭环后再做 4.1 第 11 步，当前不设门槛 |
| Excel→taskDesc 缺断言 | **成立（关键）** | `【AOS-EXPECT】` 存在但为建议级（`DESIGN.md:383`）；`src/workflow/verify-jira.ts:87-91` 只按 `asserts>0` 分强/弱 | 4.1 第 10 步；无硬断言 = `inconclusive` |
| 建议 Appium 2.x | **可评估，不应立即切换** | “绝对确定性”过度；Appium 同样要 driver APK 与 JDK/Node/SDK；但生态成熟，可作 fallback | 当前栈过 5 次闸门后再做 1 天 spike |
| 建议云真机 | **可评估，受约束** | 解决本地硬件/代理，但数据安全/网络/成本未知 | 先确认合规与预算 |
| 建议混合 | **可评估，成本高** | 可恢复确定性执行，但重新引入脚本生命周期；与当前去脚本决策相反 | 作为 A 试点后的候选 |
| “全面转向 LLM 驱动” | **表述过强** | 当前是设计派生 expectations + LLM 规划 + iOS 确定性核对；不是纯 LLM | 文档写清“混合”，避免误读 |

> 成本数据来源：中国信通院《大模型词元服务性能监测报告（2026年）》（2026-10-23）：国内词元归一化均价从 2025 年下半年的 6.8 元/百万涨至 2026 年的 13.46 元/百万。该数字只作行业背景，不替代本项目按 `tokenUsage` 实测的单例成本。

## 5. 当前状态（2026-11-08 23:40）

已落地：

- Maestro web-runner 与脚本生成已移除（DESIGN §13.317）；MCP 原生执行路径已接上。
- runner 0.2.3/0.2.4/0.2.5 代码已提交：进度上报、失败证据、失败即停、host token、代理绕过/重试诊断（DESIGN §13.328/§13.329）。
- 0.2.4 的代理/通知环境变量已写入构建脚本；0.2.5 修复了 offline 包 `runner.cmd` 不走内置依赖的问题（`deps\win32-site-packages.zip` 存在时调用 `setup-offline.cmd`）。
- 本次 PG 迁移顺序缺陷已修：SCHEMA 不再提前建 `status` 索引；`regression_tasks_execution_mode_idx` 移到补 `device_serial` 之后；`test/db-init-tolerance.test.js` 6/6。

尚未证明：

- 没有一次在干净 Windows 主机上使用 **0.2.5 包**跑通 4.1 的 1–8。最后一次有记录的真机运行（11-08 11:02）仍使用 0.2.3 包，并停在中心 LLM/代理告警。
- 当前工作区仍有 1 个红测试：`test/runner-bundle-contract.test.js:52` 的 fixture 未同步 `check-runner-bundle.mjs:41-48` 新增的代理/通知标记。这是工作区 WIP，需与包检查同一次提交修绿。
- 因此“从周五搞到现在还没处理好”在事实层面成立：缺的是端到端绿色证据，不是再补一个功能。

## 6. 证据索引

### 6.1 会话（本机 OpenCode 数据库，未入库）

- `ses_e4c35a864ffeTfWIyBF2G3wiUR`：2026-11-07 10:15 — 2026-11-08 11:04；90 条人工指令、2,616 条 assistant 消息、2 次 compaction。本文时间线的主要来源。
- `ses_e5177aeebffekGpQCgfxQSB5Ic`：2026-11-06 09:45 创建；16:02–18:41 的 Maestro 真机首测与转向记录。
- 转录未复制进仓库；本文只保留时间、提交和转述，不含任何密钥/令牌。

### 6.2 关键提交

| 提交 | 日期 | 内容 |
|---|---|---|
| `9135ca4` | 11-06 18:42 | 优先 MCP 原生执行；新增 adb-host 包与 appPath；停用新 Maestro web job |
| `3cdad3d` | 11-06 18:59 | 移除 Maestro web-runner 与脚本生成 |
| `316f3cd` | 11-06 23:43 | 提供 macOS adb-host 包并澄清本机 Mac adb |
| `a234a03` | 11-07 20:17 | 允许 legacy 项目定向下发并公布中心 URL |
| `da5c271` | 11-07 20:35 | 每任务刷新中心 LLM、公布 LAN artifact URL |
| `88887b1` | 11-08 01:36 | 持久化并渲染 runner 任务进度 |
| `68339f3` | 11-08 01:40 | runner 上报 suite 执行进度 |
| `29dae48` | 11-08 01:37 | Artemis 终端错误快速失败 |
| `6de121d` | 11-08 01:40 | 上传失败证据、取消时停止子进程 |
| `9984a13` | 11-08 10:23 | host token 可认证 LLM 代理请求 |
| `35f420c` | 11-08 10:33 | runner LLM 绕过公司代理并检测重试 |

### 6.3 文档/代码锚点

- `docs/superpowers/plans/2026-10-28-web-remote-execution.md:22`：只做 Maestro 执行链路。
- `docs/superpowers/plans/2026-11-06-android-mcp-native-instead-of-maestro.md:5`：Maestro 真机失败的背景。
- 同文件 `:42`：选型对比表（确定性 vs 安装负担）。
- `DESIGN.md:3892`（§13.317）：移除 Maestro。
- `DESIGN.md:4006`（§13.328）：执行进度与异常可见性（0.2.3）。
- `DESIGN.md:4018`（§13.329）：代理绕过与重试诊断（0.2.4）。
- `DESIGN.md` §13.331：offline 包依赖入口修复（0.2.5）。
- `scripts/check-runner-bundle.mjs:41-48`：包契约检查项。
- `test/runner-bundle-contract.test.js:52`：当前未同步的 fixture。
