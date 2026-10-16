# 回归服务 backlog 清理批次（小幅加固＋测试补强＋文档指针）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清掉 P3b–P3e 各轮评审遗留的低成本小项：两处 `split('|')` 同款加固、artifact 目录索引 `?t=` 携带、两处路由/边界测试补强、三处文档指针——零行为回归、无新接口。

**Architecture:** 全部为既有模块内的小改：`web.ts` 表单 JS 切分与 `artifact-server.ts` 索引链接生成对齐既有已修形状（`submitIssues` 的 indexOf/slice 先例）；测试只增断言；文档挂指针与补句。

**Spec:** 本批次源自：P3b 整支复核范围外观察（裁决表单 `split`）、P3d 整支复核 Minor #2（索引 `?t=`）、P3d 范围外观察（`DESIGN.md:1534` 指针）、P3c 缓办 minors（D8 直测、零 run 守卫）、P3e 缓办 minor（README 补句）。逐条引用见各任务。

## Global Constraints

- 测试口径：pg-mem/内存 store、假目录、不触网；测试跑 `dist/`；`npm run build` 后跑测试；单文件 `npm run test:file -- test/xxx.test.js`。
- 相对导入带 `.js` 后缀；代码英文、用户文案中文；默认不加注释。
- **未设令牌/既有行为零回归**：本批次不改任何默认路径语义。
- 完工标准：`npm run build && npm test && npm run lint` 全绿；DESIGN.md 增 §13.115（清理记录）。

## Review Focus

1. **切分语义**：两处 `split('|')` 改 indexOf/slice 后 payload 形状不变；含 `|` 的 value 断言（caseId/featureKey 完整）。
2. **`?t=` 携带边界**：仅「token 启用且经 `?t=` 认证通过」时链接附参（encode）；Bearer/Basic 认证、未启用 token、`/healthz` 豁免路径零变化。
3. **离线断言**：路由级新断言全走假 store/假 runtime/假 Jira 注入缝，不触网。
4. **D8 直测真实**：磁盘不可达（无目录）但有台账运行的项目 → 最近批次/排序成立（不依赖目录存在）。
5. **文档准确性**：指针与补句与实现一致；DESIGN §13.115 简短如实。

---

### Task 1: 代码小加固（切分＋索引 `?t=` 携带）

**Files:**
- Modify: `src/panel/web.ts`、`src/runner/artifact-server.ts`
- Test: `test/panel-web.test.js`、`test/runner-artifact.test.js`（追加）

**Interfaces:**
- 无新接口；`web.ts` 内联 JS 字符串改为 indexOf/slice 形状（与既有 `issue-item` 处 `web.ts:1160` 一致）：
  - 任务表单 refs（约 `web.ts:747`）：`var idx=el.value.indexOf('|');return {caseSetId:el.value.slice(0,idx),featureKey:el.value.slice(idx+1)};`
  - 裁决表单 items（约 `web.ts:1084`）：同形状 `{runId,…,caseId…}`。
- `artifact-server.ts`：目录索引渲染（`renderIndex` 附近，条目/父链接两处 `href="/artifact/…"`，约 82/90 行）——当**本次请求经 `?t=` 认证**（token 启用 且 `url.searchParams.get("t")` 非空 且鉴权通过）时，为生成的链接追加 `?t=<encodeURIComponent(t)>`；否则不带。实现建议：处理链算出 `querySuffix` 传入索引渲染函数。

- [ ] **Step 1: 写失败测试**
  - `panel-web：裁决表单与任务表单的 JS 用 indexOf/slice 形状（含 '|' 的 value 断言切分完整——字符串级断言，沿用该文件既有 JS 断言风格）`。
  - `runner-artifact：经 ?t= 打开的目录索引，条目与父链接均含 ?t=<token>（encode）；Bearer 认证打开 → 链接不含 ?t=；未启用 token → 与现状逐字一致（回归）`。
- [ ] **Step 2: 跑测试确认失败**（两文件分别）。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过** + build。
- [ ] **Step 5: 提交**：`git commit -m "fix(panel/runner): robust pipe split + carry query token in artifact index links"`

### Task 2: 测试补强（路由级＋D8 直测＋零 run 守卫）

**Files:**
- Test: `test/panel-actions.test.js`、`test/panel-compare.test.js`、`test/db-suite-runs.test.js`（仅追加断言，不改产品码）

**Interfaces:**
- 无产品码改动。
- 用例（逐条）：
  1. **P3b issues 路由级请求错误分支**（`test/panel-actions.test.js`）：`runtimeFor` 返回 `null` → 经路由 `POST /panel/api/issues` 得 400＋「项目运行时不可用」指引；`runtimeFor` 返回假 runtime 且 `jiraConfig()` 未配置 → 400＋含 `JIRA_BASE_URL` 的指引（消息复用 `jiraMissingConfigPayload` 文本）。两例全程离线。
  2. **P3c D8 直测**（`test/panel-compare.test.js`）：新增项目（临时路径但**不建目录**，仅 PG 登记）＋登记 1 条份血统运行（gate fail）→ compare 行 `latestBatch` 非空（gate=fail）且排序按台账（位于 rank 1），另有两个正常项目对照（证明不是「无批次 rank 0」）。
  3. **零 run 守卫**（`test/db-suite-runs.test.js`）：`listSuiteRuns(rootPath, { limit: 0 })` → `[]` 且不抛（命中 `runIds.length === 0` 守卫路径）；再以「已注册但无任何 run 的项目」调 `listSuiteRuns(rootPath)` → `[]`。
- [ ] **Step 1: 写三条（组）测试**（对既有实现应绿——测试补强；若某条揭示真实缺陷，停下报告 BLOCKED 并附最小复现）。
- [ ] **Step 2: 跑测试**：`npm run test:file -- test/panel-actions.test.js`、`test/panel-compare.test.js`、`test/db-suite-runs.test.js`（此刻应绿）。
- [ ] **Step 3: 全量 + lint**。
- [ ] **Step 4: 提交**：`git commit -m "test: backlog hardening (issues route errors, D8 ledger row, zero-run guard)"`

### Task 3: 文档＋全量回归

**Files:**
- Modify: `DESIGN.md`、`README.md`

- [ ] **Step 1: 文档**
  - `DESIGN.md:1534`（§13.109 产物服务）：「**默认监听 `0.0.0.0`、无鉴权**」→ 「**默认监听 `0.0.0.0`、默认无鉴权**（可选令牌见 §13.113）」（最小改动，挂指针）。
  - `README.md:177`（功能对齐段）：`绝对/相对文件路径（**相对该项目根** posix＋小写，跨项目同布局即可对齐）` → 补「（越界/不可相对化则原样小写）」。
  - `DESIGN.md` 新增 **§13.115**（紧随 §13.114，简短）：本批清理记录（切分加固、索引 `?t=` 携带及边界、路由/D8/零 run 测试补强、指针两处；注明「零行为回归」）。
- [ ] **Step 2: 全量回归**：`npm run build && npm test && npm run lint` → 全绿（记录新增测试数与总数）。
- [ ] **Step 3: 提交**：`git commit -m "docs: backlog cleanup (pointer fixes + §13.115 record)"`

---

## 范围外（另立）

- P2.x 加固遗留（claimed 自动超时重置、按端部分领取、upsertRunner 原子性等——需先方案讨论）。
- P3e 组排序测试拆分（可选，非必须）；install 手动块 Codex 具体 key 形状（后续打磨）。
