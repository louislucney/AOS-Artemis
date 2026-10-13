# 设计流水线截图嵌入（design-screenshots）— spec

**Status:** ready-for-agent（本地暂存稿：Jira 沙箱凭证就绪后，按 `docs/agents/issue-tracker.md` 发布为 Task；发布后本目录仅作归档）

## Problem Statement

设计流水线产出的 md 全是纯文字：pen 的 `flow-map.md` 只有屏幕名与推断链；`tests.md` 只有用例名/步骤/任务描述；figma 侧**连流程 md 都没有**（只有 flows.json）。复核几十屏的大文件、或从用例反查设计稿时，只能靠屏幕名和流程名在 Figma/pen 里人肉找屏，成本高、易错配。截图是最高效的锚点，但当前产物里没有任何图。

## Solution

在流水线 md 中嵌入屏幕截图（相对路径引用、缩略尺寸展示），让人一眼定位"这一条对应哪块设计"。三处落地：

- **pen `flow-map.md`**：每个屏追加一行缩略图（画板分组内）；
- **`tests.md`**（figma/pen 用例共用）：每个用例横排其涉及屏幕（≤3 张缩略图）；
- **figma 新增同构 `flow-map.md`**：补齐 figma 侧缺失的流程文档，含缩略图。

截图统一落 `<configDir>/design/screens/<来源slug>/<nodeId>.png`（figma slug=fileKey、pen slug=pen 文件名；id 做文件名安全转义）。默认开启（`screens:false` 或 `AOS_SCREENS=0` 关闭）；渲染失败**逐屏降级不阻断**（无图 + 结构化 warning）；幂等（sha256 相同跳过）、原子落盘（md 引用的路径永不指向半截文件）。pen 通道与 vision 共享同一次渲染（Q6 统一目录）。

## User Stories

1. 作为复核者，我想在 pen `flow-map.md` 里每个屏名旁直接看到缩略图，以便确认屏与画板的对应关系。
2. 作为复核者，我想在 figma 的 `flow-map.md`（新增）里看到屏幕清单与缩略图、主链与未决目的地，以便不打开 Figma 就能通读流程。
3. 作为开发者，我想在 `tests.md` 每个用例下看到其涉及屏幕的缩略图，以便快速找到对应设计稿核对期望。
4. 作为开发者，我想缩略图按相对路径引用、md 与 `screens/` 同级，以便在任何标准 Markdown 预览器（VS Code/GitHub）原地预览都能显示。
5. 作为开发者，我想 md 不内嵌 base64，以便 md 保持可读、可用 git diff 审阅。
6. 作为使用者，我想截图渲染失败（无 Figma token / 限流冷却 / pen CLI 缺失 / 单屏未就绪）时 md 照常生成并带明确 warning，以便流水线不被截图能力卡住。
7. 作为使用者，我想单屏渲染失败（Figma 返回 null）时有界重试一次后逐屏降级（`screenshot-skipped`），以便区分"个别屏失败"与"通道不可用"（`screenshot-render-unavailable`）。
8. 作为使用者，我想旧版 flows.json（无 `fileKey`/`source`/屏幕 id 映射）时如实降级为无图（`screenshot-mapping-missing`），以便不猜测、不伪造。
9. 作为使用者，我想重跑幂等：同一屏渲染结果 sha256 相同时不重写文件（mtime 稳定），以便保留期报告与增量复核不被扰动。
10. 作为使用者，我想图片落盘是原子的（临时文件 → 校验 → 替换），以便已生成的 md 不会指向半截/损坏的 PNG。
11. 作为使用者，我想 pen 渲染产物即使由 CLI 直写也不破坏原子性（私有临时目录 → 逐张校验 PNG 魔术头 → 原子替换），以便崩溃/中断不留坏图。
12. 作为使用者，我想 pen 交互会话串行执行（进程级队列）且 session 输出文件唯一命名，以便并发调用（如 vision 与截图同批、或两个工具并行）不互相覆盖会话文件。
13. 作为使用者，我想 pen vision 开启时截图与视觉识别**共享同一次渲染**（统一目录 `design/screens/pen-<name>/`），以便不重复渲染、不重复等待。
14. 作为使用者，我想 `suite retention` 覆盖 `screens` 分类，以便截图纳入保留期只读报告。
15. 作为使用者，我想 `screens:false`（按工具）与 `AOS_SCREENS=0`（进程级）能关闭截图层，以便不需要时零开销。
16. 作为使用者，我想工具响应携带截图摘要（`screens: { dir, rendered, skipped, skippedScreens }`）与 warnings，以便 agent 知道发生了什么。
17. 作为使用者，我想文档明确"md 请原地预览（相对路径）"，以便不把"单独把 md 拷走导致图失锚"当成缺陷。
18. 作为服务开发者，我想截图仅是展示层增强：不改 taskDesc、不动三件套门禁与 `suite` 覆盖率契约，以便零行为回归。
19. 作为服务开发者，我想全部测试离线（figma 打桩 fetch、pen 注入 exec/render），以便不依赖真 token/CLI。
20. 作为服务开发者，我想 DESIGN/README/AGENTS 同步，以便契约与用法可查。

