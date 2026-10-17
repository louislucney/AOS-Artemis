# run_regression 实施计划（统一服务 ②：回归＋Excel 导入）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 MCP 工具 `run_regression`——回归一条龙：Excel 测试文档导入用例库（幂等、provenance 可追）或按一句话范围选择既有用例 → 执行 → 报告；前置自检与"先问不猜"沿用 ① 的协议。

**Architecture:** 新增 `src/workflow/excel.ts`（xlsx 读取，**复用既有 exceljs 依赖**）与 `src/workflow/excel-import.ts`（列映射→用例合成→按模块归档三件套→登记）；`src/workflow/run-regression.ts` 编排（选择→回显→逐集 `executeSuiteBatch`→聚合）；门禁在 `src/figma/gate.ts` 拆成可组合函数并**按来源分档**；工具定义进 `src/tools/native-tools/workflow.ts`。

**Tech Stack:** TypeScript（ESM/NodeNext/strict）、zod、**exceljs（既有运行时依赖，读写共用）**、node:test。

**Spec:** `docs/superpowers/specs/2026-10-17-unified-project-service-design.md`（本计划实施其 ② 阶段：D5/D5b/D6/D8-adjacent/D12/D14/D15/D16、§5 矩阵、§9 测试口径）。

## Global Constraints

- 每任务收尾：`npm run build`＋该任务测试全绿；最终全量 `npm run build && npm test && npm run lint` 全绿。
- `needs-setup`/`needs-info` 为**非 isError**；用法错误才 isError。复用而非 shell（禁止 shell 到 CLI/脚本）；测试不依赖真实设备/网络/PG。
- ESM+NodeNext+strict、相对导入 `.js`；中文文案；默认无注释（契约 JSDoc 例外）。
- 门禁分档**不得改变生成集行为**（既有 suite 测试全绿）；导入集＝三件套＋真实数据，覆盖闸标注 `n/a (imported)`。
- **D6 实现选型（裁决）**：`exceljs` 已在运行时依赖（`package.json:32`，xlsx 写入器在用）——读取直接复用，**不新增依赖**；合并单元格/结构不可靠→fail-loud（见 T2）。
- 导入集参与"最新份"解析/`suite backfill`/报告/证据（D5 的"进用例库"语义）。

## Review Focus（最可能咬人；测试已归入各任务）

1. **xlsx fail-loud**：合并单元格、坏文件、维度异常→显式失败＋转换指引，**禁止静默错读**（宁可拒绝）。
2. **导入幂等与 provenance**：同内容二次导入 skip 且指向既有份；`source=imported:<文件名>@<sha8>` 与 fingerprint 落库正确；源文件副本**仅一份**。
3. **门禁分档零回归**：生成集三闸逐字不变；导入集仅 artifacts+dataPolicy、输出 `coverage: n/a (imported)`。
4. **选择与回显**：scope 命中回显（功能×条数＋来源"导入自 x/生成自 y"）；0 命中→needs-info；缺省＝库内最新份全量；`excelPath+scope`＝集内过滤。
5. **执行与登记**：复用 `executeSuiteBatch`（quarantine/manifest/`suite_runs` 登记）；设备 0/1/多三态；多集顺序执行与聚合不丢集。

---

### Task 1: 门禁分档（`gate.ts` 拆分 + 导入来源）

**Files:**
- Modify: `src/figma/gate.ts`、`src/suite-command.ts`（`suiteCheck` 检测导入集）
- Test: `test/figma-gate.test.js`（追加）

