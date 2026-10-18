---
target: src/panel/web.ts（AOS 控制台）
total_score: 18
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
target_identity: "file:/Users/louis/Documents/LLM/AOS-ARTEMIS/src/panel/web.ts"
target_fingerprint: "sha256:82b88a2451095bf0ed66dc294ceeee4426cb3316d9bdfe6f3ea260a5acf1ab16"
target_path: /Users/louis/Documents/LLM/AOS-ARTEMIS/src/panel/web.ts
timestamp: 2026-10-18T15-04-03Z
slug: src-panel-web-ts
---
# Critique（第三轮）— AOS-ARTEMIS Web 控制台（`src/panel/web.ts`）· 2026-10-18

Method: dual-agent (A: ses_eb08735dcffermC8lIcKd6IBo3 · B: ses_eb081b59affeVvQt3AkmaWu8QL)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 系统状态可见性 | 2 | 项目/任务/统计/批次/搜索页无当前导航项；活动任务整页刷新；派发预览与表单状态不同步 |
| 2 现实世界匹配 | 2 | runner/执行机/运行机混用；原始批次号/ISO/`.artemis` 路径/CLI 直出；"黄 AOS-ARTEMIS" |
| 3 控制与自由 | 2 | 无撤销；释放/建单后无就地核对；自动刷新打断；无项目切换器/最近项目 |
| 4 一致性与标准 | 1 | 创建回归任务两条路径（向导有预览/内嵌无）；archive/audit/search 未传 capabilities（只读死链）；双套 section/card |
| 5 错误预防 | 2 | 预览可过期；确认防双击缺失；Jira 预览可通过状态绕过；内嵌创建无确认 |
| 6 识别而非回忆 | 1 | 无项目上下文导航/切换器/最近项目；隔离要记用例 ID；空态把用户送 CLI |
| 7 灵活与高效 | 2 | `g`/`/`/`?`/搜索/批量在；无排序/列选择/归档分页/项目快切 |
| 8 美学与极简 | 2 | 项目页 10 section 平权；usage 56 零调用铺开；档案平铺 |
| 9 错误识别/恢复 | 2 | 有中文说明与 role=alert/status；缺就地重试/影响面说明 |
| 10 帮助与文档 | 2 | `?` 术语表在；页面无术语链接；帮助混入 `AOS_*` 与 `suite` |
| **Total** | **18/40** | **Poor（结构性 IA/任务流返工级；工艺无短板）** |

## Design Specificity Verdict

**混合型、偏类别可互换（≈5/10）**：为本项目而作的是 pulse 四问、份×端×基线、失败域/裁决/归因/建单/记录底座；但骨架（毛玻璃顶栏+侧栏+卡片表格）可迁移到任何内部后台；"三类记录"在界面上被压平为文件列表与路径字符串。
**Deterministic（B，含真浏览器）**：静态 CLI = 0 主发现 + 1 advisory（em-dash 误报）；**浏览器模式（Edge）31 条：7×script-error（阻断）＋13×placeholder 对比度（合并为 1 缺陷）＋4×gray-on-color（误报 5.77–6.27:1）＋7×nested-cards（token 同色误报）**。**script-error 为本产品回归：`flashScript` 多一个 `}`，`aosFlash` 从未定义、只读横幅无法关闭——本轮已修（f85b8d8）并加"内联脚本必须可解析"回归闸**。
Markup 补充：可访问名 0 匿名控件（但行 checkbox 为常量名、7 页无 fieldset/legend、project 两处 `platform` 同名跨组）；scope 8/8；caption 5/8（project 3 表无）；**移动端 7/7 整页横向溢出（无表格滚动容器，card 被撑宽）**；`:disabled` 样式 0 处（disabled 与可用态外观相同）；archive/audit/search 不传 capabilities（fail-open：只读横幅断档、standalone `/usage` 导航 404）；1 处裸 `&`；4 个提交表单无 method/action。

## Overall Impression

工艺层扎实，但本轮换一位新评审把重心放在信息架构与实机只读一致性上，分数回落（16→25→18）。两条新增事实：① 我们自己的增量层引入了一个阻断回归（flash 脚本语法），说明"多批小改"需要运行时级回归闸——已补；② **本环境其实有 Edge，浏览器模式可用**（此前"无浏览器"的判断错误），静态 CLI 对运行时断裂完全盲。

