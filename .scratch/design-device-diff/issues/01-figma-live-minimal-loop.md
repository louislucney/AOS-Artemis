# 01 — Figma × 实时截图 最小闭环

**What to build:** 用户用一条命令把 Figma 设计节点与真机当前截图对比：工具完成取图、默认对齐（设计宽度缩放 + 顶部对齐）、像素差异判定，产出确定性的差异报告与标注图（差异框选），并落盘到项目 `.artemis/design/diffs/<screen>-<时间戳>/`（report.json / annotated.png / design.png / device.png）。支持 `dryRun` 只回计划；失败不留半成品。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 新增图像依赖（纯 JS：PNG 解码、JPEG 解码、像素比对），无原生编译、无网络
- [ ] 纯 diff 引擎：输入两张已解码位图 + 选项，输出稳定 DiffReport（对齐记录、区域、汇总、耗时）；同输入两次运行报告逐字节一致
- [ ] 对齐默认：设计宽度缩放 + 顶部对齐；大图降采样且区域坐标按比例还原
- [ ] 新原生工具最小 schema：设计源 `figma`（URL + 可选 nodeId），设备源 `live`（可选 serial），`save`/`dryRun`
- [ ] 设备截图经既有代理通路获取；设计渲染经 Figma REST 获取，token 缺失时给既有引导提示
- [ ] 响应返回摘要 JSON + 标注图（image block）+ 产物路径；原图只落盘不回传
- [ ] 测试：引擎合成 golden（已知差异 → 区域/bbox 容差/确定性）；工具层 temp project + StubProxy + fetch stub；失败清理与 dryRun
- [ ] 与现有 `compare_design_and_device` 完全并存，契约测试不回归