**Interfaces:**
- Produces:
```ts
export function artifactGateIssue(preflight: PreflightReport | null): string | null;   // xlsx 存在且不早于 json
export function dataPolicyGateIssue(preflight: PreflightReport | null): string | null; // 【真实数据】缺失
export function coverageGateIssue(preflight: PreflightReport | null, options?: { strict?: boolean }): string | null; // 现组合（artifacts+dataPolicy+coverage），行为逐字不变
export function isImportedTestsFile(testsPath: string): boolean;  // 读文件 meta.source 前缀 "imported:"
```
- [ ] **Step 1: 写失败测试**：导入集（`meta.source:"imported:x@sha"`）→ artifacts+dataPolicy 通过时**无** coverage 拦截、`suite check` 输出含 `coverage: n/a (imported)` 且 exit 0；生成集三闸不变（逐字断言原错误文案）。
- [ ] **Step 2: 红**（`npm run test:file -- test/figma-gate.test.js`）。
- [ ] **Step 3: 实现**（拆分纯函数组合；`suiteCheck` 读取 `isImportedTestsFile` 选择闸门集合与输出标注）。
- [ ] **Step 4: 绿**＋`npm run test:file -- test/figma-gate.test.js test/suite-command.test.js` 零回归。
- [ ] **Step 5: 提交**：`git commit -m "feat(gate): tiered gates for imported case sets (coverage n/a)"`

---

### Task 2: xlsx 读取（exceljs，fail-loud）

**Files:**
- Create: `src/workflow/excel.ts`
- Test: `test/workflow-excel.test.js`

**Interfaces:**
- Produces:
```ts
export interface CaseSheet { headers: string[]; rows: string[][]; }
export async function readCaseSheet(filePath: string): Promise<CaseSheet>; // 失败抛 Error（中文、含转换指引）
```
- 行为钉死（D6）：只收 `.xlsx`（其他扩展名→错误）；首工作表；`worksheet.model.merges` 非空→**显式失败**（"含合并单元格，请取消合并后重存"）；行/列数与 `rowCount/columnCount` 健全性断言；cell 值归一（字符串/富文本/数字/布尔/公式结果→字符串；空→`""`）；尾部空行裁剪；损坏 zip/非法 xlsx→显式失败。
- [ ] **Step 1: 写失败测试**（用 exceljs 现场生成 fixtures）：正常表（含数字/布尔/富文本 cell）；合并单元格→拒；`.xls`→拒；坏缓冲→拒；维度断言（尾部空行裁剪）。
- [ ] **Step 2: 红**。**Step 3: 实现**。**Step 4: 绿**＋build。
- [ ] **Step 5: 提交**：`git commit -m "feat(workflow): fail-loud xlsx case-sheet reader (exceljs)"`

---

### Task 3: Excel 导入器（列映射→用例→归档→登记；幂等）

**Files:**
- Create: `src/workflow/excel-import.ts`
- Test: `test/workflow-excel-import.test.js`

**Interfaces:**
- Consumes: `readCaseSheet`（T2）；`saveCaseSetFiles(dir, stem, {json, markdown, xlsx})`、`caseSetStem`（`src/figma/case-sets.ts`）；`recordCaseSet`（`runtime.store`，`RecordCaseSetInput`）；真实数据条款唯一来源 `src/figma/data-policy.ts`（复用标记/条款，勿硬编码）；`crypto` sha256。
- Produces:
```ts
export interface ImportColumns { name?: string; steps?: string; expected?: string; preconditions?: string; module?: string }
export interface ImportedSet { feature: string; featureKey: string; stem: string; jsonPath: string; mdPath: string; xlsxPath: string; caseCount: number; }
export interface ImportResult { ok: true; status: "imported" | "skipped"; sourceId: string; sets: ImportedSet[]; sourceCopy: string; } | { ok: false; error: string }
export async function importTestDocument(runtime: Runtime, args: { excelPath: string; columns?: ImportColumns }, deps?: { readSheet?: typeof readCaseSheet }): Promise<ImportResult>;
```
- 行为钉死（D5/D5b）：列名自动识别（用例名/标题、步骤、预期、前置、模块 等中英别名）＋`columns` 覆盖；必填（用例名+步骤）缺失→`ok:false`；按模块拆集（缺省单功能＝文件 stem）；caseId=`imp-<sha8(内容)>-<行号>`；`taskDesc` 合成（步骤/预期/前置 组装＋**注入真实数据条款**）、`steps`（有预期→assert；否则 explore）、`preconditions`；三件套落 `case-sets/`：JSON＝`{meta:{source:"imported:<文件名>@<sha8>",importedAt}, flows:[cases]}`、md＝用例清单、xlsx＝exceljs 最小工作簿；**源文件副本仅一份**`<UTCstamp>_<源文件名>.source.xlsx`；登记每集（`source`、`fingerprint=归档 JSON 的 sha256`、`designName:null`、features 单条：key=`imp-<slug>-<sha8>`、screens=[模块]、三路径）；**幂等**：内容 sha8 已存在（查库内 source 前缀或文件 meta）→`status:"skipped"` 指向既有份。
- [ ] **Step 1: 写失败测试**（fixtures 现场生成）：单模块导入→三件套+源副本+登记（memory store）；多模块拆集；二次导入→skipped 且不新增文件；列覆盖；缺必填→ok:false；explore/assert 步骤与弱断言口径；指纹/来源字段断言。
- [ ] **Step 2: 红→实现→绿**＋`npm run test:file -- test/figma-case-sets*.test.js` 不回归。
- [ ] **Step 5: 提交**：`git commit -m "feat(workflow): Excel case import → case-sets registry (idempotent, provenance)"`

