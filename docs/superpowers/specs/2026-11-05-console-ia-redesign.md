# 控制台信息架构重构设计（测试资产 / 新建测试 / 任务与结果）

> 2026-11-05 · 状态：Phase 1–3 主体已实现；收尾项待办  
> 关联：`PRODUCT.md`、`DESIGN.md`、`docs/superpowers/specs/2026-11-05-ios-artemis-runtime-design.md`、`.impeccable/critique/2026-11-05T02-16-03Z__src-console.md`

## 0. 一句话

把“按流水线分页面”改成“按用户任务组织”：**一个测试资产中心、一个新建测试入口、一个任务与结果列表**。用例库不再是独立世界，网页测试/套件回归也不是导航目的地。

## 1. 为什么要重构

最近连续出现的问题不是单点 bug，而是同一个 IA 根因的不同表现：

- 安装包在“测试资产”，用例库不在；用户按资产类型找，页面按流水线分。
- “测试资产”没有一级入口，只能从空状态提示或正文链接进入。
- 资产 URL 带执行机 host，项目 host / 执行机 host / runner host 混在一起。
- 面板能发现项目，但台账未登记，用户提交时才看到“项目未注册”。
- 上传入口只在列表为空时出现，有数据后消失。
- 用例库、测试资产、网页测试、下发测试、任务、批次，同一组对象多个名字。
- 任务详情的“重新派发”对 Web 任务会创建错误的套件任务。

结论：继续在现有页面上补链接，会持续产生同类问题。需要一次 IA 收敛，而不是继续点修。

## 2. 目标与非目标

### 2.1 目标

1. 用户从任意项目页，最多 2 次点击就能上传任意测试资产。
2. 用户从任意项目页，最多 2 次点击就能开始套件回归或网页测试。
3. 资产、测试类型、任务、批次四个概念各有唯一入口和唯一名称。
4. 项目 host 与执行机 host 在 URL、表单、错误信息中彻底分开。
5. 每个列表页始终有创建/上传动作；每个空状态都有下一步；每个错误都有恢复路径。
6. 未登记项目在进入表单前就显式处理，不在提交时报“未注册”。
7. Web 任务与套件任务共用任务/结果视图，但重跑动作按类型分派，绝不混淆。
8. 旧路由全部 redirect，书签和外部链接不失效。

### 2.2 非目标

- 不合并底层数据模型：用例集、Web 资产、回归任务仍用现有表。
- 不引入前端构建链；继续服务端渲染 HTML/CSS。
- 不重做视觉世界；沿用 CSDC tokens 与现有组件。
- 不删除 CLI/API；CLI 路由保持不变。
- 不做资产删除/回收站（后续单独设计）。

### 2.3 反目标

- 把“测试资产”做成另一个隐藏页。
- 在“用例库”和“网页测试”各自再放一套上传。
- 用执行机 host 作为项目身份的一部分。
- 让任务列表按页面来源分成两套。
- 用 conditional hint 作为唯一入口。

## 3. 用户心智模型

QA 的实际顺序是：

1. **我有什么资产？**（Excel、安装包、资料、参考图、脚本）
2. **我要跑什么？**（套件回归 / 网页测试）
3. **跑得怎么样？**（任务、批次、失败、证据）
4. **下一步做什么？**（重跑、裁决、建单、修用例）

当前 IA 要求用户先理解“网页测试”“套件回归”“用例库”“测试资产”的边界，再做第 1 步。重构后，导航直接对应 1–3。

## 4. 目标 IA

```
项目
├─ 项目总览
├─ 测试资产
│  ├─ 概览（数量 + 快速上传 + 最近使用）
│  ├─ 用例集
│  ├─ Excel 文档
│  ├─ 安装包
│  ├─ 测试资料
│  ├─ 参考图（L2）
│  └─ 脚本集
├─ 新建测试
│  ├─ 套件回归
│  └─ 网页测试（Maestro / LLM）
├─ 任务与结果
│  ├─ 全部任务
│  ├─ 进行中
│  ├─ 待处理失败
│  └─ 批次
├─ 设备
├─ 档案
├─ 运维
└─ 使用统计
```

