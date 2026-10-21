# Web 控制台视觉体系（CSDC）

> 来源：CSDC 开发者设计系统 `https://html.temvo.com/CSDC/`（用户指定为绑定风格；参考文件存 `.scratch/web-console/references/csdc/`）。
> 实现：`src/console/tokens.ts`（唯一 CSS 变量源）＋`src/console/shell.ts`（顶栏/侧栏/主区外壳）＋`src/console/logo.ts`（CSDC 官方徽标内联）。**主题**：CSDC 7.4 为纯浅色体系，控制台**强制亮色**（`color-scheme:light`），不跟随系统暗色；暗色映射已移除。**移动端保底**：≤960 导航横向滚动＋表格 `.c-table-wrap` 横向滚动（不做 <768 卡片化——已知取舍）。
> 与仓库根 `DESIGN.md`（架构事实源）互不覆盖；本文件只描述控制台表面。

## Token 表（照抄 CSDC）

| Token | 值 | 用途 |
|---|---|---|
| `--color-accent` | `#FFE600` | 主行动（active 导航、主按钮、焦点强调） |
| `--color-accent-hover/-surface/-subtle` | `#FFF9CC` / `#FFF9CC` / `#FFFDE6` | 悬停/面/浅背景 |
| `--color-text-primary` | `#1D1D1F` | 正文与标题 |
| `--color-text-secondary` | `#6E6E73` | **正文级次要文字**（对白底 ≈5.1:1，达标 AA） |
| `--color-text-tertiary` | `#86868B` | **仅装饰/大字号**（对白底 ≈3.6:1，不得用于正文） |
| `--color-surface-light/-white/-subtle` | `#F5F5F7` / `#FFFFFF` / `#EFEFF2` | 页面底/卡片/次面 |
| `--color-border` | `#D2D2D7` | 边框/分隔 |
| `--color-link` | `#0066CC` | 链接 |
| `--color-success/-error/-warning` | `#34C759` / `#FF3B30` / `#FF9500`（含 `-bg` 浅底） | 状态语义（必须配文字，不仅颜色） |
| 圆角 | `6/10/14/18/980px` | xs/sm/md/card/pill |
| 阴影 | `0 4px 20px rgba(0,0,0,.04)`；`0 10px 30px rgba(0,0,0,.07)` | 卡片/悬停 |
| 顶栏 | `backdrop-filter: blur(20px)`＋`rgba(255,255,255,.72)` | 毛玻璃 |

字体栈：`-apple-system, "SF Pro Text", "PingFang SC", …`；等宽 `SF Mono/Menlo`。字号：title-3 18px / body 15px / callout 13px / caption 12px。

## 结构母版

- 顶栏（sticky 毛玻璃，`padding:12px 36px`）：CSDC 官方徽标＋「mobile-testing 控制台」＋右侧上下文（项目/生成时间/存储徽章即 `meta`）。
- 侧栏 220px（CSDC 标准，`aria-label="控制台导航"`）：分组标题「工作区」；`aria-current="page"` 标记当前项（黄底）；≤960px 转横向滚动条。
- 主区**全宽**（不再 1320 居中），白底 `padding:20px 36px 80px`；卡片化（`cCard/cBadge/cBanner/cTable/cStat/cEmpty/cConfirmForm`）。
- 区块标题/卡片标题使用 CSDC 黄色 Section Header（`#FFF9CC` 底＋`#FFE600` 边）；按钮/徽章为胶囊形；表格浅灰表头、卡片外框。
- 页脚全宽浅灰底：`mobile-testing · 本地服务`。

## 状态口径

- 存储三态标签（与 `src/db/labels.ts` 同源）：PostgreSQL／文件台账（.artemis/ledger）／会话内存（仅本次进程，数据不持久）。
- 危险动作确认分级：常规＝`data-confirm`；外部副作用＝dryRun 预览＋确认；清理类＝输入确认短语。全站站内确认（`aosInlineConfirm`），原生 `confirm()` 已退场。
- 刷新纪律：**无 `meta refresh`**——自动刷新＝轮询脚本（`#console-main` 就地替换），带「自动刷新中（每 N 秒）」标注＋暂停/继续；`document.hidden`、焦点在主内容、`prefers-reduced-motion` 三守护；替换后经 `window.aosOnRefresh` 重绑页面动作（含文档级委托的暂停按钮）。

## 组件类名（计划）

`c-topbar/c-brand/c-topbar-meta/c-layout/c-aside/c-nav-item/c-main/c-footer`；`c-card(-accent)/c-badge-*/c-banner-*/c-table/c-stat/c-empty/c-button(-primary/-danger)/c-confirm-inline`。表格单一出口：页面表格一律经 `cTable`（`renderTable` 为其委托）。

导航口径：usage 独立进程显示 `USAGE_STANDALONE_NAV`（`src/console/shell.ts`：仅「统计」自身，不显示跨进程链接）；HTTP 模式下 `/panel` 与 `/usage` 各自导航（/usage 沿用该子集，后续如需并入主导航再议）。