---

### Task 4: `run_regression` 编排

**Files:**
- Create: `src/workflow/run-regression.ts`；Modify: `src/workflow/design-to-test.ts`（抽出共享设备解析 helper，行为不变）、`src/figma/run-manifest.ts`（`RunManifestSource` 增 `run_regression`）
- Test: `test/workflow-run-regression.test.js`

**Interfaces:**
- Consumes: `executeSuiteBatch(runtime, request: SuiteBatchRequest, io: SuiteBatchIo)`（`src/figma/suite-batch.ts`，含 quarantine/manifest/登记；`request.source` 新枚举值；`registration` 参照 suite-command：`resolveRunRefs(runtime, jsonPath)`）；`runtime.store.listCaseSets(root, limit)`（新→旧，取每 feature 最新份）；`importTestDocument`（T3）；设备解析 helper（自 design-to-test 抽出）；`checkLlm`（`src/workflow/setup.ts`）。
- Produces:
```ts
export interface RunRegressionArgs { excelPath?: string; scope?: string; all?: boolean; device?: string }
export interface RunRegressionDeps { importDocument?: typeof importTestDocument; listSets?: (runtime: Runtime, limit: number) => Promise<CaseSetRecord[]>; executeBatch?: typeof executeSuiteBatch; listDevices?: () => Promise<Array<{ serial: string }>>; setup?: SetupDeps; log?: (line: string) => void }
export async function runRegression(runtime: Runtime, args: RunRegressionArgs, deps?: RunRegressionDeps): Promise<CallToolResult>;
```
- 行为钉死（D15/D16/矩阵）：
  1. 前置：`checkLlm`；设备（唯一在线→用；无→needs-setup target `"device"`；多→needs-info）——设备失败在**任何导入/选择之前**返回（避免"导完才发现没设备"）。`excelPath` 不查设计源凭证。
  2. 选择：
     - `excelPath` → 导入（幂等 skip 复用）→ 目标=该导入集（`scope` 给定时**集内过滤** caseIds）；
     - `scope` → 跨库（最新份）按**归一化关键词**（功能名/模块/用例名；大小写/全半角/空白归一）匹配 → 回显命中（功能×条数＋来源`导入自 x/生成自 y`）；0 命中→needs-info；
     - 缺省/`all` → 库内**最新份全量**（每 feature 取最新）→ 回显同上。
  3. 执行前 `log()` 一行（将跑 N 条/集数/设备），随后逐集 `executeSuiteBatch({options:{testsPath: feature.jsonPath, caseIds?}, source:"run_regression", registration: resolveRunRefs 结果, trigger:"cli"})`，聚合 summary（每集 gate/计数/`manifestPath`）与非零退出语义（任一集 `report.ok=false`→顶层 `failedStep:"run"`；有用例失败已执行→`ok:true`、`run.gate` 反映）。
  4. payload：`{ ok:true, steps:[…], artifacts:{sets:[{feature,jsonPath,manifestPath}]}, run:{…aggregate} }`；needs 形状同 ①。
