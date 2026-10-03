# 10 — 前置数据假设与失败域分类

**What to build:** 用例生成物显式记录前置数据假设（登录态、列表数据等）；运行失败时按确定性规则分类：应用缺陷（崩溃签名）、环境问题（设备离线/adb）、行为或设计差异、数据环境不符、用例缺陷；低置信度不分类并说明原因。

**Blocked by:** 08, 09.

**Status:** ready-for-agent

- [x] 生成物含数据前提标注；失败报告含分类与判定依据
- [x] 分类规则确定性，可用固定样本回归
- [x] 分类不参与差异判定（ADR-0001：判定与解释分离）

## Comments

- 2026-10-02 实施：新增 `src/figma/preconditions.ts`（`deriveCasePreconditions`：应用已安装 → 入口页 → 屏幕名启发式（登录/账号、我的/profile、列表/消息/订单/商品/购物车）+ 入口回退标注，去重保序，确定性）；`GeneratedTest.preconditions` 进入 tests.json、tests.md（`- 前置假设：…`）、tests.xlsx（默认表新增「前置假设」列，模版占位符新增 `{{case.preconditions}}`）与 taskDesc（`前置假设：…；若数据不满足，请停止并报告数据不满足`）；case id 仍只哈希 name/screens/steps，保持稳定。新增 `src/artemis/failure-taxonomy.ts`（`classifyFailure`，纯函数，固定优先级：崩溃签名→应用缺陷 high；复位环境类失败/设备 ADB 文案→环境 high；登录/数据/网络文案→数据环境（命中前置假设 high，否则 medium）；`failed_items`→行为或设计差异 high；轮询超时/提交被拒文案→用例缺陷 medium；其余 unclassified low 附原因）。`SuiteCaseResult.failure`（passed 为 null）：终态失败先 `flushCrashScans()` 再按 trace 过滤崩溃索引；分类不读取也不影响 diff 判定（ADR-0001）。测试 `test/failure-taxonomy.test.js` 7 例 + testgen/suite-runner 增补；全量 370 例通过，lint 绿。
