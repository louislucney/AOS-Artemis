# 接入与下发加固 实施计划（⑥：CLI help 短路＋下发窗口假阴性修复＋接入文档三补）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复「接入/下发可用性评审」确认的 2 个 Blocker——**B1** CLI `--help` 会实际执行命令（含 `suite run` 真跑设备、`serve`/`runner` 起常驻、`init` 写文件）；**B2** "50 份窗口"被用于正确性路径导致**假报不可用**（已实测三复现）——并补齐 3 个高价值文档项（runner 常驻化、`init` 引用、Excel 最小样例）。

**Architecture:** `src/cli.ts` 顶部统一 `-h/--help` 短路（按命令打印对应用法，零副作用）＋`runSuiteCommand`/`runJiraCommand` 库级守卫；B2 将**正确性路径**的 `listCaseSets(…, 50)` 改为全量读取（展示路径保持 50），站点：`suite task create/run --task/schedule add/task show`、`resolveRunRefs`、`panel/actions` 建单校验、`test-gen` 身份继承、`run-report` 名称解析。

**Tech Stack:** TypeScript（ESM/NodeNext/strict）、node:test（含 `spawnSync` CLI 级测试，复用 `test/bootstrap.test.js` 范式）。

**Spec/依据:** 本地可用性评审报告（B1/B2/H1–H3，含代码点位与 CLI 实测）；B2 复现实验（三红：`未知 feature key：f-old（可用：…）`／`引用份均不可用（先重新生成/登记用例集）`／`resolveRunRefs → null`）。

## Global Constraints

- 每任务收尾：`npm run build`＋该任务测试全绿；最终全量 `npm run build && npm test && npm run lint` 全绿。
- **help 短路零副作用**：任何 `<cmd> --help` 只打印用法、exit 0；不得启动 serve/runner、不得执行 suite run、不得写文件（init）、不得构建 deps。
- **B2 修复语义**：窗口外既有数据必须视为**可用**；窗口内路径行为逐字不变（含既有报错文案与列表排序）；**展示路径**（`panel/overview` 的 50）不动。
- **不改 store 接口**（用既有 `listCaseSets` 全量语义；PG 下推 `DISTINCT ON` 留白记录，另轮）。
- ESM+NodeNext+strict、相对导入 `.js`；中文文案；默认无注释（契约 JSDoc 例外）；测试不依赖真实设备/网络/PG。
- 文档与实现一字不差（示例命令可复制执行）。

## Review Focus（最可能咬人；测试已归入各任务）

1. **help 零副作用（spawn 实测）**：`serve/suite/doctor/init/deps/panel/usage/jira --help` 均 exit 0＋用法输出；`init --help` 的临时 cwd 目录保持为空；`suite run --help` 无"套件:"执行行；`suite runner --help` 无"[runner] 启动"（T1）。
2. **窗口修复有效且零回归**：>50 份复现全部转绿；窗口内既有断言（`suite --help` 用法、bare `suite` 仍 2、task create 报错格式）不变（T2）。
3. **身份继承**：老功能（最新份在窗口外）重生成仍沿用原 `featureKey`（不裂份）（T2）。
4. **面板建单一致性**：窗口外引用在 `panel/actions` 可建（与 CLI 同口径）（T2）。
5. **文档可执行**：systemd/launchd 示例字段与 README 参数一致；Excel 样例列名与导入别名逐字对应（T3）。

---

### Task 1: CLI `--help` 短路（B1）

**Files:**
- Modify: `src/cli.ts`（顶部统一 guard）、`src/suite-command.ts`（`runSuiteCommand` 库级守卫）、`src/jira-command.ts`（group 后守卫）
- Test: `test/cli-help.test.js`（新；spawn 范式）、`test/suite-command.test.js`（追加库级）、`test/jira-cli.test.js`（追加）

