# 双层测试产物与跨端一致性：当前风险与收敛评估

> 日期：2026-10-23
> 状态：待评审
> 关联设计：`docs/superpowers/specs/2026-10-23-design-to-test-dual-layer-design.md`
> 关联实现：提交 `8217b7d` / `82ef0ca` / `da9d133` / `a9966ed`（DESIGN §13.202–§13.203）

## 1. 背景

在完成「人类层 / 执行器层双层产物」「API 变更四态」「跨端 `semanticId` 与 `suite parity`」并在 `starbuckstw`（Android）与 `starbucks-ios-taiwan`（iOS）上完成同源生成核验后，以下为当前系统中仍然存在的真实风险点。

本文档按影响等级（P0 / P1 / P2）罗列现状、触发条件、后果及建议方案，供决策哪些进入下一轮实现。

---

## 2. 风险总览

| # | 等级 | 风险项 | 触发条件 | 建议动作 | 工作量 |
|---|---|---|---|---|---|
| R1 | **P0** | Excel 编辑「预期结果/测试数据」不触发 `taskDesc` 重建 | 测试人员只改预期或数据、未改步骤便导入 | 哈希扩为 `steps + preconditions + expected + testData` | 小（~30 行） |
| R2 | **P0** | `apiReview.status = pending` 时未阻断执行 | 声明有新/改 API 但未补说明就直接跑 `suite run` | `suite check` / `suite run` 默认拦截 pending，`--allow-pending-api` 放行 | 小（~50 行） |
| R3 | **P0** | Android / iOS 仍各自存放 `flows.json` 与 `reconciliation.json` | 单端重提设计或单端跑出新对账升级边 | `aos.config.jsonc` 增加 `design.sharedDir` 指向共享设计目录 | 中（半天） |
| R4 | **P0** | `apiSpec` 只留档，未进入执行器与错误码校验 | 新接口字段/状态码异常但 UI 勉强走通 | 将 `apiSpec` 摘要注入 `taskDesc`，并可选关联 `error-codes.json` | 中（半天） |
| R5 | **P1** | `displayId`（跟 `semanticId`）与执行/隔离 ID（`caseId`）双轨 | 两端 locator 不同导致 `caseId` 不同但 `TC_` 相同 | 隔离/基线/统计支持按 `semanticId` 或 `displayId` 定位 | 中（半天） |
| R6 | **P1** | 功能分组命名（`module`）存在 LLM 非确定性 | 无候选名时两端分别调 LLM 起名 | 按 `flowsFingerprint + screenSet` 缓存功能名 | 小（~40 行） |
| R7 | **P2** | 设计稿无文字且图层名技术化时退化为「点击『按钮』」 | 同屏多个无文字图标/按钮 | 优先消费 `vision` 语义 label，其次保留备注降级提示 | 小–中 |
| R8 | **P2** | `tests.md` 每条用例最多嵌入 3 张设计图 | 4 屏以上的长流程用例 | 去重后按用例涉及的全部屏幕嵌入（或可配上限） | 小（~20 行） |
| R9 | **P2** | 面板角色与 CMS 限流/配额为单进程内存级 | 反向代理部署或进程重启 | 维持内网边界声明；跨实例时再落 PG/网关 | 暂不改 |

---

## 3. 逐项详细评估

### R1（P0）：Excel 编辑「预期结果 / 测试数据」不会触发 `taskDesc` 重建

- **现状**：隐藏「执行器」sheet 中的 `humanStepsHash` 目前只计算 `steps + preconditions`（`src/figma/test-xlsx.ts`）。`importTestDocument` 导入时若哈希一致，直接复用隐藏 sheet 的原始 `taskDesc`。
- **问题**：测试人员在 Excel 里没有改步骤，只修改了「预期结果」或「测试数据」列，然后用 `run_regression` 导入执行——系统会认为“未编辑”，继续执行旧的预期和旧的测试数据。
- **后果**：测试人员以为改了预期/数据，实际真机跑的还是旧指令（静默失效）。
- **方案**：
  1. 将哈希输入扩为：`steps + preconditions + expectations + testData`；
  2. 当「步骤未改、仅预期或测试数据被编辑」时，可选择重建 `taskDesc` 并在 `importWarnings` 中明确指出修改了哪一列；
  3. 补一条单测：只改 Excel 的「预期结果」列后导入，断言 `taskDesc` 更新且 `caseId` 保留。