移除的一级入口：

- 用例库 → 并入测试资产 / 用例集。
- 套件回归 → 并入新建测试 / 套件回归。
- 网页测试（安装包） → 并入新建测试 / 网页测试。
- 结果 / 失败分析 → 并入任务与结果。

## 5. 页面设计

### 5.1 测试资产

**定位**：项目内所有测试输入的唯一管理面。用户不需要知道它会被哪条流水线使用。

**顶部**：

- 项目名、资产总数、最近上传时间。
- 主按钮：`上传资产`（下拉：Excel / 安装包 / 测试资料 / 参考图）。
- 次按钮：`导入用例集`（仅 Excel 用例文档）、`生成脚本集`（Excel + 安装包）。

**Tabs**：

| Tab | 内容 | 主要动作 |
|---|---|---|
| 概览 | 各类型数量、最近使用、缺失提示 | 快速上传、跳转到类型 |
| 用例集 | 已导入/生成的套件用例集 | 查看 Excel、导入、下发套件 |
| Excel 文档 | 原始 Excel/CSV 版本 | 预览映射、导入用例集、生成脚本 |
| 安装包 | APK/IPA 版本 | 查看版本、sha、被使用 |
| 测试资料 | materials（含 secret 标记） | 上传、查看版本 |
| 参考图 | L2 reference 图片 | 上传、预览 |
| 脚本集 | 生成的 Maestro scripts | 查看 manifest、下发网页测试 |

**每行统一列**：

`文件名 / 版本 / 大小 / 来源或设计源 / 上传或生成时间 / 被使用 / 操作`

- `被使用`：引用该资产的 Web 任务数、套件用例集数；点击跳转到任务过滤。
- 操作按类型：`下载`、`预览`、`导入用例集`、`生成脚本`、`新建测试`。
- 所有操作始终可见，不依赖列表是否为空。

**空状态**：显示对应上传按钮 + 一句“上传后可在新建测试里选择”，不是只写“暂无”。

**资产 URL**：

- 只允许 `project` + `projectHost`（项目登记 host）。
- 禁止把执行机 host 写进资产 URL。
- 旧 `section=assets&host=<runner>` 自动去掉 runner host。

### 5.2 新建测试

**定位**：所有测试任务的唯一创建入口。先选类型，再选资产/设备。

**Landing**：两张卡片：

1. **套件回归**：已有用例集；设备需预装 App；选择用例集 + 设备 + 基线。
2. **网页测试**：Excel + 安装包；Maestro 或 LLM；可选资料/参考图/脚本集。

**共同区域**：

- 项目（只读）
- 项目主机（只读，来自登记信息）
- 执行机（自动 / 指定）
- 设备（按执行机过滤）
- 用例范围（模块/用例 ID）
- 重试、优先级

**套件回归表单**：

- 用例集（可多选/按功能）
- 平台、基线
- 设备要求（真机/模拟器/型号/系统）
- 不需要安装包字段；明确写“设备需预装 App”。

**网页测试表单**：

- Excel 文档
- 安装包
- 执行方式（Maestro / LLM）
- 测试资料（可选）
- 参考图（可选，L2）
- 脚本集（可选；不指定则自动生成）
- 平台/设备类型
- 每个资产字段旁有常驻上传链接：`上传新 Excel`、`上传新安装包`、`上传测试资料`、`上传参考图`。

**项目登记状态**：

- 项目已登记：正常显示表单。
- 项目仅被发现、未登记：顶部 banner：`项目尚未登记到台账`，提供 `注册项目` 按钮；注册前禁用提交。
- 项目登记在 A host、执行机选 B host：只影响执行，不影响资产；表单明确显示两个 host。

**提交结果**：

- 成功 → 任务详情页。
- 失败 → 表单内 banner，带错误原因 + 下一步（重试/去注册/去上传/去设备页）。

### 5.3 任务与结果

**定位**：套件回归与网页测试的统一任务面。

**列表**：