- [ ] **Step 1: 写失败测试**（全桩）：excelPath 导入+执行；幂等复用（skipped）仍执行既有集；scope 命中（含来源回显）与 0 命中→needs-info；缺省全量回显；`excelPath+scope` 集内过滤（caseIds 透传断言）；多集顺序执行与聚合；无设备→needs-setup（且**未调用** import/listSets）；多设备→needs-info；某集 `report.ok=false`→`failedStep:"run"`。
- [ ] **Step 2: 红→实现→绿**＋build；`test/workflow-design-to-test.test.js` 不回归（设备 helper 抽取）。
- [ ] **Step 5: 提交**：`git commit -m "feat(workflow): run_regression orchestration (import → select/echo → execute → aggregate)"`

---

### Task 5: 工具接线＋usage 信号

**Files:**
- Modify: `src/tools/native-tools/workflow.ts`（数组增 `run_regression`；描述）、`src/usage/capture.ts`（结构化信号：`import.outcome`（imported|skipped|invalid）、`scope.match`（hits））
- Test: `test/native-workflow-tool.test.js`（追加）、`test/usage-capture.test.js`（追加）

**Interfaces:**
- schema ≡ `RunRegressionArgs`（4 字段全可选）；描述必须含（字面断言）：回归/重跑/Excel 信号、needs 协议、命中回显（功能×条数+来源）、执行前日志、缺省＝最新份全量。
- usage：payload 增 `import:{outcome}` 与 `scope:{hits}` 根字段 → `outcomeSignalsOf` 提取（只取根字段/枚举，不读参数值）。
- [ ] **Step 1: 写失败测试**（目录含 `run_regression`；描述字面；zod 非法类型；usage 事件含 `import.outcome`/`scope.match`）。
- [ ] **Step 2: 红→实现→绿**＋`test/server-smoke.test.js` 不回归。
- [ ] **Step 5: 提交**：`git commit -m "feat(tools): expose run_regression; usage signals for import/scope"`

---

### Task 6: 文档＋全量＋收尾小硬化

**Files:**
- Modify: `README.md`（工具表 `run_regression` 行）、`AGENTS.md`（设计流水线段一句话）、`DESIGN.md`（§13.120 实施记录）、`src/workflow/design-to-test.ts` + `src/tools/native-tools/workflow.ts`（两处 ① 延后 Minor：生成 0 条用例→`failedStep:"generate"`；needs 形状措辞写明 `checks[]`）＋对应测试。

- [ ] **Step 1: 两处小硬化**（TDD：0 条用例测试→红→守卫；描述/README/spec 措辞同步 `checks[]`）。
- [ ] **Step 2: 文档三处**（README/AGENTS/DESIGN §13.120：范围、口径（分档/幂等/provenance/回显/覆盖 n/a）、测试数）。
- [ ] **Step 3: 全量回归** `npm run build && npm test && npm run lint`＋残留扫描。
- [ ] **Step 4: 提交**：`git commit -m "docs: run_regression + Excel import (phase ②); carry-over hardening"`

---

## Self-Review 记录（写稿人自查）

- **Spec 覆盖**：§5 矩阵（回归→Excel 导入；共同 LLM；执行类设备）→ T4；D5/D5b/D6 → T2/T3；D12 → T5；D15/D16 → T4；门禁分档 → T1。② 之外的 Jira/档案不在本计划。
- **类型一致性**：`CaseSheet`/`ImportResult`/`RunRegressionArgs` 跨任务同名；`RunManifestSource` 新枚举只增不改。
- **比例**：6 任务，测试以行为矩阵为主；无整段实现转写。
- **留白**：列名别名表、`scope` 关键词归一细节、最新份 limit、聚合报告字段措辞（随实现/复核收敛）；exceljs 读取的合并单元格判据（结构相交即拒）以测试钉死。

## Execution Handoff

计划就绪。建议 **Native（executing-plans）**：6 任务接口逐一钉死、强顺序依赖（T2→T3→T4→T5）、每任务独立测试、最终全量兜底。请审阅计划——确认后选择执行方式（Native／Subagent-driven）。
