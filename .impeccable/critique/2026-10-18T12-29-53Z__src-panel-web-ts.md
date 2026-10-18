---
target: src/panel/web.ts（AOS 控制台）
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/Users/louis/Documents/LLM/AOS-ARTEMIS/src/panel/web.ts"
target_fingerprint: "sha256:ba9b89601b63dc54e31a1df507ede55cd439f03c64b50210c22c9ea1c8b590d2"
target_path: /Users/louis/Documents/LLM/AOS-ARTEMIS/src/panel/web.ts
timestamp: 2026-10-18T12-29-53Z
slug: src-panel-web-ts
---
# Critique（第二轮）— AOS-ARTEMIS Web 控制台（`src/panel/web.ts`）· 2026-10-18

Method: dual-agent (A: ses_eb11bc85dffecFT3a2OxAkIJGL · B: ses_eb1129dc3ffejf6JJpByC9ctiM)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | 系统状态可见性 | 3 | 批量写动作曾静默 reload（round-2 已加 flash 回执）；派发摘要曾可为静态快照（已重建） |
| 2 | 贴合现实世界 | 2 | 原始枚举与内部词泄漏（`setup_required`/`exit 2`/`分类原版 v1`/`份血统`） |
| 3 | 用户控制与自由 | 3 | 确认框不可 Esc；离开丢弃未提交表单；无撤销 |
| 4 | 一致性与标准 | 2 | /usage legacy `.badge/.card` 与 CSDC 分叉；"统计"双义（已改"使用统计"）；红黄绿 vs 需要关注两套状态文案 |
| 5 | 错误预防 | 2 | 建单唯一外部副作用防护最弱（round-2 加前置确认；默认值仍只在 placeholder） |
| 6 | 识别而非回忆 | 2 | 批量勾选无汇总条/全选；建单默认值不可见；"在跑什么"不可点 |
| 7 | 灵活与高效 | 3 | `g`/`?`/`/` 已有（`/` 在 usage 失效 → round-2 已补）；表格无排序/无导出视图 |
| 8 | 美学与极简 | 2 | 项目页 11 个等权 section；橙色 note 承担两义；元信息重复 |
| 9 | 错误识别与恢复 | 3 | HTML 404 吐 JSON；zero-platform 报错文案不符（round-2 前置校验） |
| 10 | 帮助与文档 | 3 | `?` 面板不可 Esc；术语无就地定义；无 README 链接 |
| **Total** | | **25/40** | **Acceptable（上沿，向 Good 过渡）** |

## Design Specificity Verdict

LLM：**分层半具体（约 70/30）**——IA 与对象模型确为 AOS 而生（四步下发/份×端×基线/失败域/裁决三路/审计域/功能对齐），但外壳是通用 admin 壳；ops/usage 两页去掉 AOS 字眼后可属任何工具。呈现层的具体性有待把"记录即产品"有形化（常驻记录底座指示器）。
Deterministic：detect 0 主发现 + 1 advisory（`em-dash-overuse`@project 为**误报**：12 处中 11 为占位符/CLI 旗标）；无抑制（--no-config 逐字节一致）；browser overlay 不可用（无浏览器绑定/driver），静态分析为 fallback。
Markup 补充（B）：全部表格 `th scope` 齐备、**caption 全缺**（本轮已补 7 处）；可访问名仅差 project 页 ref 复选框与悬空"目标端"label（本轮已修）；禁用导航 span 不可聚焦（本轮 tabindex+aria-label）；audit/library/ops/archive 的 href 裸 `&`（本轮已转义）；无重复 id、脚本 JSON 转义正确。

## Overall Impression

比首轮（16/40）提升显著：状态诚实、刷新纪律、派发闭环的"回显→复述→留痕"已成形。剩余失分集中在三处：**残留的确认强度与后果信息**（建单默认值、释放后果）、**批量与汇总的操作学**（全选/汇总条/可点对象）、**术语与原始枚举的清理**。

## What's Working

1. 空态/缺数据"为什么+怎么办"文风（批次 8 类原因、runner 心跳引导、"[已清理]"标记）。
2. 派发闭环：预览回显→中文摘要→成功 flash＋审计互链——应被复制到所有写动作（round-2 已普遍化）。
3. 状态诚实与刷新纪律：存储三态、"构建：陈旧"、每页缓存口径、reduced-motion 主动移除 auto-refresh、含表单页零刷新。

## Priority Issues（二评，含 round-2 修复标注）

- **[P0]** 项目页主 CTA 丢 project（"新建回归任务"回总览）→ **已修**（携带 project + 回归测试）。
- **[P1]** 派发确认摘要可为陈旧快照＋端为空未被拦 → **已修**（点击时按表单现值重建摘要、补端校验、选项带 data-count）。
- **[P1]** 建单防护最弱（预览可选、无确认、默认值仅 placeholder）→ **部分修**（补前置 confirm；默认值回显留档）。
- **[P2]** 批量写动作静默成功 + "在跑什么"不可点 → **部分修**（新增 sessionStorage flash 回执体系覆盖裁决/计划/隔离/导入/释放/建单；可点对象留档）。
- **[P2]** 导航与口径分叉（两处"统计"/孤儿页错高亮//usage 孤岛/legacy 组件）→ **部分修**（"使用统计"改名、review/stats/batch 不再错标高亮、`/` 覆盖 usage）；/usage 组件收敛留档。

## Persona Red Flags

Alex：禁用导航项不可聚焦（已修）、批量无全选/汇总条、表格无排序、任务页整页刷新（reduced-motion 可免）。
Sam：确认框不播报（flash 已 role=status；确认框焦点管理留档）、对比度余量薄（badge 4.5–4.8 边缘）、usage 表格无 scope（本轮未动 usage 侧）、长路径不截断。
Jordan：术语墙（份/对账资产/份血统）、首访第二跳曾断（已修）、常驻只读横幅（已加"知道了"可关闭）、原始枚举直出。

## Minor Observations

ops fixture 曾现"会话内存 badge + 文件台账说明"并存（装配产物；渲染层同源断言留档）；档案页缺 since 暴露与批量；overview 备注列与状态灯同格；批次头"分类原版 v1"；缓存提示重复三处。

## Questions to Consider

1. 为什么"记录底座"不作为常驻指示器（最近写入/失败计数）出现在每一页？
2. "份"是否需要就地定义或改名？
3. 结构整齐 vs 最短路径：主 CTA 为何要跳页而非在项目页内联展开？
4. 四类动作共用同一种确认语言——确认是盖章还是帮助决策（后果/是否可撤销从不出现）？
5. /usage 的组件分叉会成为合并障碍吗？

## Run Notes

Target slug `src-panel-web-ts`（第二轮）；ignore 无；A/B 两隔离子代理；CLI detector exit 0（0 主发现＋1 advisory，无抑制）；浏览器不可用（探测三段记录，未安装）；overlay 跳过；live-server 未启；temp 清理：报告体临时文件已删除；fallback：静态 HTML/CSS 分析＋markup 人工审计。