| 列 | 说明 |
|---|---|
| 任务 | 类型徽标 + id + 创建人 |
| 类型 | 套件回归 / 网页测试（Maestro）/ 网页测试（LLM） |
| 状态 | pending / running / completed / partial / failed / cancelled |
| 项目 | 项目名 |
| 执行机/设备 | 执行机 host + 设备型号/系统 |
| 输入 | 套件：用例集；Web：Excel + 安装包 |
| 创建 | 相对时间 |
| 结果 | PASS/FAIL/UNVERIFIED/等待 |
| 操作 | 详情、取消/停止、重跑 |

**Tabs**：全部 / 进行中 / 待处理失败 / 批次。

**详情**：

- 头部：类型、状态、项目、执行机/设备、创建时间。
- 输入区：
  - 套件：用例集、基线、用例范围。
  - Web：Excel、安装包、资料、参考图、脚本集、执行方式。
- 结果区：逐用例结果、失败域、证据、批次链接。
- 动作：
  - 套件回归：`重新派发套件任务`（现有 rerun，复制 refs/platforms/baseline）。
  - 网页测试：`重新下发网页测试`（`/panel/api/jobs/clone`，复制 jobSpec 并重新校验资产）。
  - 通用：取消、停止、释放。
- 失败分析：失败用例可打开产生它的批次/任务；空状态有 `去新建测试`。

### 5.4 其他页面

- **项目总览**：保留，增加“测试资产 / 新建测试 / 任务”快捷入口。
- **设备**：保留；明确区分项目主机与执行机。
- **档案 / 运维 / 使用统计**：保留；不再承载测试创建。

## 6. Host 与项目身份模型

| 概念 | 含义 | 存储 | URL 参数 | 表单字段 |
|---|---|---|---|---|
| `projectRoot` | 项目目录 | 台账 | `project` | 只读 |
| `projectHostId` | 项目/台账所在 host | 项目登记 | `projectHost` | 只读 |
| `executionHostId` | 本次执行机 | runner 注册 | 不作为资产 URL | `targetHostId` |
| `deviceSerial` | 本次设备 | runner inventory | 不作为资产 URL | `deviceSerial` |

规则：

1. 资产 URL 只带 `project` 和必要的 `projectHost`。
2. 执行机 host 只出现在“新建测试”表单和任务详情。
3. 项目 host 与执行机 host 不同时，显示两个 badge，不合并成一个 `host`。
4. `resolveProjectKey` 不再为工作区目录伪造执行机 host；未登记项目返回明确的 `unregistered` 状态，由 UI 处理。
5. 旧 URL 中的 `host` 如果是执行机 host 且项目为本机项目，自动忽略并去掉。

## 7. 路由与重定向

### 7.1 新路由

| 路由 | 页面 |
|---|---|
| `/panel?project=...&section=assets` | 测试资产（默认概览） |
| `...&section=assets&tab=case-sets` | 用例集 |
| `...&section=assets&tab=excel` | Excel 文档 |
| `...&section=assets&tab=packages` | 安装包 |
| `...&section=assets&tab=materials` | 测试资料 |
| `...&section=assets&tab=reference` | 参考图 |
| `...&section=assets&tab=scripts` | 脚本集 |
| `...&section=create` | 新建测试 landing |
| `...&section=create&type=suite` | 套件回归表单 |
| `...&section=create&type=web` | 网页测试表单 |
| `...&section=tasks` | 任务与结果 |
| `...&section=tasks&task=<id>` | 任务详情 |
| `...&section=tasks&view=review` | 待处理失败 |
| `...&section=devices` | 设备 |

### 7.2 旧路由兼容

| 旧路由 | 新行为 |
|---|---|
| `section=library` | 302 → `section=assets&tab=case-sets` |
| `section=assets&kind=excel` | 302 → `section=assets&tab=excel` |
| `section=assets&kind=package` | 302 → `section=assets&tab=packages` |
| `section=assets&kind=materials` | 302 → `section=assets&tab=materials` |
| `section=assets&kind=reference` | 302 → `section=assets&tab=reference` |
| `section=jobs` | 302 → `section=create&type=web`（列表）或 `section=tasks`（已有任务） |
| `section=jobs&job=<id>` | 302 → `section=tasks&task=<id>` |
| `section=dispatch` | 302 → `section=create&type=suite` |
| `view=review` | 302 → `section=tasks&view=review` |
| `view=stats` | 302 → `section=tasks&view=stats`（或保留 stats 子页） |

