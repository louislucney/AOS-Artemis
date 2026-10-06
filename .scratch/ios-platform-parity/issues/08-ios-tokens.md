# 08 — iOS token 产物（Colors.xcassets + Swift 枚举）

**Milestone:** M2（设计代码化）

**What to build:** `figma_import_tokens` / `pen_import_tokens` 在 iOS 栈生成 `Colors.xcassets` colorsets 与引用 asset 名的 Swift 枚举，幂等可重复运行；canonical `tokens.json` 不变。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] ios-native 档案产出：`Colors.xcassets` colorset（R/G/B/A 浮点组件）+ Swift 枚举（引用 asset 名）；`tokenFile` 指向 Swift 文件；响应报告 `stackFile`
- [x] 命名确定性规范（colorset 名 / Swift 成员名 / 引用字符串一致且可回读）
- [x] 幂等与覆盖语义与既有栈一致（生成标记、unchanged、skipped_unmanaged、overwrite）
- [x] figma 与 pen 两路径同行为
- [x] 测试覆盖内容/幂等/两路径（纯函数 + tmp 目录既有缝）
- [x] DESIGN.md/README 同步；`npm run build && npm test && npm run lint` 全绿

## Comments

- 2026-10-06 实现完成（未提交）：`npm run build && npm test && npm run lint` 全绿（542 tests）；行为契约见 DESIGN §13.52–13.53 与 spec 决策 2–19。
