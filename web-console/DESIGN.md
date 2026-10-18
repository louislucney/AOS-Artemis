# Web 控制台视觉体系（CSDC）

> 来源：CSDC 开发者设计系统 `https://html.temvo.com/CSDC/`（用户指定为绑定风格；参考文件存 `.scratch/web-console/references/csdc/`）。
> 实现：`src/console/tokens.ts`（唯一 CSS 变量源）＋`src/console/shell.ts`（顶栏/侧栏/主区外壳）。只做亮色（暗色为后续项）。
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

- 顶栏（sticky 毛玻璃）：品牌「AOS 控制台」＋右侧上下文（项目/生成时间/存储徽章即 `meta`）。
- 侧栏 196px（`aria-label="控制台导航"`）：`aria-current="page"` 标记当前项（黄底）；≤960px 转横向滚动条。
- 主区卡片化（Task 2 起组件：`cCard/cBadge/cBanner/cTable/cStat/cEmpty/cConfirmForm`）。
- 页脚一行：`AOS-ARTEMIS · 本地服务`。

## 状态口径

- 存储三态标签（与 `src/db/labels.ts` 同源）：PostgreSQL／文件台账（.artemis/ledger）／会话内存（仅本次进程，数据不持久）。
- 危险动作确认分级：常规＝`data-confirm`；外部副作用＝dryRun 预览＋确认；清理类＝输入确认短语。
- 刷新纪律：整页 `meta refresh` 仅限**无表单**的活跃列表页；含未提交表单的页面不刷新。

## 组件类名（计划）

`c-topbar/c-brand/c-topbar-meta/c-layout/c-aside/c-nav-item/c-main/c-footer`（Task 1）；`c-card(-accent)/c-badge-*/c-banner-*/c-table/c-stat/c-empty/c-button(-primary/-danger)/c-confirm`（Task 2）。

导航口径：usage 独立进程显示 `USAGE_STANDALONE_NAV`（`src/console/shell.ts`：仅「统计」自身，不显示跨进程链接）；HTTP 模式下 `/panel` 与 `/usage` 各自导航（/usage 沿用该子集，后续如需并入主导航再议）。

AA 偏差记录：`--color-link-hover` 采用 `#0066CC`（CSDC 原值 `#0077ED` 对白底 4.3:1，低于 AA）；遗留 PAGE_CSS 的 `#888` 已改 `#6E6E73`；`impeccable detect` 对 `scripts/console-fixtures.mjs` 产物为 **0 anti-patterns**。

**critique→polish 轮（2026-10-18）**：样式收敛为**单一源**——`tokens.ts`（CSDC 变量＋组件）＋`compat.ts`（遗留标记兼容层，颜色/圆角对齐 token；不再有第二份 legacy `<style>` 与 `color-scheme` 双色系）；危险按钮 `#B91C1C`（≥4.5:1）；主按钮 hover 保持深色文字（修 4.39:1 边缘）；`.c-skip-link` 跳链；页级能力横幅与禁用态口径见 `src/console/shell.ts` 的 `ConsoleCapabilities`。
