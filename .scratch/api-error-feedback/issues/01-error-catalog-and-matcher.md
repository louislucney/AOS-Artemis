# 01 — 错误码注册表与匹配（纯模块）

**What to build:** 加载/校验 `.artemis/design/error-codes.json`，并对一段日志文本做确定性匹配，输出观察项与 `handled/unhandled/observed` 判定；纯函数、不碰设备。

**Blocked by:** None.

**Status:** ready-for-agent

- [x] 注册表校验：缺 match/非法正则/非对象 → `errors[]` 且忽略该条；合法条目进 `rules`
- [x] 匹配：计数、首个样例行、`handledPattern` 判定；结果排序稳定
- [x] 单测覆盖校验/匹配/handled 三态；不依赖设备/网络

## Comments

- 2026-10-02 实施：`src/artemis/api-errors.ts` 新增 `loadApiErrorCatalog`（校验 match/handledPattern 正则与字段类型，非法条目进 `errors[]` 并忽略、文件缺失返回空表）、`matchApiErrors`（逐行匹配计数 + 首样例/时间 + handled 三态，按 code 排序）、`readApiErrorsArtifact`；测试 `test/api-errors.test.js` 3 例。
