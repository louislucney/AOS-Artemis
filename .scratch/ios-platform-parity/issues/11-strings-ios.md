# 11 — strings iOS 对等（冲突 / stringsdict / locale / 扫描）

**Milestone:** M2（设计代码化）

**What to build:** iOS 资源导入与 Android 同等的冲突闭环与 locale 目录；`.stringsdict` 不被无条件覆盖；Swift 硬编码文案以保守白名单扫描，报告标注启发式。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] 跨 `.lproj` 冲突检测（语义与 Android `values*` 一致），冲突经 `resolutions.json` 闭环
- [x] `.stringsdict` 解析、合并与冲突；禁止无条件覆盖
- [x] locale 按 BCP-47 映射（iOS `zh-Hans`；Android 维持既有 `values-zh-rCN`，不切 `b+`）；fixtures 覆盖 `zh-Hant-HK`、`pt-BR`/`pt-PT`
- [x] Swift 扫描白名单（Text/Label/navigationTitle 等），排除 NSLocalizedString/URL/数字/纯符号，报告标注启发式
- [x] figma 与 pen 两路径同行为；工具描述口径修正
- [x] 测试覆盖各分支（strings/strings-plural 既有先例）
- [x] DESIGN.md 同步；`npm run build && npm test && npm run lint` 全绿

## Comments

- 2026-10-06 实现完成（未提交）：`npm run build && npm test && npm run lint` 全绿（542 tests）；行为契约见 DESIGN §13.52–13.53 与 spec 决策 2–19。
