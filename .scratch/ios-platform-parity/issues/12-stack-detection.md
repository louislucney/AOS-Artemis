# 12 — 栈检测放宽与多栈显式警告

**Milestone:** M2（设计代码化）

**What to build:** iOS 工程不在 `ios/` 目录也能被检测；当 tokens/assets/brief/gap/scaffold/screen-map 因主栈限制跳过其他检测栈时，响应给出显式警告（被跳过栈列表）。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] iOS 检测限深搜索 `*.xcodeproj|*.xcworkspace`（排除 node_modules、构建产物等），不再硬要求 `ios/` 目录
- [x] 因主栈限制跳过其他检测栈时，响应携带 warning（被跳过栈列表）
- [x] 测试覆盖检测 fixtures 与 warning（stack 既有先例）
- [x] DESIGN.md 同步；`npm run build && npm test && npm run lint` 全绿

## Comments

- 2026-10-06 实现完成（未提交）：`npm run build && npm test && npm run lint` 全绿（542 tests）；行为契约见 DESIGN §13.52–13.53 与 spec 决策 2–19。
