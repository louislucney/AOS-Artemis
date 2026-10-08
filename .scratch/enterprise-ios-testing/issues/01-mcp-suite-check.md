# 01 — MCP：`suite check` 静态覆盖出口（无设备）

**What to build:** 新增 `suite check [--tests <path>] [--json]` 子命令：纯静态判定 tests.json × flows.json 覆盖率（复用 preflight），不连接设备；完整 → exit 0，未覆盖/截断/缺 flows → exit 2；输出未覆盖屏幕/跳转清单与"测试引用但设计缺失"漂移。供 pre-merge CI。

**Blocked by:** None

**Status:** resolved

- [ ] 复用 `preflightGeneratedTests` 与闸门口径（自环不计边）
- [ ] 自定义 `--tests` 路径同样校验
- [ ] 测试：完整/未覆盖/缺 flows/自定义路径；断言不触发 mobile_run_task
- [ ] README/AGENTS/DESIGN §6.10 同步

## Comments

- 2026-10-08 实施：新增 `suite check` 子命令（静态、不连设备）；复用 `preflightGeneratedTests` 与 `coverageGateIssue`；"测试引用但设计缺失"的路线漂移仅警告；测试 2 例（含 proxy.calls=0 断言）；README/AGENTS/DESIGN §6.10 同步。
