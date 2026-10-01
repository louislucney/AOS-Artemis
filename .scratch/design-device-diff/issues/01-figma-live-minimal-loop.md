# 01 — Figma × 实时截图 最小闭环

**What to build:** 用户用一条命令把 Figma 设计节点与真机当前截图对比：工具完成取图、默认对齐（设计宽度缩放 + 顶部对齐）、像素差异判定，产出确定性的差异报告与标注图（差异框选），并落盘到项目 `.artemis/design/diffs/<screen>-<时间戳>/`（report.json / annotated.png / design.png / device.png）。支持 `dryRun` 只回计划；失败不留半成品。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] 新增图像依赖（纯 JS：PNG 解码、JPEG 解码、像素比对），无原生编译、无网络
- [x] 纯 diff 引擎：输入两张已解码位图 + 选项，输出稳定 DiffReport（对齐记录、区域、汇总、耗时）；同输入两次运行报告逐字节一致
- [x] 对齐默认：设计宽度缩放 + 顶部对齐；大图降采样到默认最长边 1440px（可配）且区域坐标按比例还原
- [x] `ignoreRegions`（bbox 数组）：判定前屏蔽指定区域，报告中记录 `ignoredRegions`
- [x] 抗噪底线：平坦区（无差异内容）在有损 JPEG 下不产生误报区域（阈值/最小面积/聚类默认参数由合成噪声用例覆盖）
- [x] 新原生工具最小 schema：设计源 `figma`（URL + 可选 nodeId），设备源 `live`（可选 serial），`save`/`dryRun`
- [x] 设备截图经既有代理通路获取；设计渲染经 Figma REST 获取，token 缺失时给既有引导提示
- [x] 响应返回摘要 JSON + 标注图（image block）+ 产物路径；原图只落盘不回传
- [x] 测试：引擎合成 golden（已知差异 → 区域/bbox 容差/确定性）；工具层 temp project + StubProxy + fetch stub；失败清理与 dryRun
- [x] 与现有 `compare_design_and_device` 完全并存，契约测试不回归

## Comments

- 2026-10-01 实施完成：纯差异引擎 `src/diff/engine.ts`（pngjs + jpeg-js + pixelmatch，diffMask 提取差异像素；确定性输出；降采样坐标还原；insets/ignoreRegions/聚类/最小面积）。工具 `src/diff/tool.ts` 注册为 `design_device_diff`；Figma 渲染抽取为 `src/figma/render.ts`（`compare_design_and_device` 同步复用）。测试 `test/diff-engine.test.js`（9）+ `test/design-device-diff.test.js`（6），全量 271 例通过；DESIGN/README/AGENTS 已同步。
- code-review 修订：dryRun 预览改用 URL 解析出的 nodeId（与落盘目录一致）；聚类合并改为扫描线（去掉组件数上限，噪声下 clusterGap 不失效）；`device.png` 重编码为真 PNG（上游字节为 JPEG）；补「写盘失败清理」用例；标注渲染拆到 `src/diff/annotate.ts`，测试图像工具收进 `test/helpers.js`。全量 272 例通过。
- 决议：`elapsedMs` 由工具层记录，引擎保持纯函数（同输入逐字节一致）；`category`/`severity` 为占位，票据 03 正式分类；`compare_design_and_device` 复用 `src/figma/render.ts` 属等价抽取（行为不变）。
