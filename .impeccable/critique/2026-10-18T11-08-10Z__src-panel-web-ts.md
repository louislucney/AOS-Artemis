---
target: src/panel/web.ts（AOS 控制台）
total_score: 16
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
target_identity: "file:/Users/louis/Documents/LLM/AOS-ARTEMIS/src/panel/web.ts"
target_fingerprint: "sha256:c7e253f389195f45fbb3249f050b2b37e3ba83b2d165e34070a0bf6849d53a2d"
target_path: /Users/louis/Documents/LLM/AOS-ARTEMIS/src/panel/web.ts
timestamp: 2026-10-18T11-08-10Z
slug: src-panel-web-ts
---
# Critique — AOS-ARTEMIS Web 控制台（`src/panel/web.ts`）· 2026-10-18

Method: dual-agent (A: ses_eb15f72dcffe491U3XADEZMBKy · B: ses_eb154b144ffekqFFENLQPKvK60)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | 系统状态可见性 | 2 | 写动作可用性不可见（按钮可点但 404）；异步状态无 aria-live；项目驾驶舱不自动刷新 |
| 2 | 与现实世界匹配 | 2 | 产品词汇好；但 `分类原版 v1`/`六族浅扫`/`AOS_AUDIT_*`/全精度 ISO/CLI 教学文案泄漏 |
| 3 | 用户控制与自由 | 2 | 派发无确认无撤销；meta refresh 不可暂停；错误仅 alert；裁决后强刷丢上下文 |
| 4 | 一致性与标准 | 1 | 双样式表并存（CSDC 被 legacy 覆盖）；aria-current 恒指"总览"；导航 3 项指总览、1 项 404；两套组件方言 |
| 5 | 错误预防 | 1 | 派发零确认＋关键词模式用陈旧预览 refs；Excel 死选项；设备手输无校验；双端默认值不可执行 |
| 6 | 识别优于回忆 | 2 | 预览回显很好；但设备串号/路径/ISO 全靠背；latest/none 无解释；导航语义失忆 |
| 7 | 灵活与高效 | 1 | 无键盘快捷键（承诺的 `/`/`g`/`?` 未实现）；无批量下发/批量释放；无"重跑上次"；表格无排序 |
| 8 | 美观与极简 | 2 | 项目页 9 section 平铺；元信息重复；usage 56 行零调用噪声；h1(22px) < 统计值(24px) |
| 9 | 错误识别/诊断/恢复 | 1 | 唯一错误出口 alert("派发失败：not found")；接入信息自相矛盾（LLM 可用=是 vs llm.profiles 为空） |
| 10 | 帮助与文档 | 2 | 口径行密度高；但无帮助页/术语表/快捷键表；字段级解释缺失 |
| **Total** | | **16/40** | **Poor（12–19）——失分集中在"看得见但点不通/点错代价高"，非审美** |

## Design Specificity Verdict

**LLM 评估（中度特定，约六成）**：数据模型与口径是真特定的（份×端×基线、裁决两级门、quarantine 签字、runner 覆盖率、产物六族、compare 同源归一）；但外形与交互母版是类别可互换的通用 admin 壳，唯一产品化可视化是 compare 迷你图。**皮肤未落实**：CSDC 被 legacy `PAGE_CSS` 覆盖（字体/链接色/圆角/顶栏内边距），灯色为 Tailwind 系绕过语义 token，`.card`/`.c-stat`、`.badge`/`.c-badge` 两套方言同屏。

**确定性扫描（B）**：`detect --json .scratch/console-fixtures` → **0 主发现 + 2 advisory，全部集中在 `project.html`**：① `low-contrast` 真实命中——主按钮 hover `#0066CC on #FFE600` = **4.39:1**（我此前按估算误判为达标，实测边缘未达 AA）；② `em-dash-overuse` 为**实质误报**（14 处全为占位符 `—` 与 `<code>` 内 CLI 参数）。逐页矩阵 7/7 扫描成功、无抑制（--no-config 重跑一致）。markup 人工补充：7 页 `for=` 属性为 0（悬空 label 多处）；`library/ops` 查询串裸 `&` 不统一；`project.html` 是唯一双层样式表页（与 A 的判断互证）。

