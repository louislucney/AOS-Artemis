# 11 — 真机基线视觉回归

**What to build:** 以上一次通过用例的关键屏幕截图作为基线（last-known-good）；新运行对同一设备、同一分辨率做设备对设备像素差异，报告"新出现 / 持续 / 已修复"三类。基线携带元数据（设备、尺寸、DPI、屏蔽区、caseId）并按设备分桶；分辨率或 DPI 不符时直接不比对（记 unmapped）。与设计 vs 真机 diff 并存，互不替代。

**Blocked by:** 05.

**Status:** ready-for-agent

- [x] 基线带完整元数据并按设备分桶存储
- [x] 可区分新回归与持续差异；分辨率不符返回 unmapped
- [x] 动态内容区域可屏蔽；同输入判定确定性
- [x] 设计 vs 真机 diff 契约不回归

## Comments

- 2026-10-02 实施：新增 `src/diff/baseline.ts`——`saveBaseline`（步骤截图落 `image.png` + `meta.json`：serial/caseId/stepNumber/image/width/height/dpi/ignoreRegions/traceId/capturedAt；目录 `baselines/<serial>/<caseId>/step-<N>-<pre|post>/`，serial 显式→截图设备→`default`）与 `compareBaseline`（复用 `diffScreens`，`maxEdge` 4096；分辨率不符 `unmapped:resolution-mismatch`、双方 DPI 已知且不同 `unmapped:dpi-mismatch`、无基线 `no-baseline`；基线 ignoreRegions 与本次入参取并集）。三类判定经 `last-diff.json`：按类别 + 中心距 ≤24px 配对 → `new`/`persisting`/`fixed` + `summary`。测试 `test/baseline.test.js` 6 例（元数据/分桶、同图零差异、新→持续→修复生命周期、分辨率+DPI unmapped、屏蔽区、无基线+serial 回退）；全量 370 例通过，diff 契约用例不变。见 DESIGN.md §13.27；票据 13 消费。

