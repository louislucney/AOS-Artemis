# 回归服务 polish 微批次（邻句限定 / 失败释放日志 / 时态标注）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收尾三条 polish 项（全部来自既有复核 findings，逐字执行、无新决策）：① README 定时回归邻句在 opt-in 部分领取下的限定；② `agent.ts` 执行失败释放路径补 `else` 错误日志（与毒丸守卫修复同款）＋定向用例；③ `DESIGN.md` §13.113 补「P3d 后于 §13.115 调整」时态标注。

**Architecture:** 全部为局部小改：`README.md` 一句限定、`src/runner/agent.ts` 一行 `else io.errorLog`＋`test/runner-agent.test.js` 一条定向用例、`DESIGN.md` 一句时态注。零行为变更（除新增日志）。

**Spec:** 来源：P2.x 整支复核 T4-minor（README 邻句）、P2.x 修复波 re-review 范围外观察（失败释放静默路径）、P3d 清理批次 T3-minor（§13.113 时态）。

## Global Constraints

- 测试口径：假 store/假执行器、不触网；测试跑 `dist/`；`npm run build` 后跑测试。
- 相对导入带 `.js`；代码英文、用户文案中文；默认不加注释。
- 零行为回归（除新增一条错误日志）；完工标准：`npm run build && npm test && npm run lint` 全绿。

## Review Focus

1. **邻句限定准确**：README 行在「默认严格子集」与「`AOS_RUNNER_PARTIAL_CLAIM=1` 按交集部分领取」两态下均不产生误导。
2. **失败释放日志**：`released=false` 分支的 `else` 日志真实可达且不影响控制流（不改变释放语义、不新增抛错）；定向用例（stub `releaseRegressionTask→false`）断言 errorLog 且后续循环不中断。
3. **时态标注**：§13.113 句子指向 §13.115 且不改变原语义。

---

### Task 1: 三处 polish

**Files:**
- Modify: `README.md`、`src/runner/agent.ts`、`DESIGN.md`
- Test: `test/runner-agent.test.js`（追加）

**Interfaces:** 无新接口。

- [ ] **Step 1: 写失败用例**（`test/runner-agent.test.js`）：`执行失败释放返回 false → errorLog（不中断循环）`——沿用既有 harness（monkey-patch store：`releaseRegressionTask` 返回 `false`，任务执行失败路径触发）；断言 errorLog 含标识文案、后续任务照常领取（或循环退出干净）。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/runner-agent.test.js`。
- [ ] **Step 3: 实现**
  - `src/runner/agent.ts` 执行失败释放段（约 244-250 行）：`if (released) { …既有日志… } else { io.errorLog(\`[runner] 任务 ${task.id} 释放失败（可能已被并发处理/终态）\`) }`（措辞对齐毒丸守卫 `else`）。
  - `README.md`：定时回归注记「platforms 需与项目内至少一台 runner 设备端匹配，否则任务会逐窗口累积 pending」→ 补限定：「（**默认严格子集**下如此；开启 `AOS_RUNNER_PARTIAL_CLAIM=1` 后，有交集端即可部分领取执行、缺端不补跑，见 DESIGN §13.116）」。
  - `DESIGN.md` §13.113 的 `?t=` 句尾补「（P3d 后于 §13.115 调整索引携带行为）」。
- [ ] **Step 4: 跑测试确认通过** + build + 全量 + lint。
- [ ] **Step 5: 提交**：`git commit -m "polish: failure-release log, README qualifier, §13.113 tense note"`

---

## 范围外

- install 手动块 Codex 具体 key 形状（推测性细节，留后续）；`"0"` 引号风格；真实 PG 迁移冒烟（部署动作）。
