# 流程完整性三闸 — 两轴代码审查与整改建议（待决策）

> 日期：2026-10-08
> 被审改动：工作区未提交改动（fixed point `HEAD 54b78a4`），实现 DESIGN §6.10「接入契约：流程完整性保证」
> 方法：Matt Pocock code-review — Standards / Spec 双轴并行子代理审查，本文件聚合两轴结论并落入我的整改意见
> 范围：`src/figma/flows.ts`、`src/figma/test-gen.ts`、`src/server.ts`、`src/suite-command.ts`、`test/figma-testgen.test.js`、`test/suite-command.test.js`、`DESIGN.md`、`README.md`、`AGENTS.md`
> 排除：同一工作区中既有的 iOS env 改动（`src/commands.ts`、`src/runtime.ts`、`test/runtime.test.js`、`.scratch/ios-real-device/spec.md`），与本改动无关
> Status: ready-for-human —— 本文件仅记录意见，代码未再改动，等 review 决策

---

## 1. 被审改动清单

| # | 内容 | 位置 |
|---|------|------|
| 闸 1 | 提取告警：`no-entry` / `unreachable-screens` / `unresolved-destinations`，随 `flows.json` 落盘 | `src/figma/flows.ts` |
| 闸 2 | 生成覆盖：`coverage {complete,uncoveredScreens,uncoveredEdges,truncated,entryFallback}` 写入响应与 `tests.json`；`requireFullCoverage:true` 不完整即报错且三份不落盘 | `src/figma/test-gen.ts`、`src/server.ts` |
| 闸 3 | 执行覆盖：`suite run --fail-on-uncovered` 按预检覆盖判定，命中 exit 2 | `src/suite-command.ts` |
| 文档 | DESIGN §6.10 + §6.1 行、README suite 段、AGENTS 表行 | 多处 |
| 测试 | 覆盖计算/截断/告警/两道闸 | `test/figma-testgen.test.js`、`test/suite-command.test.js` |

---

## 2. 结论摘要（我的意见）

| 编号 | 轴 | 严重度 | 问题 | 建议动作 |
|------|----|--------|------|----------|
| A1 | Standards/Spec 共有 | **P0** | 覆盖计算两处实现不一致：生成侧排除 BACK 自环、preflight 不排除 → 含 BACK 的原型 `coverage.complete=true` 但 `--fail-on-uncovered` 永久假 exit 2（§6.10 口径"BACK/自环不计边"被违反） | 抽共享覆盖 helper，preflight 复用同一口径；补回归测试 |
| A2 | Spec | **P1** | "保证"目前全可选：`requireFullCoverage` 默认 false、`--fail-on-uncovered` 是旗标，流水线默认不启用 → 不对齐"mcp 应该要保证、项目少介入" | 设计流水线入口默认强制；suite run 保持可选（决策见 Q1） |
| A3 | Spec | **P1** | 缺 `flows.json` 时 preflight 静默吞掉，闸 3 把"无法判定"当"无未覆盖"通过；报错文案却声称需要两份文件 | preflight 暴露 `coverageAvailable`；缺失时闸 3 显式 fail-closed 并给出明确原因 |
| A4 | Spec | P2 | `report.ok=false`（套件未执行）且覆盖不完整时，覆盖错误文案掩盖真正的执行失败 | 输出/退出逻辑优先保留执行失败信息，覆盖结论并列展示 |
| A5 | Standards | P2 | `figma_extract_flows` 新增 `warnings` 未同步到 §6.1 表格行（仅 §6.10 提及） | 更新该行 |
| A6 | Standards | P2 | 新增注释无 `PATCH (aos-mcp)` 标记，字面违反 AGENTS.md"代码不加注释"；但同文件既有 JSDoc 风格一致 | 二选一：按字面删除，或保留并在规范里注明例外（决策见 Q3） |
| A7 | Spec | P2 | 自定义 `--tests` 路径一律 exit 2"校验不可用"（即使覆盖正常） | 接受 fail-closed 并校准 README 措辞，或加显式豁免开关（决策见 Q4） |
| A8 | Standards | 测试缺口 | BACK/自环无测试；`truncated` 阻断 `requireFullCoverage` 无测试；`entryFallback` 非阻断无测试 | 随 A1 一并补齐（清单见 §5） |

