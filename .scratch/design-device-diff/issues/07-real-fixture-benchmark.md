# 07 — 真实基准 fixture 与验收指标

**What to build:** 一对真实设备截图与设计渲染的离线基准 fixture（含状态栏/DPI 场景），用于校准对齐与分类；测试输出量化指标（区域召回、类别命中）并断言不低于约定阈值；文档记录基准来源、已知偏差与复现方式。全部离线，不依赖设备/网络。

**Blocked by:** 03（差异分类与严重度 + 阈值参数）

**Status:** ready-for-agent

- [x] 基准 fixture 入库（设计图 + 真机图 + 期望差异清单），来源与参数记录在测试旁
- [x] 指标测试：区域召回与类别命中达到约定阈值，失败时输出可读的对比明细
- [x] 抗噪基准：无差异内容经低质量 JPEG 重编码后不产生误报区域（平坦区误报上限），据此校准默认阈值
- [x] 安全区/状态栏场景：`ignoreRegions` 生效、贴边差异按 `suspected: "system-area"` 降级
- [x] 报告 schema 快照测试，防止无意破坏兼容
- [x] 测试在无设备、无网络、无 Python 环境可跑

## Comments

- 2026-10-01 实施完成：`test/fixtures/diff-bench/`（真实 Pixel 截图 device.jpg + 派生 design.png + ground-truth.json：来源/insets/期望差异）与 `test/diff-benchmark.test.js`（召回+类别命中=1、无额外区域、schema 快照）。全量 303 例通过；DESIGN §6.1/§13.19 已同步。
- 顺带修复：`maxEdge` 改为只按设计图最长边降采样（原实现会让设备二次重采样并把小块差异误滤），`alignment.scale` 语义不变。
- code-review 修订：修正文档中「`alignment.scale` 语义不变」的错误表述（新语义=设备→工作坐标比例，`downsampledTo` 仅设计超限，均在 DESIGN/spec 明示）；补大设备+小块差异的回归测试（锁定 maxEdge 修复，避免修复无保护）；基准新增真实图抗噪（q60 零误报）、`ignoreRegions` 生效、不裁剪 insets 的 `system-area` 降级三项；工具层 report 键序快照；fixture 生成脚本 `scripts/make-diff-benchmark.mjs` 入库并记录来源/insets/重绘参数，`loadFixture` 校验 PNG 尺寸与 ground-truth 一致。