**Interfaces:**
- `src/cli.ts`：在 `switch (command)` 前：`const wantsHelp = rest.includes("-h") || rest.includes("--help");`——命中且 `command !== "jira"` 时按命令打印**对应**用法（`suite`→`printSuiteUsage`、其余→全局 `printHelp`）并 exit 0，**不进入任何 case**；`jira` 不在此拦截——由 `runJiraCommand` 内部守卫打印 jira 用法（同时覆盖 `jira --help` 与 `jira issue --help`）。
- `runSuiteCommand`：`parseFlags` 后若 `argv` 含 `-h/--help` → `printSuiteUsage(log)`、return 0（先于子命令分发；保持 bare `suite`＝2、`suite --help`＝0 现状）。
- `runJiraCommand`：group 校验后若 `argv` 含 `-h/--help` → `printJiraUsage(log)`、return 0（消除「未知 jira issue 子命令 ""」噪声）。

- [ ] **Step 1: 写失败测试**：
  - `test/cli-help.test.js`（spawn `node dist/cli.js <argv>`，cwd＝临时目录）：对 `serve --help|--http --help`、`suite --help`、`suite run --help`、`suite runner --help`、`doctor --help`、`init --help`、`deps --help`、`panel --help`、`usage --help`、`jira issue --help`：exit 0 且 stdout 含用法行；断言零副作用——`init --help` 临时目录为空；`suite run --help` 输出不含"套件:"；`suite runner --help` 不含"[runner] 启动"。
  - `test/suite-command.test.js`：`runCli(["run","--help"])` → code 0、logs 含 "suite — 测试闭环"，且 proxy 无调用（执行未发生）。
  - `test/jira-cli.test.js`：`runJiraCommand(["issue","--help"])` → 0、无"未知"。
- [ ] **Step 2: 红**（`npm run test:file -- test/cli-help.test.js test/suite-command.test.js test/jira-cli.test.js`）。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 绿**＋`npm run test:file -- test/cli-help.test.js test/suite-command.test.js test/jira-cli.test.js test/bootstrap.test.js`。
- [ ] **Step 5: 提交**：`git commit -m "fix(cli): --help short-circuits everywhere (no accidental serve/suite/init)"`

---

### Task 2: B2——正确性路径去 50 窗口（含复现转红为绿）

**Files:**
- Modify: `src/suite-command.ts`（285 `run --task`、1561 `task create`、1723 `schedule add`、2009 `task show`：`listCaseSets(rootPath)` 全量）、`src/tasks/run-registry.ts`（103 `resolveRunRefs` 全量）、`src/panel/actions.ts`（88 建单校验全量）、`src/figma/test-gen.ts`（909 身份继承全量）、`src/figma/run-report.ts`（321 名称解析全量）
- Test: `test/suite-command.test.js`（四例）、`test/run-registry.test.js`（一例）、`test/figma-case-sets-gen.test.js`（一例）、`test/panel-actions.test.js`（一例）；`test/helpers.js`（新增共享 seed 助手）
- **证据锚**：三测试复现已在评审中实测失败（>50 份：task create 报未知；run --task 报引用均不可用；resolveRunRefs→null）。

**Interfaces:**
- `test/helpers.js` 新增：`export async function seedCaseSets(store, rootPath, designDirAbs, options: { count: number; targetKey?: string; targetName?: string }): Promise<{ sets: CaseSetRecord[]; targetJsonPath?: string }>`——第 1 份含 `targetKey`（缺省 `f-old`），其余 `count-1` 份为 filler；`createdAt` 单调递增保证第 1 份最旧；各份写独立 `case-sets/s<i>.json`（`{flows:[1 条]}`）。
- 行为钉死：修复后 `task create --ref <窗口外 key>`＝0 并按原格式列出 resolved 行；`run --task` 对窗口外份正常执行（不再出现"引用份均不可用"）；`schedule add` 同 create；`task show` 显示 `featureName` 且无"（份已清理）"；`resolveRunRefs` 返回 `{caseSetId, featureKey, featureName}`；`panel/actions` 创建成功；`figmaGenerateTests` 对窗口外老功能沿用原 key。
- [ ] **Step 1: 写失败测试**（四套件按上；task create/run/schedule/show 用 `seedCaseSets`；gen 用既有 harness＋seed 51 份（屏幕重叠：`screens:["首页"]`）后同屏 flows 生成，断言新份 `features[0].key === "f-old"`；panel 用例 refs 指向 `sets[0]`）。
- [ ] **Step 2: 红**（`npm run test:file -- test/suite-command.test.js test/run-registry.test.js test/figma-case-sets-gen.test.js test/panel-actions.test.js`——预期 ≥6 例红）。
- [ ] **Step 3: 实现**（八处改全量；不动 `panel/overview` 两处 50 与 `compare` 全量现状；JSDoc 注明"正确性路径按全量/展示路径分页"口径一句）。
- [ ] **Step 4: 绿**＋同命令；并跑 `npm run test:file -- test/suite-run-manifest.test.js test/panel-overview.test.js test/suite-backfill.test.js` 零回归。
- [ ] **Step 5: 提交**：`git commit -m "fix(dispatch): correctness paths read full case-set history (no 50-window false negatives)"`