> 两轴最痛点是同一根因：**覆盖计算存在两份实现**（`test-gen.ts:51-81` 与 `preflight.ts:45-97`），A1 正是该重复的可预期漂移。

---

## 3. 详细发现与我的意见

### 3.1 A1（P0）· 闸 2 与闸 3 的 BACK 自环语义漂移

- 现象：BACK 交互在 `flows.ts:176-178` 生成 `to = fromScreen` 的自环边；生成侧 `test-gen.ts:66` 明确跳过 `from.name === to.name` 的边（与 §6.10 口径一致），但 preflight `preflight.ts:87-94` 不做过滤。用例 screens 连续对里永远不会出现 `X → X`（`test-gen.ts` 只在新屏时 push），于是任何含 BACK 的原型都会被 preflight 报 `uncoveredEdges:["X → X"]`。
- 后果：`suite run --fail-on-uncovered` 在任何含 BACK 的流程上永久 exit 2；而 `figma_generate_tests` 报 `complete=true`——同一份产物两个闸给出相反结论。
- 现有测试为何没抓到：`test/suite-command.test.js` 的新用例写的是 `edges: []`，绕开了自环；`test/figma-testgen.test.js` 只测了生成侧。
- 我的意见：**P0 先修**。最小改法是 preflight 过滤自环；正确改法是抽一个共享函数（如 `computeScreenCoverage(screens, edges, cases)`），生成侧与 preflight 都调用它，从根上消灭双实现。断言加两条：①含 BACK 的原型，生成 `complete=true` 且 `--fail-on-uncovered` exit 0；②孤立屏场景仍 exit 2。

### 3.2 A2（P1）· "保证"默认不可得

- 现象：`requireFullCoverage` 默认 false（`src/server.ts`），`--fail-on-uncovered` 是可选旗标；`scripts/design-pipeline.mjs` 未默认传 `requireFullCoverage:true`；`suite run` 无旗标时对覆盖不完整无感。
- 与需求的距离：你的要求是"项目接入时要保证流程路线完整、项目侧少介入"；当前形态是"想要保证的项目自己记得加旗标"。
- 我的意见：分两层默认——**设计流水线（`design-pipeline.mjs` 与文档推荐的调用序）默认 `requireFullCoverage:true`**，让"生成不出不完整用例"成为默认行为；**`suite run` 保持 opt-in**（避免突然改变既有项目 CI 退出码），但把 coverage 摘要纳入默认输出（预检行已有，补充完整度结论）。是否再进一步"suite 默认强制"见 Q1。

### 3.3 A3（P1）· flows.json 缺失 = 静默通过

- 现象：`preflight.ts:95-97` catch 后保持空清单，`suite-command.ts:237-253` 把 `uncovered === 0` 判为通过；文案却说"需默认 tests.json 与 flows.json"。
- 后果：没有 flows.json 的项目（只留 tests.json）在闸 3 下得到"已保证"的假象。
- 我的意见：**fail-closed 且说真话**：preflight 返回 `coverageAvailable:false`（或 `coverageSource:"tests-only"`），闸 3 遇到时明确报"缺 flows.json，无法判定流程覆盖率，按不通过处理"（仍 exit 2，但原因不再误导）。若你希望"仅测试无设计源也能用"，则改为 degraded 通过并在输出标注（见 Q2）。

### 3.4 A4（P2）· report.ok=false 时的信息覆盖

