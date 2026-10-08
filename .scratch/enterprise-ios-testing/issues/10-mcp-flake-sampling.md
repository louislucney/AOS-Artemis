# 10 — MCP：flaky 采样实验（LLM 执行确定性量化）

**What to build:** 用现有 `suite run --retry`/重复运行协议量化 MCP（ARTEMIS）执行确定性：3 条代表性用例 ×10 轮，同 fixture、同模型、固定 temperature、每轮复位；输出首跑通过率、逐例翻转矩阵、flaky 率，落盘报告（json/md）。不依赖 07 真实导航接线。

**Blocked by:** 项目侧 fixture 稳定（demo 链即可）

**Status:** resolved

- [ ] 采样编排（复用 suite run/台账，不改语义；可用脚本或 CLI）
- [ ] 控变量记录（模型/temperature/fixture 版本/设备 serial/时间）
- [ ] 指标定义与报告模板（首跑通过率、翻转矩阵、`retry.flaky` 汇总）
- [ ] 解读口径写死：翻转率决定投入强度（L2 条数/是否入门禁），不决定 D1 存废

## Comments

- 2026-10-08 实施：新增 `suite flake --cases <id,…> --runs N`（默认 3，≤50）——重复采样 `runGeneratedTests`（复用 `caseIds` 过滤与台账，不改语义）；纯函数 `src/figma/flake.ts`（逐例通过率/翻转/判定 + 轮次方差）；落盘 `flake-<stamp>.{json,md}`；`--fail-on-flaky` 可门禁；用例 id 校验（不存在即 exit 2）。测试：3 纯 + 2 CLI（708 全绿）。README/DESIGN §6.10/接入指南/AGENTS 同步；analysis §11.2 标注已实现。