### R2（P0）：`apiChange = new | modified` 且 `status = pending` 时未阻断真机执行

- **现状**：生成阶段支持“先生成、待后续补充 API 说明”（`apiReview.status = "pending"`）。但 `preflightGeneratedTests`、`suite check`、`suite run` 和 `design_to_test(run:true)` 目前不检查 `apiReview.status`。
- **问题**：用例处于“已知涉及新/改 API 但尚未提供接口说明”的状态时，仍然可以直接上真机执行。
- **后果**：执行器在不知道新接口契约的情况下跑失败，结果被归类为应用缺陷或环境问题，污染回归统计。
- **方案**：
  1. `preflightGeneratedTests` 读取 `tests.json.apiReview`；
  2. 当 `status === "pending"` 时，`suite check` / `suite run` / `design_to_test(run:true)` 默认拦截并提示先补充 `apiSpec`（或传 `--allow-pending-api` / `allowPendingApi:true` 显式放行）；
  3. `status === "unknown"` 时只给 warning，不硬拦截（兼容存量未声明项目）。

### R3（P0）：Android / iOS 各自持有 `flows.json` 与 `reconciliation.json`，容易再次漂移

- **现状**：本次验证通过把同一份 `flows.json` 与 `reconciliation.json` 同步到两个项目，证明了同源输入下 `suite parity` 差异为 0。但两个项目的 `.artemis/design/` 仍是独立目录。
- **问题**：
  - 只在一端运行 `pen_extract_flows` / `figma_extract_flows`；
  - 或只在一端运行 `suite run` 触发探索边自动升级写回 `reconciliation.json`；
  两端下一次生成就会再次产生不同的步骤（例如一端是探索步、另一端是点击 Banner 的硬断言）。
- **方案**：
  - 在 `aos.config.jsonc` 支持可选 `design.sharedDir`（或环境变量 `AOS_SHARED_DESIGN_DIR`）；
  - canonical 资产（`flows.json`、`acceptance.json`、`reconciliation.json`、`ui-contract.json`、`screens/`）读写共享目录；
  - 平台专属资产（`screen-map.json`、生成的 `tests.*`、`case-sets/`、`runs/`）仍留在各自项目的 `.artemis/design/`。

### R4（P0）：`apiSpec` 仅作为文档留档，未进入执行器与 `api-errors`

- **现状**：`apiSpec` 内联保存在 `tests.json.apiReview.apiSpec`，并渲染到 `tests.md` 与 `tests.xlsx` 的「API 说明」sheet。但 `taskDesc` 生成时不读取 `apiSpec`。
- **问题**：agent / 执行器拿到的 `taskDesc` 不包含本次新增或修改的接口说明；同时 `.artemis/design/error-codes.json` 也不会自动获知新接口的错误码。
- **方案**：
  1. 当 `apiReview.status === "provided"` 时，在 `taskDesc` 的 `【真实数据】` 条款后追加精简的 `【API 变更说明】`（截断至合理长度，如 ≤1500 字），让执行器在真实请求链路发生异常时能对照接口说明报告 blocked/failed；
  2. 保持 `semanticId` 与人类层步骤不受 `apiSpec` 文本影响。

### R5（P1）：`displayId`（`TC_xxxxxx`）与 `caseId`（`case-xxxxxxxxxxxx`）双轨

