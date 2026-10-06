# 03 — 聚合与信号

**What to build:** 纯聚合模块，把事件集合变成三份确定性数据：summary（总数、成功率、p50/p95、按工具/族/天分布、零调用工具=工具目录∩已见工具）；signals（错误类分布、unknown 错误按归一化模板聚类——数字/路径/ID/引号内容替换为占位符、warnings 码与 field 分布、降级标记、每工具参数键频次）；events（筛选流水）。零 IO、输出排序稳定。

**Blocked by:** 01.

**Status:** ready-for-agent

- [x] summary：成功率、p50/p95（空/单条/偶数样本边界正确）、按工具/族/天分布、零调用工具
- [x] signals：错误类分布；unknown 错误归一化聚类（不同 ID/数字/路径归并到同一模板）；warnings 码与 field；降级标记；参数键频次
- [x] events：筛选（tool/status/days）与 limit ≤ 200
- [x] fixture 单测，零 IO；输出确定性（稳定排序）

## Comments

### 2026-10-06 — 完成（ticket 03）

**新增文件**
- `src/usage/aggregate.ts`（纯模块，零 IO、不读 env/store、无注释）
- `test/usage-aggregate.test.js`（11 个 fixture 单测）

**导出（tickets 04–06 的契约）**
- `usageSummary(events, catalog?)` → `{ total, ok, error, successRate, p50, p95, byTool[], byFamily[], byDay[], zeroCallTools[] }`
- `usageSignals(events)` → `{ errorClasses[], unclassified[], signalCodes[], degradations[], argKeys[] }`
- `usageEvents(events, query?)` → 最新在前，筛选语义与 store 完全一致（tool 精确、status ok|error、since/until 含边界、at desc + id desc tie-break）
- `normalizeUsageErrorTemplate(summary)`、`USAGE_EVENT_LIST_MAX = 200`、`USAGE_DEGRADATION_CODES`（8 码：vision_degraded / ios-log-unsupported / ios-unsupported / param_ignored / skipped_unmanaged / skipped_occupied / lossless_fallback / simctl_fallback）

**p50/p95 方法（确定性，已锁定）**
- 精确最近秩（nearest-rank），非采样：对全部输入事件（含失败事件）的 `durationMs` 升序排序后取 `rank = ceil(p/100 × n)`（1-based），索引 `min(n, max(1, rank)) - 1`；`n = 0` → `null`。单条 → 值本身；n=4 `[1,3,5,9]` → p50=3、p95=9；n=2 `[4,8]` → p50=4、p95=8。`successRate = ok/total`（空集 0）。

**归一化模板方法（顺序即契约，已锁定）**
1. 折叠空白 + trim；空 → `<no-summary>`
2. 引号内容 `"…"` / `'…'` → `<str>`
3. 路径（至少两段，`a/b` 或 `a\b`）→ `<path>`
4. UUID → `<uuid>`
5. 十六进制 id（≥8 位且含至少一个数字）→ `<hex>`
6. 长 token（`[A-Za-z0-9_+/=-]{24,}`）→ `<token>`
7. 数字（含小数）→ `<num>`
- 聚类对象：`errorClass === "unknown"` **或** `ok === false && errorClass === null`；按模板分组，输出 `{ template, count, tools[] }`，排序 count desc → template 码点升序（`tools` 升序去重）。
- 其余排序约定：`errorClasses` count desc → 类名升序（null 最后，含成功事件的 null 桶，分布总和=总数）；`signalCodes` count desc → code 升序 → field 升序（未知 code 原样保留）；`degradations` 只收 `USAGE_DEGRADATION_CODES` 内 code；`argKeys` 每事件每 key 只计一次，tool 升序、key 按 count desc → key 升序；`byTool`/`byFamily` count desc → 键升序；`byDay` UTC 日期升序（`at.slice(0,10)`）。

**验证**
- `npm run test:file -- test/usage-aggregate.test.js`：11/11 通过
- `npm test`：578/578 通过（基线 567 + 新增 11）
- `npm run lint`：clean

**偏差与观察**
- 无功能偏差。`USAGE_DEGRADATION_CODES` 在 aggregate.ts 内独立列出（未导出 capture.ts 的私有 TEXT_MARKERS），存在两处码表的同步风险，ticket 04 可考虑提为共享常量。
- 既有（ticket 02，未改动）：`test/usage-server.test.js` 的 "policy env caps events per project" 为偶发 flake —— 两次调用同毫秒时 `at` 相同，maxEvents=1 按随机 UUID 做 tie-break，约 1/3 概率断言失败；本次最终 `npm test` 为全绿。