## What's Working

1. `renderProjectPulse` 四问（健康/在跑什么/待执行/下一步）——最贴合产品原则的模块。
2. 记录与审计的信任设计（顶栏 ledger chip、审计回执、Jira dryRun、确认文案）。
3. 工艺底线（skip-link/`:focus-visible`/aria-current/caption+scope/双编码/reduced-motion/CSDC 单一 token 源）。

## Priority Issues

- **[P1] 项目驾驶舱没有"项目"位置**：首屏被接入自检占据；无项目一级导航/切换器；active=null；`任务` 指向 `#regression`（新建区）而非任务列表。修复：项目导航/切换器（含最近项目）、pulse→结论→在跑→待办→证据的首屏序、环境自查折叠、任务锚点修正。
- **[P1] 派发两条真相**：③ 服务端预览 vs ④ 客户端摘要不同源；不刷新预览可派发旧范围；项目页内嵌创建绕过预览/确认；确认无提交中状态（可双击）。修复：单一入口；表单变更使预览失效并禁用确认；提交中禁用；删除内嵌或改为预填跳转；来源模式条件显示。
- **[P1] 证据链在路径处断掉**：批次 evidence 是 `<code>` 路径；trace 目录不可点；档案限 100 无分页。修复：evidence 统一经 `/panel/artifact`、图片缩略/JSON 预览/目录可展开、批次"打开证据"、档案分页+总数。
- **[P1] 建单/释放的安心感依赖原生 confirm 与可绕过预览**：建单预览不展示完整标题/正文/附件/项目/类型/标签；选择变化不失效；释放无内联确认/撤销/审计直达。修复：逐条预览、变更即失效、内联确认卡、完成给单号+审计链接；释放同式。
- **[P2] 只读一致性 + 移动/无障碍收口**：archive/audit/search fail-open（横幅断档、/usage 404）；`:disabled` 无样式；禁用导航 role=link 可聚焦；行 checkbox 常量名；无 fieldset/legend；10s 整页 refresh；移动端整页横向溢出。修复：统一 capabilities、`:disabled` 样式、真正 disabled、行名含 caseId、fieldset/legend、滚动容器/卡片降级、局部轮询替代整页刷新。

## Persona Red Flags

Alex：总览 Tab 穿 8 个不可激活 role=link；项目切换回总览；无排序/范围选择；活动页整页刷新重置焦点。
Sam：行 checkbox 无名、组无 legend、禁用按钮外观不变、长表无 caption、窄屏溢出、整页刷新噪声。
Jordan：术语（份/裁决/失败域/对账/六族浅扫）无就地入口；空态推 CLI；时间/ID 原文直出；"0/0 未通过"误读；"执行机会/写动作未启用…AOS_PANEL_ACTIONS" 非人话。

## Minor Observations

时间/ID 未做人类表达（本地/相对/复制）；术语三套并存；"0/0 未通过"把空批次画成失败；搜索不搜用例名/运行号且 usage standalone 404；实现细节（`AOS_PANEL_CACHE_MS` 等）出现在用户面。

## Questions to Consider

1. 主视觉为什么是路径/批次号/ISO，而不是一次运行的结论与证据？
2. 去掉黄色与中文标签后，还剩什么是 AOS 独有的？
3. Operate 控制台默认只读、主按钮看起来可点——为何不让"模式"成为启动时的角色？
4. 失败到证据真能两次点击吗？
5. 1 项目到 50 项目、0 到 200 份、3 到 5 万事件，界面还成立吗？

## Run Notes

slug `src-panel-web-ts`（第三轮）；ignore 无；A/B 隔离子代理；静态 CLI exit 0（0 主发现+1 误报 advisory，无抑制）；**浏览器模式可用（Microsoft Edge，PUPPETEER 缓存早于会话，未安装）**；URL overlay 已执行；script-error 已修并加解析回归闸（f85b8d8）；低对比度 13 条合并为 1 个 placeholder 缺陷（暗色 `#757575` on `#2C2C2E`=3.02:1）；误报 12 条（nested-cards 7、gray-on-color 4、em-dash 1）；temp 清理完成。