**浏览器叠加**：无自动化浏览器（Chrome/Chromium/Playwright/Puppeteer 均不可用，未尝试安装）；按规程跳过 live-server 与 overlay 注入，静态分析为唯一 fallback 证据通道。

## Overall Impression

内容口径与"记录是产品"的诚实度可信；但对**本演示实例默认（独立进程、动作门关闭）**而言，页面的写入口"看起来能用、点了 404 且一言不发"——一次失败即摧毁信任。最大机会：把"能力状态"变成界面第一公民（可见、可解释、可行动），并让核心闭环（下发→跟踪→证据→裁决）在每一步给出回执与去向。

## What's Working

1. **下发向导 ③ 预览回显**：把"将要发生什么"翻成四个业务事实＋份明细＋runner 候选＋分条警告，且在风险动作之前；`设备` 留空显示"runner 自动"。
2. **任务详情状态叙事**：状态徽章＋领取方（在线/失联）＋覆盖率提示＋释放禁用理由＋触发 CLI；10s 自刷新只给活跃任务页，是有纪律的取舍。
3. **建单闭环＋全局口径诚实**：dryRun 预览与真建单同入口、逐条回执、幂等"已存在"、明写"外部副作用"；空态 8 类原因、compare 口径、缓存 TTL 免责、"只读不删除"——"记录是产品"在文案层可信。

## Priority Issues

**[P0] 导航与项目上下文失效**：`任务/运行机/计划` 导航项落到总览（实测响应体与 `/panel` 同）、`aria-current` 在全部子页恒指"总览"、导航不带 `project`（从项目页去下发即丢项目）、独立进程「统计」404。
**Why**：第一分钟就迷路；对 SR/键盘用户持续误导。
**Fix**：shell 接收项目上下文（项目级链接自动带 `project=`）；实现 `section=tasks|runners|schedules` 真路由或降级为项目页锚点；各页传正确 `active`；按进程能力渲染「统计」；加"导航项必须 200 且 aria-current 唯一"回归测试。
**Suggested**: `$impeccable harden`

**[P0] 动作可用性不可见（能力状态缺席）**：standalone 默认动作门关闭是**设计如此**（文档承诺），但页面无 `data-actions` 标记、无横幅、写 CTA 不禁用——点「确认派发」只得 `alert(not found)`；运维页导出按钮是死链；`接入信息` 同屏自相矛盾（LLM 可用=是 vs llm.profiles 为空）。
**Why**：把"环境开关未开"读成"产品坏了"；Jordan 一次即弃。
**Fix**：服务端注入能力标记（http/standalone、actions on/off、token）；据此渲染页级横幅与禁用态＋可见原因；`alert()` 全替换为 `role="alert"` 内联错误区（原始错误＋可能原因＋下一步）；校验信息收敛单一事实源；成功动作给回执（任务 id＋审计 id 互链）。
**Suggested**: `$impeccable clarify` → `$impeccable harden`

**[P1] 最高风险动作零确认＋可能陈旧作用域**：派发直接 fetch；关键词模式 refs 读上次渲染的 JSON（改词不刷新→静默派发旧范围）；Excel 是死选项；设备手输无校验；双端默认勾选与自家警告冲突。
**Why**：错误范围的事后代价靠审计回溯。
**Fix**：步骤④摘要＋显式确认（启用闲置的 `cConfirmForm`）；refs 由服务端按提交参数重解析（前端只传 mode/ref/keyword/端/设备/基线）；无在线 runner 且未指定设备→禁用＋原因；设备改 runner 设备多选器＋兜底手输；平台默认单选；接通或移除 Excel 入口。
**Suggested**: `$impeccable harden`