---

### Task 3: 接入文档三补（H1/H2/H3）

**Files:**
- Modify: `README.md`（runner 常驻化小节；`init` 一句；Excel 最小样例表）、`docs/接入指南.md`（§3.2 前 `init` 提示；§3.6 后 runner 常驻化小节；Excel 样例互链）

**内容钉死：**
- **runner 常驻化**：给出 systemd（`WorkingDirectory=<服务仓库>`、`ExecStart=<node> dist/cli.js suite runner --name <n>`、`Restart=always`、`EnvironmentFile=<项目 .env>` 或显式 `MOBILE_TESTING_DATABASE_URL`）与 launchd（plist 最小键：Label/ProgramArguments/WorkingDirectory/KeepAlive/StandardOutPath）两示例；注意事项：单项目勿双开同名 runner、产物端口/令牌（`AOS_RUNNER_ARTIFACT_TOKEN`）、日志去向。
- **init**：`node <service>/dist/cli.js init`（在目标项目目录执行；写 `aos.config.jsonc`＋`.env.example`＋三步 next-action；`--force` 覆盖）。
- **Excel 最小样例**：README 导入段内 markdown 表（表头 `用例名 | 步骤 | 预期 | 前置 | 模块`＋2 行），注明"另存为 .xlsx、勿合并单元格"。
- [ ] **Step 1: 写文档**（三处；命令与 README 既有参数对照一致）。
- [ ] **Step 2: 校验**：`grep -n "suite runner\|init\|用例名" README.md docs/接入指南.md` 逐处核对；systemd 示例可跑性以字段级对照（不实跑）。
- [ ] **Step 3: 提交**：`git commit -m "docs: runner service-ization, init scaffold, Excel sample"`

---

### Task 4: 记录＋全量

**Files:**
- Modify: `DESIGN.md`（§13.124：B1/B2 修复口径、全量读取的范围与 PG 下推留白、测试数）

- [ ] **Step 1: 全量** `npm run build && npm test && npm run lint`（记录实数）。
- [ ] **Step 2: §13.124＋提交**：`git commit -m "docs: onboarding/dispatch hardening (⑥) record"`。

---

## Self-Review 记录（写稿人自查）

- **覆盖**：评审 B1→T1；B2 八站点→T2（含 schedule add 与 runner 触发路径口径不一致的修复）；H1/H2/H3→T3；记录→T4。**未做（留档）**：主 help 的 suite 行扩展、`suite task list` 的 runner 覆盖提示、`install` 的 dist 存在校验、`listCaseSets` PG `DISTINCT ON` 下推、task create 可用列表 cap、usage/panel 命令专属帮助文案（统一全局）。
- **类型一致性**：`seedCaseSets` 返回 `{sets, targetJsonPath}`；T2 各红测共用；不新增 store 方法。
- **比例**：4 任务；T2 为红复现转绿（评审已实测失败）；无整段实现转写。
- **留白**：文档示例的具体服务路径占位（随实现用 `<service>` 写法）；gen 继承测试的 harness 细节（复用 `figma-case-sets-gen.test.js` 现有 stub 形态）。

## Execution Handoff

计划就绪。建议 **Native（executing-plans）**：T1/T2 独立可并行推进（顺序执行）、T3 文档、T4 收口；终审单独派 fresh reviewer。请审阅计划——确认后选择执行方式（Native／Subagent-driven）。