重定向必须保留 `project` 和 `projectHost`，丢弃执行机 `host`。

## 8. 数据与接口

不新增表；复用：

- `case_sets` / `suite_runs` / `regression_tasks`（套件）
- `web_projects` / `web_assets` / `web_job_result`（Web）
- `device_leases` / `web_runners`（执行）
- `audit`（动作）

新增读模型：

- `TaskListItem`: 统一任务视图，字段 `taskType`（suite/web）、`executionMode`、`inputSummary`、`resultSummary`。
- `AssetUsage`: `assetId → { webJobs, caseSets, lastUsedAt }`。
- `ProjectRegistrationState`: `registered | discovered-unregistered | ambiguous`。

可选新增接口：

- `GET /panel/api/assets/usage?project=...`（或直接在页面服务端聚合）。
- `POST /panel/api/projects/register`（如果目前没有；用于“注册项目”CTA）。

现有写接口保持不变：

- `/panel/api/import`（Excel → 用例集）
- `/panel/api/projects/assets`（上传资产）
- `/panel/api/projects/scripts/generate`
- `/panel/api/tasks`（套件任务）
- `/panel/api/jobs`（网页任务）
- `/panel/api/jobs/clone`（Web 重新下发）

## 9. 组件与代码落点

| 区域 | 文件 | 改动 |
|---|---|---|
| 导航 | `src/console/shell.ts` | 一级导航改为 项目 / 测试资产 / 新建测试 / 任务与结果 / 设备 / 档案 / 运维 / 使用统计 |
| 资产中心 | `src/console/pages.ts` | 合并 `renderLibraryPage` 与 `renderWebAssetsPage` 为 `renderAssetsPage`；tabs + 概览 + used-by |
| 新建测试 | `src/console/dispatch.ts` + `pages.ts` | 合并套件与 Web 表单为 `renderCreateTestPage`；类型 tabs |
| 任务/结果 | `src/console/pages.ts` + `src/panel/web.ts` | 统一任务列表；类型徽标；类型感知动作 |
| 路由 | `src/panel/web.ts` | 新增 `assets/create/tasks` view；旧路由 302 |
| 动作 | `src/panel/actions.ts` | 复用现有；补项目注册 CTA；Web clone |
| 测试 | `test/console-*.test.js`、`test/panel-*.test.js` | 流程契约测试 |

实现策略：先复用现有渲染函数拼装新页面，再逐步抽公共组件；不要一次性重写所有模板。

## 10. 迁移阶段

### Phase 0：IA 文档与流程契约（本阶段）

- 本文档、词汇表、路由表、redirect 表。
- 先写流程契约测试（可对旧页面断言，作为基线）。
- 不改用户可见行为。

### Phase 1：测试资产中心

- 新增 `section=assets` 统一页：概览 + tabs。
- 合并用例库/资产页；所有上传入口常驻。
- 旧 `section=library`、`section=assets` redirect。
- 资产链接去掉执行机 host。
- 验收：任意资产最多 2 次点击可上传；任意 tab 空状态有 CTA；旧链接不 404。

### Phase 2：新建测试

- 新增 `section=create` landing + 套件/Web 表单。
- 项目登记状态前置；未登记 CTA。
- 旧 `section=dispatch`、`section=jobs` redirect。
- 验收：两种测试都能从 landing 创建；执行机 host 不进入资产 URL；提交错误有下一步。

### Phase 3：任务与结果

- 新增 `section=tasks` 统一列表/详情。
- 类型感知重跑：套件 rerun / Web clone。
- 失败分析链接到任务/批次；空状态去新建测试。
- 旧 `section=jobs&job=`、`view=review` redirect。
- 验收：Web 任务绝不显示套件 rerun；套件任务绝不显示 Web clone；失败可直达批次。

### Phase 4：清理

