# 01 — 事件存储与清理（PG + 内存双实现）

**What to build:** 为「调用事件」提供持久层：扩展项目存储抽象，支持记录事件、按工具/状态/时间范围筛选查询、列出已注册项目（供看板项目切换）、按保留天数与每项目上限清理；PostgreSQL 与内存降级两种实现语义一致。完成后统计数据的写入与查询可独立验证。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] 双实现（PG/内存）可记录、按 tool/status/时间范围查询、列出已注册项目
- [x] 保留天数与每项目上限在写入时清理生效（0=不清理；内存模式上限硬约束）
- [x] 事件字段与隐私边界锁定：不落任何参数值，错误摘要 ≤300 字符
- [x] pg-mem 与内存双跑测试覆盖写入/筛选/清理/边界（空库、超上限）

## Comments

- 2026-10-06 实施：`ProjectStore` 增 `recordUsageEvent/listUsageEvents/listProjects`，共享构建器 `src/db/usage-event.ts`（错误摘要截断 300、limit 归一化、保留截止计算、errorClass 读回白名单）；PG 新表 `usage_events` + 内存实现，保留天数/每项目上限在写入时清理（含未注册项目的 null 桶，防无界累积）。`test/usage-store.test.js` 6 例（双存储 roundtrip/筛选/排序/limit、保留清理、上限保新且项目隔离、截断、空库、孤儿桶清理、listProjects 排序）；全量 549 用例绿、lint 干净。
- code-review 修订（Standards+Spec 双轴）：删除 `types.ts` 新增注释（违反「代码不加注释」硬约定）；共享构建器消除双实现重复；补 `errorSummary ≤300` 强制；limit 非法值双端统一回默认；PG `errorClass` 读回做白名单校验；孤儿事件纳入清理策略并补测试。