- 现象：`suite-command.ts:237` 的覆盖分支先于 `:255` 的 `report.ok` 判断；套件根本没执行时，如果恰好覆盖也不完整，用户看到的第一条错误是"流程未完整覆盖"。
- 我的意见：调整优先级——先输出执行失败（`套件未执行: …`），再输出覆盖结论；exit 仍为 2，不影响退出码。

### 3.5 A5（P2）· 文档同步缺口

- `DESIGN.md` §6.1 `figma_extract_flows` 行仍描述为 "screens/edges/entryScreens/unresolved"，新增 `warnings` / `counts.warnings` 只在 §6.10 出现。
- 我的意见：补 §6.1 行描述（一句话），保持"§6.1 是工具面事实源"的可信度。

### 3.6 A6（P2）· 注释与 AGENTS.md 规则

- AGENTS.md 硬性约定："代码不加注释，除非补丁标记（PATCH (aos-mcp)）"；本次新增 `flows.ts:50-52`、`test-gen.ts:38-42,48-50` 的 JSDoc。
- 现状：同文件既有大量 JSDoc（`preflight.ts`、suite-runner 等），子代理判定为"字面违规、实际与本地风格一致"。
- 我的意见：**保留注释**（它们解释的是非显然口径：自环不计边、覆盖语义），同时在 AGENTS.md 的规则上补一句"本仓库既有 JSDoc 风格保留；新增注释仅限解释非显然契约"。若你倾向严格字面执行，我删除即可（Q3）。

### 3.7 A7（P2）· custom `--tests` 的 fail-closed

- 现状：预检只对默认 `tests.json` 生效（`suite-runner.ts:204`），自定义路径下闸 3 一律 exit 2"校验不可用"。
- 我的意见：接受 fail-closed（安全默认），但把 README 的退出码说明从"流程未覆盖"校准为"流程未覆盖或无法校验"；如你希望自定义路径也能校验，可加 `--flows <path>` 指定对应 flows.json（Q4）。

---

## 4. 建议整改顺序（若你采纳）

1. **P0**：抽 `computeScreenCoverage` 单一实现（生成侧 + preflight 共用；preflight 保留弱用例检测）；补 4 条测试（含 BACK / 孤立屏 / truncated 阻断 / entryFallback 非阻断）。
2. **P1**：`design-pipeline.mjs` 默认 `requireFullCoverage:true`；preflight 增加覆盖可用性标记并校准闸 3 文案。
3. **P2**：report.ok 优先级、§6.1 行同步、README 措辞、注释规范裁定。
4. 全绿门槛：`npm run build && npm test && npm run lint`；DESIGN §6.10/§6.1 与 README 同步；行为验收——含 BACK 原型两闸结论一致（generate complete 且 suite exit 0），孤立屏仍被拦（generate 报错、suite exit 2）。

---

## 5. 待决策问题（review 时请逐条给结论）

| # | 问题 | 我的建议 |
|---|------|----------|
| Q1 | "保证"默认开到什么程度：仅设计流水线默认强制，还是 `suite run` 也默认强制？ | 流水线默认开；suite 保持 opt-in + 输出完整度结论 |
| Q2 | 缺 flows.json：fail-closed（推荐）还是 degraded 通过（输出标注）？ | fail-closed，原因写清楚 |
| Q3 | 注释规范：保留 JSDoc 并在 AGENTS.md 注明例外，还是按字面删除？ | 保留 + 注明例外 |
| Q4 | custom `--tests` 的覆盖校验：接受 fail-closed，还是加 `--flows` 指定 flows.json？ | 先接受 fail-closed；有真实需求再加 `--flows`（第二轮修正：改为预检支持自定义 tests 路径，见 §6） |
| Q5 | 修完后是否把 `requireFullCoverage` 在既有示例/文档中默认示例化（影响复制粘贴既有命令的项目）？ | 示例默认开；CLI 参数本身保持可选 |

---

## 6. 决策记录与实施（2026-10-08，第二轮）