- 删除旧页面渲染分支（保留 redirect）。
- 更新 README/AGENTS/DESIGN。
- 观察一个版本后移除 redirect。

## 11. 流程契约测试

新增 `test/console-flow-contract.test.js`，逐页断言：

1. **入口常驻**：资产每个 tab 在 0 条和 ≥1 条数据时都渲染上传/创建入口。
2. **空状态下一步**：所有空状态包含至少一个 `<a>` 或 `<button>` 指向下一步。
3. **错误恢复**：提交失败响应包含 `fix`/`next` 链接或可操作按钮。
4. **host 隔离**：资产页 HTML 不包含 `host=<executionHost>`；新建测试表单包含项目 host 与执行机 host 两个独立字段。
5. **项目状态**：未登记项目页显示注册 CTA，提交按钮 disabled。
6. **重跑分派**：Web 任务详情无 `data-task-action="rerun"`；套件任务无 `data-task-action="clone-web"`。
7. **旧路由**：所有 redirect 返回 302/303，且 Location 无执行机 host。
8. **命名一致**：页面不出现第二套同义标签（如同时用“用例库/用例集”指同一对象）。

## 12. 词汇表

| 词 | 唯一含义 | 不再使用 |
|---|---|---|
| 测试资产 | Excel/安装包/资料/参考图/脚本的集合 | “网页测试资产”作为一级概念 |
| 用例集 | 导入/生成的套件用例集合 | “用例库”作为页面名（保留为历史词） |
| 用例文档 | 原始 Excel/CSV | “测试资产 Excel” |
| 安装包 | APK/IPA | “应用包”（统一用安装包） |
| 套件回归 | 用用例集执行的回归 | “套件下发”作为页面名 |
| 网页测试 | Excel+安装包，Maestro/LLM 执行 | “下发测试”作为页面名 |
| 任务 | 一次创建的执行请求 | “job”对用户可见 |
| 批次 | 一次任务产生的运行记录 | “run”对用户可见 |
| 执行机 | runner | “主机”单独使用 |
| 项目主机 | 项目/台账所在 host | “host”单独使用 |

## 13. 风险与开放问题

- **数据模型不合并**：资产中心是视图层合并，底层仍区分 case set 与 web asset；需要 used-by 读模型，避免查询过重。
- **旧链接**：redirect 必须保留 project/projectHost，丢弃执行机 host；需要覆盖测试。
- **项目登记**：如果当前没有项目注册 API，需要补一个最小 `register` 动作；否则未登记项目只能提示去 CLI/MCP 注册。
- **权限**：资产上传需要 maintainer/admin，新建测试需要 dispatcher+；新页面要在顶部说明角色，而不是禁用后无原因。
- **性能**：used-by 聚合可能跨三张表；先做页面级缓存/聚合，避免每个资产 N+1。

## 14. 验收

重构完成后，用以下场景验收：

1. 新用户进入项目：能看到“测试资产 / 新建测试 / 任务与结果”，不需要知道网页测试或套件回归在哪。
2. 上传安装包：从任意页面 ≤2 次点击；上传后能在新建网页测试里选到。
3. 上传 Excel：同一页可选“作为用例集导入”或“作为网页测试 Excel”。
4. 创建套件回归：选用例集 + 设备，不需要安装包。
5. 创建网页测试：选 Excel + 安装包 + 执行方式，可选资料/参考图。
6. 项目未登记：提交前看到注册 CTA，不会提交后才报错。
7. 任务列表：两类任务同列表，类型徽标清晰；Web 任务重跑不会创建套件任务。
8. 失败分析：能从失败用例打开任务/批次，并直接重跑或去新建测试。
9. 旧书签：`section=library`、`section=jobs`、`section=dispatch` 都能落到新页面。
10. 所有流程契约测试通过。

---

**结论**：这次不再按页面补入口，而是把控制台收敛为“资产 → 新建测试 → 任务结果”三段式。底层数据模型保持不变，变化集中在导航、页面组合、host 语义和动作分派。

## 15. 实施状态（2026-11-05）

### 已完成（Phase 1 主体）