- **现状**：`displayId` 已改为从跨端稳定的 `semanticId` 派生，保证 Android/iOS 的 Excel 主表编号一致；而 `caseId` 为兼容历史台账/基线/隔离，仍包含机器层 `steps`（含 i18n/a11y）。
- **问题**：当一端有 a11y 标识、另一端没有时，两端的 `TC_xxxxxx` 相同，但底层的 `caseId` 不同。用户在 CLI 执行 `suite flake --cases` 或配置 `quarantine.json` 时若填了 `TC_xxxxxx` 或跨端混用 `caseId` 会不命中。
- **方案**：
  - `quarantine.json`、`suite run --case`、`suite flake --cases` 同时接受 `caseId`、`semanticId` 和 `displayId` 匹配；
  - 内部台账主键仍保持 `caseId` 不变，零迁移成本。

### R6（P1）：功能分组命名（`module`）的 LLM 非确定性

- **现状**：`nameFeatures` 在没有候选名时会调用 active LLM 生成功能名。
- **问题**：即使 `flows.json` 完全相同，Android 和 iOS 分别调用 `figma_generate_tests` 时，LLM 可能返回不同措辞，导致 `module` 与 case-set 文件名不一致，`suite parity` 在 `module` 字段报警。
- **方案**：
  - 将功能命名结果按 `flowsFingerprint + 屏幕集合` 缓存在 `flows.json`（或共享设计目录）中；
  - 同一份 flows 二次生成直接复用已命名的 feature 名称，不再重复调 LLM。

### R7（P2）：设计稿无文字且图层名技术化时，人类层退化为通用控件名

- **现状**：当节点没有 `textHints`，且图层名为 `Frame 2444` / `App Button` / `Icons/search` 时，人类层会净化为「按钮」「图标」「可点击区域」，并在转化率超阈值（回退 ≥3 或密度 >20%）时写入「备注/待确认」。
- **问题**：虽然消除了技术词，但同屏若有多个无文字图标，测试人员只看步骤文字无法区分点哪一个。
- **方案**：
  - 若 `flows.json` 含 `vision` 识别出的语义元素（`label` / `intent`），`humanElementLabel` 在 `textHints` 缺失时优先采用 vision label，其次才回退通用控件名。

### R8（P2）：`tests.md` 每条用例最多只嵌入 3 张设计图

- **现状**：`renderMarkdown` 对每条用例只取 `refs.slice(0, 3)`，超出部分显示 `…（共 N 屏）`。
- **问题**：长流程（如 7–8 步点单全链路）后半段涉及的页面在 Markdown 中没有缩略图。
- **方案**：
  - 按用例内去重后的屏幕顺序嵌入全部屏幕图片（或将上限提高到 8–10 张），避免长流程后半段无图可看。

### R9（P2）：面板角色与 CMS 限流/配额为单进程内存级

- **现状**：`AOS_PANEL_ROLE` 为进程级角色；CMS Open 的 `--rate-limit` 与 `--max-jobs-per-day` 按 `socket.remoteAddress` 存于进程内存。
- **问题**：进程重启后配额计数归零；若前置反向代理，所有客户端共享代理 IP；面板无法按登录账号区分权限。
- **方案**：当前符合内网工具与轻量开放服务定位，已在 `DESIGN.md` 与 `README.md` 声明边界；未来若多实例公网化，再接入网关鉴权或 PG 配额表。

---

## 4. 建议落地顺序

1. **第一批（建议立即做，小改高收益）**：
   - **R1**：修 Excel 导入哈希，纳入预期结果与测试数据；
   - **R2**：`apiReview.status === "pending"` 在 `check/run` 阶段默认拦截；
   - **R8**：放宽 `tests.md` 每用例 3 张图的限制（按去重屏幕展示）。
2. **第二批（跨端与执行闭环）**：
   - **R4**：`apiSpec` 注入 `taskDesc`；
   - **R5**：`--case` / `quarantine` 支持 `displayId` 与 `semanticId`；
   - **R6**：功能命名写回/缓存，消除跨端 LLM 命名漂移。
3. **第三批（架构共享源）**：
   - **R3**：`design.sharedDir` 共享设计真源目录；
   - **R7**：`humanElementLabel` 串联 vision 语义标签。
