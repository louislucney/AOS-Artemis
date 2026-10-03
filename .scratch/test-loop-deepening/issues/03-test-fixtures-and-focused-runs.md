# 03 — 测试反馈提速：fixture 去重与聚焦运行

**What to build:** 同一测试夹具不再复制（logcat 时间戳、Figma 合成文档、pen fake exec、tmp 目录包装等收敛到共享 helpers/fixtures）；提供单文件/命名模式的聚焦测试入口（先构建再跑，避免 stale dist）；用 Node 内置覆盖率输出未覆盖模块。测试语义不变。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] 重复夹具实现只剩一份，相关用例语义与断言不变
- [x] 可跑单个测试文件与按名称过滤，且不会跑旧构建产物
- [x] 覆盖率可输出（不新增第三方依赖）
- [x] 全量测试仍全绿

## Comments

- 2026-10-02 实施：`helpers.js` 新增 `makeTempDir(prefix)`，收敛 25+ 处裸 `mkdtempSync(os.tmpdir())`（bootstrap/deps-build 的变量前缀包装也改走同一 helper）；`test/fixtures/logcat.mjs` 提供 `logcatTime`/`logcatLine`，crash-parse/crash-collect/crash-tools 的三份 `fmt` 删除；`test/fixtures/figma-flow-doc.mjs` 提供 `syntheticFlowDocument({extraEntry})`，figma-flows/figma-testgen 的本地副本删除（保留 transition 与 Settings 入口变体，断言零改动）。`package.json` 新增 `test:file`（build + `node --test <files>`）、`test:name`（`sh -c` 保证 pattern 在文件参数前；恒带 `test/*.test.js`）、`test:coverage`（`--experimental-test-coverage`，无新依赖；lines 91.65%）。README/AGENTS 开发命令同步；全量 382 例通过、lint 绿。见 DESIGN.md §13.32。