AA 偏差记录：`--color-link-hover` 采用 `#0066CC`（CSDC 原值 `#0077ED` 对白底 4.3:1，低于 AA）；遗留 PAGE_CSS 的 `#888` 已改 `#6E6E73`；`impeccable detect` 对 `scripts/console-fixtures.mjs` 产物为 **0 anti-patterns**。

**critique→polish 轮（2026-10-18）**：样式收敛为**单一源**——`tokens.ts`（CSDC 变量＋组件）＋`compat.ts`（遗留标记兼容层，颜色/圆角对齐 token；不再有第二份 legacy `<style>` 与 `color-scheme` 双色系）；危险按钮 `#B91C1C`（≥4.5:1）；主按钮 hover 保持深色文字（修 4.39:1 边缘）；`.c-skip-link` 跳链；页级能力横幅与禁用态口径见 `src/console/shell.ts` 的 `ConsoleCapabilities`。

## 评审结项（2026-10-19）

**方法**：8 轮 dual-agent critique（盲评设计＋检测证据；Edge 真浏览器 file:// 与在线 URL 双模；静态 CLI `detect` 与浏览器 `detect` 的差异已知并记录）。快照：`.impeccable/critique/`（git-ignored）。
**趋势**：16 → 25 → 18 → 23 → 33 → 28 → 27 → **31/40**。波动来自评审视角轮换（IA → 失败路径 → 信任链 → 一致性），非质量倒退；每轮新发现的粒度递减（从缺整段状态机到 `&amp;` 级）。
**停止准则（今后沿用）**：连续一轮 critique **无 P0/P1**、剩余项均为**取舍或体验微调** → 停止评审，进入维护；仅在新功能、大改版、新数据类型或接入规模显著变化时重新评审。
**已知检测器误报**（复核记录）：`nested-cards`（卡片内表格/统计贴片/横幅/空态块）、`gray-on-color`（徽章与提示条实测 4.66–7.36:1，AA 达标）、`em-dash-overuse`（表格占位「—」与 CLI `--`）。
**剩余取舍（明确不做，非欠账）**：
- **不提供暗色主题**：CSDC 7.4 是纯浅色体系；此前跟随系统暗色的映射已按用户要求移除（2026-10-20），控制台亮色唯一。
- <768px 不做「表格转卡片」，以 `.c-table-wrap` 横向滚动为保底。
- 全局表格无列排序/筛选（归因/审计/档案）；usage 事件表窄屏键盘横滚体验一般。
- 单项目自动进入使「多项目对比」入口对单项目用户近乎不可见（`sessionStorage` 每会话一次，返回键可回）。
**重新评审触发**：新增页面族/动作、存储或记账口径变化、移动端真实使用反馈、或接入 >10 项目后的规模问题。

## CSDC 强约束修正（2026-10-20）

用户反馈：控制台属于 CSDC 项目，**不是“参考”CSDC，而是关键元素必须跟 CSDC 一致**；此前的 1320px 居中窄栏与系统暗色导致宽屏“变形”。本轮修正：

- **亮色唯一**：删除 `:root[data-theme="dark"]` 全部映射与 `prefers-color-scheme` 切换脚本，`color-scheme:light`＋`<meta name="color-scheme" content="light">`。
- **全宽布局**：`.c-layout` 去掉 `max-width:1320px`；侧栏 220px（CSDC 标准）、主区白底 `padding:20px 36px 80px`、页脚全宽浅灰底。
- **CSDC 徽标**：顶栏内联 `csdc-logo-navbar.svg`（`src/console/logo.ts`），后接「mobile-testing 控制台」产品名；侧栏增加「工作区」分组标题。
- **关键组件对齐**：区块/卡片标题采用 CSDC 黄色 Section Header（`#FFF9CC`＋`#FFE600`）；按钮与徽章统一 `--radius-pill`；表格改为卡片外框＋浅灰表头＋14/22px 单元格；卡片 28px 内边距。
- **验证**：1440/2546 宽屏、390 窄屏 Edge 截图；`impeccable detect` 随后执行。

## 总览表格重排（2026-10-21）

用户反馈表格占比小、列设计不合理；在 1440/2016 宽屏复核后重排：

- **去嵌套卡片**：区块内表格不再自带卡片边框/阴影，只保留浅灰表头与行分隔；「项目」黄色 Section Header 成为唯一容器层级。
- **固定列宽**：`cTable` 新增 `columnWidths`（数量与列数一致才启用 `table-layout:fixed`）；总览按项目 20% / 接入健康 30% / 栈 13% / 最后活跃 10% / 最新批次 22% / 备注 5% 分配，宽屏不再被内容摊薄。
- **行内动作收口**：删除每行重复的「进入项目」胶囊按钮，项目名本身即入口并带位移箭头；首屏保留「进入最近活跃项目」主 CTA。
- **批次列压缩**：通过状态与相对时间同一行，run id 独立一行并在窄列内省略（`title` 保留全文），避免 1440 下折成四行。
- **验证**：2016/1440 桌面截图 + CDP 真实 390px 视口；`c-project-link`、固定列宽、flush 表格与 run id 省略均有测试。