对外部反馈的评估结论：Q1/Q2/Q3/Q5 采纳；**Q4 修正**——不加 skip 旗标，改为让预检支持自定义 `--tests` 路径（cases 来自指定文件、flows 仍取 `.artemis/design/flows.json`，缺失仍 fail-closed）；**补充 1（persist coverageContext）不采纳**——与 Q2 fail-closed 冲突（闸 3 不再需要 flows.json 则"缺 flows 即失败"落空）、会把"设计已更新、用例过期"从拦下变成放行、且共享 helper 已根治双实现漂移；**补充 2（`--no-coverage-check`）缓做**——闸 3 仍是 opt-in，跳过=不传 `--fail-on-uncovered`，旗标冗余；待未来闸默认开启时再引入单一逃生旗标。

已实施（2026-10-08）：

- **P0**：新增 `src/figma/coverage.ts`（`computeScreenCoverage` 单一实现：无目的边与自环/BACK 不计；返回 covered/uncovered）；`test-gen.ts#computeFlowCoverage` 与 `preflight.ts` 共用，消除两闸口径漂移。
- **P1**：`suite-runner` 对自定义 `--tests` 也执行预检（`preflightGeneratedTests(configDir, { testsPath })`）；预检新增 `coverage.available`（flows.json 可读性）；闸 3 fail-closed（预检缺失 / 缺 flows.json → exit 2 且原因明确）；执行失败信息先于覆盖结论输出；`scripts/design-pipeline.mjs` 默认 `requireFullCoverage:true`。
- **P2**：AGENTS.md 注释规则注明 JSDoc 例外（非显然契约可保留）；DESIGN §6.1 `figma_extract_flows` 行补 `warnings`；§6.10 更新闸 3 语义、默认姿势（流水线默认强制）与口径（单一实现）；README 推荐示例带 `requireFullCoverage:true`。
- **测试**：BACK 自环两闸结论一致（suite `--fail-on-uncovered` exit 0）；自环不计边（preflight 单测）；`truncated` 阻断 `requireFullCoverage` 且不落盘；`entryFallback` 非阻断；preflight 自定义 `testsPath`；缺 flows.json fail-closed；执行失败优先于覆盖提示。

---

## 附录 A：Standards 轴子代理原始报告（逐字）

> 硬性违规 1 项（A1，functional/spec inconsistency），judgement 2 项（A5、A6）；基线坏味道：Duplicated Code ×2（A1 根因 + suite-command 的 generation 重复 cast）、测试缺口 1 项。

```
## Review: flow-completeness change

### Documented-standard breaches

**1. Gate 2 and gate 3 disagree; gate 3 contradicts DESIGN §6.10's 口径 (hard — functional/spec inconsistency).**
§6.10 states "BACK/自环不产生新屏幕步骤，不计边". `computeFlowCoverage` honours this (`test-gen.ts:66` skips `edge.from.name === edge.to.name`), but `suite run --fail-on-uncovered` gates on `report.preflight.coverage` (`suite-command.ts:242-246`), and preflight (`preflight.ts:88-93`) has no self-loop filter. BACK edges are built as self-loops (`flows.ts:176-178`), so any real flows.json with a BACK edge yields a permanent `未覆盖跳转` → exit 2, even when `figma_generate_tests` reported `coverage.complete=true`. The new suite test avoids this by writing `edges: []` (`suite-command.test.js`), so nothing pins the documented semantics.

**2. `figma_extract_flows` output change not reflected in its §6.1 table row (judgement call).**
The row (DESIGN.md:273) still describes the output as "screens/edges/entryScreens/unresolved"; the new `warnings`/`counts.warnings` response field is only covered by the new §6.10. AGENTS.md 完工标准 requires interface changes synced to DESIGN.md; §6.10 arguably satisfies it, but the row is stale.

**3. New code comments without PATCH markers (letter-of-the-rule breach; judgement call in practice).**
AGENTS.md 硬性约定: "代码不加注释，除非补丁标记（PATCH (aos-mcp)）". Added: `flows.ts:50-52` and `test-gen.ts:38-42,48-50`. No PATCH markers. Existing files already carry JSDoc heavily, so this matches local style but not the written rule.

### Baseline smells (judgement calls)

**Duplicated Code — two coverage implementations.** `computeFlowCoverage` (`test-gen.ts:51-81`) replicates the screen/consecutive-pair coverage shape already in `preflightGeneratedTests` (`preflight.ts:45-97`); the self-loop divergence above is exactly the drift this smell predicts. Extract one shared helper.

**Duplicated Code (minor).** `suite-command.ts:196-203` and `:245-250` both cast `report.preflight.generation` and re-derive `truncated`; one accessor on `PreflightReport` would remove it.

**Test gap (not a smell proper).** No test for BACK/self-edge handling in the gate, nor for `entryFallback` annotation output.

Everything else (Chinese user text, English identifiers, dist-based tests, no real PG/device/network) conforms.
```

