# 10 — 资产导入 iOS 修正（SVG imageset / Contents.json）

**Milestone:** M2（设计代码化）

**What to build:** iOS 的 `figma_import_assets` 默认 SVG 也落成合法 `.imageset`（含 `Contents.json`），`Contents.json` 只在图片成功导出后写入并统一走 hash/`duplicate_of` 幂等。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] 默认 SVG 写入 `<name>.imageset/`（`Contents.json` + `preserves-vector-representation`）
- [x] `Contents.json` 仅在图片导出成功后写；纳入 hash/`duplicate_of` 幂等路径
- [x] 测试覆盖（import-assets 既有先例）
- [x] DESIGN.md 同步；`npm run build && npm test && npm run lint` 全绿

## Comments

- 2026-10-06 实现完成（未提交）：`npm run build && npm test && npm run lint` 全绿（542 tests）；行为契约见 DESIGN §13.52–13.53 与 spec 决策 2–19。