- 左侧一级导航新增“测试资产”，移除“用例库”一级入口。
- `section=assets` 成为测试资产 hub：
  - `tab=overview`：资产概览、计数、新建测试入口。
  - `tab=case-sets`：复用原用例库内容，标题为“测试资产 · 用例集”。
  - `tab=excel/packages/materials/reference/scripts`：各自只渲染对应资产表。
  - 上传表单在所有 tab 常驻。
  - 参考图上传链路修复，新增参考图资产表。
- `section=assets&tab=case-sets` 通过 `loadLibraryView(..., embedded)` 复用用例库数据。
- 用例库旧页面仍保留（`section=library`），但它不再出现在一级导航；后续 Phase 4 再做 302。
- 资产 URL 不再伪造执行机 host：`resolveProjectKey` 对工作区项目使用登记 host 或 null。

### 延后

- ~~`被使用` 列（used-by 聚合）~~ → 2026-11-05 已接入：按任务 `jobSpec.assetSnapshot` 聚合 Web 资产引用，按 `refs.caseSetId` 聚合用例集引用；资产表/用例集表显示“被使用”。
- 旧 `section=library`、`section=assets&kind=...` 尚未 302；当前保留旧页面兼容。
- 新建测试 hub（Phase 2）、任务与结果统一（Phase 3）未开始。

## 16. Phase 2 实施记录（2026-11-05）

### 已完成

- 一级导航新增“新建测试”，移除“套件回归”“网页测试（安装包）”两个创建入口。
- `section=create` landing：套件回归 / 网页测试两张卡，带资产就绪提示与跳转。
- `section=create&type=suite`：复用套件回归表单，作为“新建测试 · 套件回归”tab；表单提交仍走现有 `/panel/api/tasks`。
- `section=create&type=web`：复用网页测试表单，作为“新建测试 · 网页测试”tab；表单提交仍走现有 `/panel/api/jobs`。
- 旧 `section=dispatch`、`section=jobs` 仍可访问，页面高亮“新建测试”；后续 Phase 4 再做 302。
- 项目页“新建任务”CTA、用例集“下发该用例集”链接改为 `section=create&type=suite`。
- 空项目“去用例库”改为 `section=assets&tab=case-sets`。
- 网页测试表单的“测试资料/参考图”旁补常驻上传链接。
- 网页任务创建使用中心项目 store；执行机 host 只作为 targetHostId，不再要求项目登记到 runner。

### 延后

- 项目未登记时的显式“注册项目”CTA（当前仍由后端在创建时拒绝）。
- 任务与结果统一（Phase 3）。
- used-by、旧路由 302、资产删除/回收站。

## 17. Phase 3 实施记录（2026-11-05）

### 已完成

- 一级导航新增“任务与结果”，移除“结果”入口；`view=review`/`view=stats` 仍可访问，但高亮“任务与结果”。
- `section=tasks` 统一列表：套件回归 + 网页测试（Maestro/LLM）同表。
  - 列：任务、类型、优先级、状态、项目、执行机/设备、输入、创建、结果、操作。
  - 输入：套件显示用例集数量；网页显示安装包文件名。
  - 结果：网页显示 gate；套件显示运行次数。
- 过滤：`filter=active` 只看进行中；`section=tasks&view=review` 进入现有失败分析。
- 任务详情：
  - 套件任务继续走现有任务详情（`?task=`），高亮“任务与结果”。
  - 网页任务继续走现有网页任务详情（`section=jobs&job=`），高亮“任务与结果”，返回链接改为“返回任务与结果”。
- `section=tasks&task=<id>` 可进入套件任务详情；Web 任务在列表中直接链到网页任务详情。
- 项目页任务列表、批次详情仍可用；批次/任务详情导航当前态归到“任务与结果”。

### 延后

- 旧 `section=dispatch` / `section=jobs` / `section=library` 的 302 尚未做。
- used-by 聚合列。
- 项目未登记时的显式“注册项目”CTA。
- 任务列表服务端分页/搜索（当前 listRegressionTasks 上限 100）。
- 网页任务详情与套件任务详情仍复用两个路由，Phase 4 可合并为单一详情页。