## Implementation Decisions

- **共享模块 `src/design/screens.ts`**：`sanitizeScreenId`（`[^A-Za-z0-9._-]` → `-`）、`isPngBuffer`（魔术头 `89 50 4E 47`）、`storeScreenPng(targetDir, id, buffer)`（sha256 相同 → `skipped`；损坏既有文件 → 覆盖；否则 `writeFileAtomic` 原子写；新 buffer 非法 → `invalid` 不落盘）、`importScreenFile(tempFile, targetDir, id)`（pen 通道：校验后原子替换）、warning 词汇常量：`screenshot-skipped` / `screenshot-render-unavailable` / `screenshot-mapping-missing`。
- **存储与命名**：`<configDir>/design/screens/figma-<fileKey>/<id>.png`、`<configDir>/design/screens/pen-<slug>/<id>.png`（slug=pen 文件名去扩展名并 sanitize）；md 相对引用 `screens/...`（md 与 `screens/` 同级，原地预览）。
- **md 展示**：缩略图用 HTML `<img src="screens/..." height="200">`（flow-map）/ `height="160"`（tests.md），不用 base64；flow-map 主链/警告/统计结构不变，截图 warnings 追加进警告区。
- **pen 通道（`pen_extract_flows`）**：渲染条件 = `screens 开启 或 vision 激活`；一次 `renderPenScreens` 到统一目录 `design/screens/pen-<slug>/`（vision 的 outDir 从 `design/vision/<name>/` 迁入统一目录；旧 flows.json 的历史 renderPath 不回溯）；CLI 直写 → 先私有临时目录、逐张 `importScreenFile` 原子入库；`flow-map.md` 每屏追加缩略图；`screens:false` 时仅 vision 需要则渲染但 md 不嵌图。
- **pen 并发加固**：`runPenInteractive` 入口增加**进程级串行队列**（promise 链）；session 输出文件名唯一化 `session-<pid>-<rand>.pen`；`--export` 一次性调用暂不入队。
- **figma 通道（`figma_extract_flows`）**：新增 `flow-map.md`（来源/生成时间、屏幕清单+缩略图、主链/未决目的地、警告、统计）；批量 `fetchImages(fileKey, ids, "png", 1)`（一次调用）→ 逐节点下载；**单节点 null → 有界重试 1 次 → `screenshot-skipped`**；通道级失败（无 token/`FigmaRateLimitError`/HTTP 错误）→ `screenshot-render-unavailable`，md 照常；下载字节 `isPngBuffer` 校验后 `storeScreenPng`。
- **tests.md（`figma_generate_tests`）**：新增 `readFlowDocument`（design-store；保留 `fileKey`/`source` 与屏 `id`/`name` 映射；**不改 `normalizeFlowGraph`**）；按用例 `screens` 名→id 映射渲染（`source: figma:*` → REST、`pen:*` → pen CLI，相对路径按项目根还原）；每用例 ≤3 张缩略图（超出加"…"）；映射缺失 → 该用例无图 + `screenshot-mapping-missing`；legacy flows 无 source → 整体无图降级。
- **开关**：`figma_extract_flows` / `pen_extract_flows` / `figma_generate_tests` 新增 `screens?: boolean`（默认 true）；`AOS_SCREENS=0` 进程级关闭（arg 优先）；响应 payload 增 `screens: { dir, rendered, skipped, skippedScreens[] }`，warnings 追加。
- **保留期**：`RETENTION_CATEGORIES` 增 `screens` 分类（`suite retention` 自动覆盖）。
- **不改**：taskDesc/用例语义、三件套与覆盖率门禁、`suite` 契约、`mobile_*` schema；xlsx/JUnit 不嵌图。
- **文档同步**：README 设计流水线小节（截图说明 + "原地预览"注记 + 开关）、AGENTS 速查、DESIGN 实施记录；用户可见文案中文。

