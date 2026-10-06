# 03 — iOS 参数语义显式化与应用锁定

**Milestone:** M1（执行与证据链）

**What to build:** 调用方传 iOS 不适用的参数时，响应携带机器可读的 `warnings[]`（双端同构，不再静默忽略）；`app_path` 明确拒绝并指引；`locked_app_package` 真正限制执行器动作范围。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] 启动响应顶层恒有 `warnings[]`（无常量为空数组），条目机器可读（`{code:"param_ignored", field, actual}`），覆盖 `model` / `verification_level` / `explorer_mode` / `expected_output_desc` / `conversation_id`
- [x] AOS 响应包装层双端同构化：Android 响应补空 `warnings: []`（纯增量，不动 artemis 子模块）
- [x] `app_path` 非空时结构化拒绝（error + 改用 `locked_app_package` 指引）；文档说明「前置条件拒绝 vs 咨询性参数警告」的分层理由
- [x] `locked_app_package` 存在时，`launch`/`terminate`/`openUrl` 仅允许目标 bundle id，越界动作被拒绝并如实记入步骤结果；前台逃逸为已知限制（文档 + backlog）
- [x] 测试覆盖 warnings 结构（双端同构）、`app_path` 拒绝、越界动作分支
- [x] DESIGN.md 同步参数契约；`npm run build && npm test && npm run lint` 全绿

## Comments

- 2026-10-06 实现完成（未提交）：`npm run build && npm test && npm run lint` 全绿（542 tests）；行为契约见 DESIGN §13.52–13.53 与 spec 决策 2–19。