**[P1] 双样式表并存——"绑定 CSDC"未被真正执行**：legacy `PAGE_CSS` 在 shell 之后注入并胜出（`body{padding:24px}`、`a{#2563eb}`、`color-scheme:light dark`、h1 22px、8px 圆角），灯色绕过语义 token，两套组件方言同屏；AA 边缘：`.c-button-danger #FF3B30`=3.55:1、主按钮 hover 4.39:1。
**Fix**：删 legacy 或反向并入 tokens（一次迁移）；危险按钮用 ≥4.5:1 红（#B91C1C）；灯色入 token 并配图例；移除 `color-scheme:light dark`（声明 light-only）；死组件（`cConfirmForm`/`cEmpty`）接线或删除。
**Suggested**: `$impeccable distill` → `$impeccable colorize`

**[P2] 闭环的"做"在半途断掉**：用例库零行内操作；档案路径纯文本不可点（服务端其实已支持 since，但表单没渲染）；审计无分页/时间预设（usage 有）；空态不给动作。
**Fix**：份行内动作（下发该份/查 taskDesc/quarantine）；产物行接只读产物服务（打开/下载/跳任务）＋时间预设；审计分页＋预设＋行内互链；空态统一 `cEmpty` 必带一个动作。
**Suggested**: `$impeccable onboard` → `$impeccable polish`

## Persona Red Flags

**Alex**：零键盘链路（`/`/`g`/`?` 未实现、无 skip-link、无搜索）；批量只剩裁决/建单；无"重跑上次"；设备/路径/ISO 全手输；活跃任务页 10s 整页刷新而项目驾驶舱不刷新——双终端（F5＋CLI）。
**Sam**：`.c-button-danger` 3.55:1、usage `.zero-call` opacity .55≈3.3:1、主按钮 hover 4.39:1；表单 `for=` 全缺（多处悬空 label、placeholder-as-label）；异步结果无 `role="status"`；11 列归因表无 caption/行头；`meta refresh` 无视 reduced-motion；`color-scheme` 半暗混搭。
**Jordan**：首屏三连懵（存储三态/宿主 deps/构建）；`健康：需要关注` 仅因可选 Jira 未配→误读为阻塞；空态无路（"暂无 runner 心跳"把人推出 UI）；份/裁决/失败域无术语定义；「下一步」黄卡直达默认必然 404 的向导。

## Minor Observations

1. 模式与权限（stdio/HTTP/独立、token、动作开关）全站不可知；2. 时间全精度 ISO 无相对/时区/复制；3. 英文枚举裸混中文（run/case-set/ok/failed/android）；4. 同数据两种呈现（趋势文本箭头 vs compare 迷你图；usage 有分页 audit 无）；5. 双样式表只在 project/overview 出现，其余 5 页单表——迁移半途证据。

## Questions to Consider

1. 如果"下发"是主干动作，为什么演示实例上它必然失败而页面一言不发？
2. 既然"记录是产品"，为什么没有任何把"你的动作"与"它产生的审计条目"连起来的回执？
3. 三套色彩体系同屏——"绑定 CSDC"除了 tokens.ts 还在哪些地方真正被执行？换系统要改几处？
4. 危险动作仪式差异极大（派发零确认/释放 confirm/建单 dryRun/清理短语）是刻意分级还是实现残迹？
5. Alex 全键盘完成"选份→参数→确认"的路径是什么？若答案是 CLI，控制台对强力用户只剩只读仪表盘？

## Run Notes

Target slug: `src-panel-web-ts`（首次运行，无 trend 基线）；ignore 清单：无；评估独立性：A/B 两个隔离子代理，A 完成后才引入 B 证据；CLI 检测器：exit 0（0 主发现＋2 advisory，无抑制）；浏览器可见性：不可用（Chrome/Chromium/Playwright/Puppeteer 均缺）；overlay 注入：跳过（无浏览器自动化）；live-server：未启动（同理）；temp 清理：报告体临时文件已删除；fallback 信号：静态 HTML/CSS 分析模式 + 源码人工核查。