## Testing Decisions

- 好测试只验证外部行为：md 内容（相对路径、`<img>`、警告文案）、落盘文件存在与内容一致、幂等跳过、损坏降级；不测私有渲染细节。
- 接缝与先例（全部离线）：
  1. **screens 模块**：纯函数 + 临时目录——sanitize、PNG 校验、sha 跳过、原子替换、非法 buffer 不落盘（先例：pen-assets 的幂等/去重测试）。
  2. **pen 通道**：`test/pen-flows.test.js` 注入 `render`/`exec`——flow-map 含 img 引用、vision 复用一次渲染（渲染调用次数断言）、降级 warnings、session 名唯一、串行队列（两个并发调用不交错）。
  3. **figma 通道**：`test/figma-flows.test.js` 打桩 `globalThis.fetch`（先例：figma-limits / stubFigmaFetch）——flow-map.md 结构、批量渲染一次调用、单屏 null 重试后降级、无 token 通道级降级。
  4. **tests.md**：`test/figma-testgen.test.js`——名→id 映射、≤3 张截断、缺映射降级、legacy 降级、`screens:false` 全关。
  5. **retention**：`test/retention.test.js` 增 `screens` 分类断言。
- 真实冒烟（人工、非 CI）：真 Figma token 与真 pen CLI 各跑一条流水线，浏览器/VSCode 预览确认截图显示。

## Out of Scope

- xlsx / JUnit / run-report 内嵌图；base64 内联。
- `build-brief.md` 的组件/令牌截图（P1 另议）。
- Figma 桥（plugin）导出通道（现状工具面无导出能力）。
- 视频/GIF、自动裁剪/标注/对比框。
- 截图随 md 打包分享（Jira 附件化后续议题）。

## Further Notes

- 决策记录（grilling 第 1 轮推荐，均按推荐采纳）：Q1=B（pen flow-map + tests.md + figma 新增 flow-map）；Q2=缩略图（200/160px，figma scale=1）；Q3=`screens/<来源slug>/<id>` + sha 幂等 + retention；Q4=默认开 + 逐屏降级；Q5=按 flows 源自动分派；Q6=统一目录、vision 共享一次渲染。评审加固 4 条（相对路径原地预览注记、Figma null 有界重试、pen 会话串行 + 唯一 session 名、双通道原子落盘）已并入。
- 建议拆分（to-tickets 时细化）：T1 `src/design/screens.ts` + retention 分类；T2 pen 通道（统一渲染目录/串行队列/flow-map 嵌图）；T3 figma 通道（新增 `flow-map.md` + 批量渲染与降级）；T4 tests.md 映射与配图；T5 文档同步；T6（P1）build-brief/xlsx 备选。**进度**：T1–T4 已实施（DESIGN §13.99–§13.102）。
- Jira 发布（凭证就绪后）：`node dist/cli.js jira issue create --project-key <KEY> --summary "设计流水线截图嵌入（spec）" --type Task --label ready-for-agent --description "$(cat .scratch/design-screenshots/spec.md)"`。
- 落地时按仓库惯例同步：DESIGN 里程碑/实施记录、README、AGENTS、CONTEXT（如需"截图"术语）。