## 附录 B：Spec 轴子代理原始报告（逐字）

> 缺失/不完整 3 项（A2、A3、A8 部分）；范围蔓延 1 项（同文件内的相邻未提交 iOS env 文档改动，已排除出本改动）；实现有误 3 项（A1、A4、A7 的一部分）；`requireFullCoverage` 不落盘语义验证正确。

```
## Review report

**(a) Missing / partial vs spec**

- Spec: "mcp 应该要保证" the route is complete with "项目层面不需要介入太多". The guarantee is entirely opt-in: `requireFullCoverage` defaults false (src/server.ts:342-345), `--fail-on-uncovered` is a flag, and nothing in install/doctor/onboarding enables either. A project following the pipeline without flags gets no guarantee.
- Gate 3 silently passes when `flows.json` is missing: `preflightGeneratedTests` catches the read and leaves `uncoveredScreens/uncoveredEdges` empty (src/figma/preflight.ts:95-97), so `uncovered===0` even though the error message claims "需默认 tests.json 与 flows.json" (src/suite-command.ts:239). Contract: "按预检 coverage（未覆盖屏幕/跳转、生成截断）判定" — without flows.json screens/edges cannot be judged at all.
- No test that `truncated` blocks `requireFullCoverage`, nor that `entryFallback` is non-blocking.

**(b) Scope creep**

- DESIGN §13.57/§13.56 rows, README iOS Appium-layering and runtime-install-removal edits, AGENTS Appium/org-id edits are unrelated to §6.10 (documentation for the excluded runtime.ts work).

**(c) Implemented but wrong**

- **Coverage inconsistent between the two gates.** BACK is emitted as a self pair (`to = fromScreen`, src/figma/flows.ts:176-178). Generation excludes it (`if (!edge.to || edge.from.name === edge.to.name) continue;` src/figma/test-gen.ts:66), but preflight does not (`if (typeof from !== "string" || typeof to !== "string") continue;` src/figma/preflight.ts:91). Any prototype with a BACK interaction makes preflight report `uncoveredEdges:["Home → Home"]` while generation reports `coverage.complete=true`; `--fail-on-uncovered` then falsely exits 2. Contract: "BACK/自环不产生新屏幕步骤，不计边".
- Exit-code interaction is otherwise sound (gate precedes `if (!report.ok) return 2`), but if the suite did not run (`report.ok=false`) and coverage is incomplete, the coverage message masks the execution failure. Custom `--tests` always exits 2 "校验不可用" even when coverage is actually fine (preflight only for default path, src/figma/suite-runner.ts:204) — fail-closed is defensible, but README describes exit 2 as "流程未覆盖".
- `requireFullCoverage` verified correct: the throw (src/figma/test-gen.ts:350) precedes all three `writeFileAtomic` calls (368-384), so no artifact is written; matches the contract.
```
