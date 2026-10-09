# pen 资源导入（pen-assets）— spec

**Status:** implemented（2026-10-09；实施记录见 DESIGN §13.58，人工冒烟 `scripts/e2e-pen-assets.mjs`，真实 CLI 0.3.10 实测通过）

## Problem Statement

pen.dev 设计文件（`.pen`）的图标/矢量资源没有导入通道：AOS pen 工具面（P1）只有 inspect/flows/tokens/strings/brief/export/apply/agent，"设计资源 → 项目资产"只存在于 Figma 侧（`figma_gap_analysis` → `figma_import_assets`）。

此前判断"pen CLI 只能整档渲染、没有按节点导出能力"，**经核实不成立**：`pen interactive` 的 `execute` 提供 `Export(nodeIds, format, outputPath, options?)`，桌面版导出资源即该能力（证据见 Further Notes）。真实缺口在 AOS 接入侧——`pen_export` 只包了非交互的 `--export`（整档一张图）；interactive 管道虽已具备（`runPenInteractive`，`pen_apply_tokens`/`pen_apply_strings` 在用）但未接 `Export`，也没有资源清单来源与按栈写盘通路。

平台差异（必须显式处理）：`Export` **无 `svg`** 格式（png/jpeg/webp/pdf/html-tailwind/html-css），Figma 通道"SVG 优先"（DESIGN §13.3）不能直接搬；`pdf` 是整档合并（非逐节点独立文件），不适合作逐资源导入。

## Solution

新增 zod 工具 `pen_import_assets`：把 `.pen` 指定节点导出为位图，按检测到的技术栈命名/倍率集/目录写入项目，写盘语义与 `figma_import_assets` 逐条对齐（路径幂等 → sha256 内容去重 → `duplicate_of`，`dryRun`，`import-report.pen.json`，项目根内路径安全）。

- **清单来源**：v1 = 显式 `ids`（确定性，人工/agent 指定；与 figma 工具同为"用户给定 id"入口）；`candidates` 启发式（名称含 icon/logo、`reusable` 组件、小尺寸矢量 frame）列为 v1.5——只产出可复核清单（响应 + 报告），不静默导出。
- **导出通道**：复用 `runPenInteractive`（stdin 命令管道），命令 `execute({ input: 'Export([<全部 ids>], "<format>", "<tmpdir>", { scale })' })` → 临时目录按 `<nodeId>.<ext>` 落盘 → **以 `Export` 响应列出的写入绝对路径为对账基准**（文档明确"写入文件的绝对路径列在响应中"）→ 读回 → 按栈命名写盘 → 清理临时目录。CLI 定位/安装/登录透传沿用 `resolvePenCliPath`/`penCommandFor`/`PEN_CLI_KEY` 既有机制；失败按 `detectPenFailure` 分类给可行动指引。
- **倍率集（批量，单会话）**：Figma 侧一次 REST 导出多倍率；pen 侧**单次 interactive 会话**内按倍率依次执行命令——每条命令携带**全部 ids**，即 **CLI 进程数 = 1、命令数 = 倍率数**，与 ids 数量无关（30 个资源 × 3 倍率仍是 1 进程 3 命令，不存在逐 id 调用）；各倍率产物在各自临时目录读回，再按栈映射目录（§13.35 清单：Android xhdpi/xxhdpi、Flutter 1x/2.0x/3.0x、iOS imageset（1x/2x/3x + `Contents.json`）、RN base/@2x/@3x、Web 1x；`densities:false` 回退单 @2x）。
- **SVG 策略**：P0 位图倍率集（本 spec 范围），报告强制 `vector:"unsupported"` 标记留 P1 口子。P1 评估两条路线：① 离线合成（`.pen` 是开放 JSON，path/rect/ellipse 带 `geometry`/`fill`/`stroke`，可纯离线还原简单矢量）；② 探测 CLI 未来支持 `svg` 后切换。复杂矢量（渐变、旋转、蒙版/裁剪、位图填充、混合模式）显式降级清单，不静默丢（P1 预研按同一份清单划界）。
- **定位一致**：与 pen P1 "解析完全离线、写回需 CLI"的边界一致——本工具**不是**离线工具（`Export` 需 CLI + 登录/PEN_CLI_KEY），工具描述与文档须写明。

## User Stories

1. 作为测试/开发工程师，我想给 `.pen` 图标的 `ids`，它们就按当前技术栈命名/目录写入项目资源（不用手 rename），以便设计资源进入代码库。
2. 作为工程师，我想 `dryRun` 先看清单（目标路径/倍率/去重结果），确认后再正式写盘，以便可控。
3. 作为工程师，我想重复导入幂等：同内容 `unchanged`、异内容 `skipped_exists`/`overwrite`、跨文件重复记 `duplicate_of`，以便不污染仓库。
4. 作为工程师，我想 PNG 按栈倍率集导出（Android/Flutter/iOS/RN/Web），`densities:false` 时回退单 @2x，以便与 `figma_import_assets` 行为一致。
5. 作为工程师，我想非 PNG（jpeg/webp）只在显式指定时才用（默认 png），以便栈目录约定不被破。
6. 作为工程师，我想导入结果落 `import-report.pen.json`（可审计、不与 figma 报告互覆盖），响应给 counts/逐项状态，以便 CI/agent 判定。
7. 作为工程师，我想 CLI 缺失/未登录/超时得到可行动错误（复用既有 pen 安装与登录指引），而不是半个批次。
8. 作为设计师/工程师，我想未来能自动发现候选资源（启发式）并人工复核，以便大文件不必手找 id。
9. 作为工程师，我想失败时不留下临时文件/半写文件（原子写 + 临时目录清理），以便安全。
10. 作为维护者，我想文档（DESIGN/README/AGENTS）与实现同步，以便事实源一致。

## Implementation Decisions

- **工具与参数**：`pen_import_assets`；`{ path?, ids: string[]（v1 必填，≥1）, format?: "png"|"jpeg"|"webp"（默认 png）, densities?: boolean（默认 true）, destDir?, overwrite?: boolean, dryRun?: boolean, save?: boolean（报告）, timeoutMs? }`；`path` 缺省沿用 `resolvePenTarget`（`.artemis/design` 最新）。候选启发式（v1.5）另加 `candidates?: boolean` 与响应清单。
- **复用与改造**（优先零重复）：
  - 纯函数复用 `src/figma/import.ts`：`planImports`/`writeAssetFile`/`decideAssetWrite`/`sha256Buffer`/`buildAssetHashIndex`/`safeRelativePath`；
  - 栈规则复用 `src/projects/stack.ts`：`detectProjectStacks`/`primaryProfile`/`formatAssetFilename`/`skippedStacksWarning`（多栈警告与 figma 同行为）；
  - 脏名判定/回退复用 `src/figma/gaps.ts`：`isGenericLayerName` + `fallbackAssetName`（`asset <sha1(源 id) 前 8 位>` + `needsRename`），pen 侧种子用 nodeId；
  - pen 侧新建 `src/pen/assets.ts`（导出→读回→构造 `ImportPlanEntry`→走同一写盘管线）+ 解析 `Export` 响应中的写入路径（兜底按 `<nodeId>.<ext>` 扫描临时目录）。
- **`sourceId` 重命名（已决）**：`ImportPlanEntry`/`ImportResultEntry` 的 `figmaId` 直接重命名为 `sourceId`（pen 侧填 nodeId；**不加双字段**——内部类型，全仓 36 处引用含 2 个测试文件，随改动一并更新；测试只断言 `results[].relativePath/status/role`，无报告字段消费方）；`GapAssetEntry.figmaId` 保留原名（它本就是 Figma 扫描产物）。**报告 schema 护栏**：报告 payload 加 `schemaVersion`（figma 报告同批加），字段更名按 breaking change 记入实施记录。
- **命名（身份 hash，与内容解耦）**：节点 `name` → `formatAssetFilename`；脏名（`Frame 427`）回退**身份种子** `asset <sha1(nodeId) 前 8 位>`（沿用 `gaps.ts` `fallbackAssetName` 语义）。命名在 **plan 阶段**完成、与导出位图无关——多倍率下同一节点必然同名；内容 `sha256` 只用于 `unchanged/skipped_exists/duplicate` 判定。（DESIGN §13.3 原文"sha256 前 12 位"与实际实现不符，已一并修正。）
- **临时目录**：`os.tmpdir()` 下按运行随机子目录，`try/finally` 清理（成功/异常路径都清理）；不落项目避免污染。`Export` 的图片格式 `outputPath` 传目录（每节点 `<nodeId>.<ext>` 语义）。
- **倍率集映射**：跟随 StackProfile densities 规则（§13.35）；iOS 生成 `Contents.json`（复用 `role:"contents"` 路径）——**与 figma 产物一致：非矢量不写 `properties` 键**（依据 Xcode imageset 缺省语义：无 `properties` 即非矢量保真；不显式写 `preserves-vector-representation: false`），矢量缺失由报告 `vector:"unsupported"` 表达。
- **报告**：与 `figma_import_assets` 同构 payload（`source:"pen"`, `schemaVersion`, `penCliVersion`, `penPath`, `format`, `densities`, `dryRun`, `detectedStacks`, `warnings`, `counts`, `uniqueness`, `results`, `hint`）+ 降级标记 **`vector:"unsupported"`**（report 级，声明本通道只出位图）；落盘 `.artemis/design/import-report.pen.json`（已决：与 figma 报告独立，后执行不覆盖先执行）。
- **完整性与失败判定（缺文件口径，显式定义）**：① 导出前**离线预校验 ids 存在于 `.pen` 树**（不存在 → 参数错误，失败快）；② 以 `Export` 响应列出的写入路径为对账基准、目录 `<nodeId>.<ext>` 扫描兜底；③ `ids×倍率` 与产物数对账：逐项缺失记 `status:"error", error:"export-no-output"`，批次级 warning（**全缺**≈CLI/格式问题；**部分缺**≈可能零尺寸/不可见节点——提示先用 `pen_inspect` 复核）；④ 文档注明"空节点可能合法无产物，调用方应过滤"。
- **超时预算（会话级，自适应默认）**：核实 `penExec` 定时器为**进程级**——一次 spawn 一个 timer，覆盖整个 interactive 会话（含全部 `Export` 命令 + save + exit），N 条命令共享预算。因此：默认 `timeoutMs = AOS_PEN_IMPORT_TIMEOUT_MS ?? max(AOS_PEN_TIMEOUT_MS(120s), 60s + ids数×倍率数×5s)`，上限 30min；超时报错附建议值（系数实现时定）；熔断复用 `penExec`（硬超时 → `SIGKILL` 直接子进程 → `error:"timeout"` → `detectPenFailure` 超时分类，`src/pen/cli.ts:143-155`/`224`）；边界：只杀直接子进程，孙进程不在保障内。
- **契约验收（v1 门槛）**：真实 CLI 产物契约（`<nodeId>.<ext>` 布局、`scale` 生效、图片格式多文件）——单测以假响应文本覆盖对账逻辑；**人工冒烟** `scripts/e2e-pen-assets.mjs`（需 CLI + 登录，先例 `e2e-device.mjs`/`e2e-crash.mjs`）；报告记录 `penCliVersion`，契约快照绑定 CLI 0.3.10（Further Notes 能力核查），CLI 升级时复核更新。
- **安全**：`destDir` 相对项目根解析，绝对路径/越界拒绝（`safeRelativePath` 语义）；`PEN_CLI_KEY` 只进子进程 env、不落日志（既有）。
- **usage/文档**：family 按 `pen_` 前缀自动归 `pen`；实现时同步 DESIGN（§6.1 行 + 实施记录）、README、AGENTS。

## Testing Decisions

- 全程不联网、不依赖真实 pen CLI/账号：注入假 exec（先例 `test/pen-export.test.js`/`pen-cli.test.js` 的 `PenExecFn` 注入），断言 interactive 命令形状（**单次 exec 调用**、命令数 = 倍率数、单条命令携带全部 ids、`save()/exit()` 由 `runPenInteractive` 追加）与 stdin 内容。
- 假 CLI 行为：在临时目录写 `<nodeId>.png`（不同倍率不同内容）→ 断言读回→按栈命名/内容去重/幂等/`duplicate_of`/`dryRun`/报告结构（含 `schemaVersion`/`penCliVersion`/`vector:"unsupported"`）/`densities:false`/多栈警告；**对账断言**：假响应列出全部路径 → 通过；列出子集 → 逐项 `export-no-output` + 批次 warning；**多倍率同名**断言：同一节点 1x/2x/3x 产物的基础名一致（身份命名，非内容命名）；错误路径：未登录文案、超时（注入不返回的假 exec → 断言超时分类与子进程被杀）、历史 id 预校验失败、destDir 越界。
- fixture：内联 `.pen` 字符串（先例 `PEN_SAMPLE`），含 icon 名/脏名（`Frame 427`）/`reusable` 组件；iOS 断言 `Contents.json`（非矢量无 `properties` 键）。
- 命令：`npm run test:file -- test/pen-assets.test.js`（先构建）。
- **人工冒烟（非 CI，v1 验收）**：`node scripts/e2e-pen-assets.mjs`（需 pen CLI + 登录）——真实 `Export` 契约（响应路径对账、scale 生效、多倍率文件）与写盘闭环；基线 CLI 0.3.10。

## Out of Scope

- `html-tailwind`/`html-css`/`pdf` 导出（pdf 整档合并、html 单文件，不适合作逐资源导入；另案）。
- 位图 image fill（本 fixture 的 image fill 无 source/键，无法直接提取）与设计内嵌图片资产的迁移。
- 复杂矢量（渐变、旋转、蒙版/裁剪、位图填充、混合模式）的 SVG 保真——P1 离线合成另行评审（同一份排除清单）。
- `pen_apply_*` 反向写回设计侧（本工具只读 `.pen`）。
- 候选资源的自动分类/去重语义（v1.5 只给清单；v1 不预留空字段——增量字段非破坏）。
- Figma/pen 两通道资产合并策略（同内容跨源仍由 sha256 去重自然覆盖）。
- **后续项（非阻塞）**：写盘/去重纯函数从 `src/figma/import.ts` 下沉 shared 层（pen→figma 依赖已存在于 apply/brief/flows/strings/tokens，本次不新增依赖方向）。

## 决议（2026-10-09 两轮评审通过）

| # | 问题 | 决议 |
|---|---|---|
| 1 | 独立工具 vs 扩 `pen_export`（加 `ids`） | 独立 `pen_import_assets`（职责分离：整档渲染预览 vs 按节点抽取落盘） |
| 2 | v1 是否需要启发式候选 | 仅显式 `ids`；候选清单留 v1.5（Agent 经 `pen_inspect` 自选 id 更准） |
| 3 | SVG：P0 位图先行 | 位图先行；报告强制 `vector:"unsupported"` 标记；P1 离线合成或等 CLI 支持 |
| 4 | 报告文件与 figma 共存 | 独立 `import-report.pen.json`（不互相覆盖，可按 source 做 CI 校验） |
| 5 | `figmaId` 泛化 | `ImportPlanEntry`/`ImportResultEntry` 重命名 `sourceId`（+测试；无报告字段消费方）；不做双字段；报告加 `schemaVersion`；`GapAssetEntry.figmaId` 保留 |
| 6 | 临时目录位置 | `os.tmpdir()` + `try/finally` 清理（异常路径同样清理） |
| 7 | 倍率集默认 | 跟随栈 profile，与 figma 完全一致 |

**v1 准入门槛（第二轮评审采纳，均属 v1 验收、不拆后续票据）**：① 真实 CLI 契约对账（响应写入路径 × ids×倍率；人工冒烟 + `penCliVersion` 基线 0.3.10）；② 缺文件判定口径（离线预校验 + 对账 + `export-no-output` + 批次告警）；③ 超时预算自适应（会话级语义 + `AOS_PEN_IMPORT_TIMEOUT_MS`/公式）。

## Further Notes

- **能力核查（2026-10-09，本机 CLI 0.3.10；契约快照）**：`pen interactive --help` 与 `dist/out/skills/pen-dev/execute.md`：`function Export(nodeIds: string[], format: "png"|"jpeg"|"webp"|"pdf"|"html-tailwind"|"html-css", outputPath: string, options?: ExportOptions): void`；`ExportOptions { scale?（默认 2）, quality?, includeHtmlScaffold?, includeLayerNames?, includeLayerIds? }`；**响应列出每个写入文件的绝对路径**；图片格式每节点独立文件 `<nodeId>.<ext>`；pdf 合并；html 单文件、图片相对引用、不内嵌。桌面版导出即该执行能力。CLI 升级时复核本快照。
- **AOS 现状（证据）**：`src/pen/cli.ts:295` `runPenExport` 仅 `--in/--export/--export-scale/--export-type`（整档）；interactive 管道 `runPenInteractive`（`src/pen/cli.ts:266`）已用于 `pen_apply_tokens`/`pen_apply_strings`；`src/figma/import.ts` 的写盘/去重管线与 `src/projects/stack.ts` 的 `formatAssetFilename` 可直接复用；超时熔断在 `penExec`（`src/pen/cli.ts:143-155`）已内建且为**进程级**。
- **fixture 事实（starbucks-ios-taiwan `.pen`）**：25924 节点（6974 path、846 image fill）；image fill 无 `url`/键（该文件无法直接提取位图）；`screens/*.png` 为逐节点导出产物先例。
- **与 `figma_import_assets` 差异表**：

| 维度 | figma_import_assets | pen_import_assets（本文） |
|---|---|---|
| 清单来源 | gaps.json（exportSettings + 启发式） | v1 显式 ids；候选启发式 v1.5 |
| 矢量 | SVG 内联优先 | 无 SVG → 位图 + 报告 `vector:"unsupported"`（P1 离线合成评估） |
| 位图来源 | REST `/images`（多倍率一次请求） | interactive `Export`（单会话、每倍率一条命令、单命令全 ids） |
| 命名/目录/幂等/去重/dryRun/报告 | 同一套 | **复用同一套** |
| 运行依赖 | FIGMA_ACCESS_TOKEN + 网络 | pen CLI + 登录/PEN_CLI_KEY（非离线） |

- **评审反馈处理（第一轮，2026-10-09）**：✅ 采纳——Q3 降级标记（report 级 `vector:"unsupported"`，不写 Contents.json）、Q5 `sourceId` 直接重命名（不做双字段）、批量语义显式化（单会话/1 进程/命令数 = 倍率数；"30 id × 3 倍率 = 90 次 CLI 调用"系对"每倍率一次"的误读）、身份 hash 与内容 hash 解耦（写入 spec + 测试；现行 `gaps.ts` 实现已天然保证）、超时熔断复用既有 `penExec` 机制（不新增 `PenCliHungError`）。❌ 未采纳——`Contents.json` 显式 `preserves-vector-representation: false`（与既有 figma 产物不一致、Xcode 缺省即 false，降级由报告表达）。
- **评审反馈处理（第二轮，2026-10-09）**：✅ 采纳为 v1 门槛——真实 CLI 契约对账（响应路径 + 人工冒烟 + `penCliVersion` 基线；离线单测约束不变，AGENTS 完工标准 ③）、缺文件判定口径（离线预校验 + 对账 + `export-no-output` + 批次告警 + 空节点文档）、超时预算自适应（会话级语义 + 公式）。✅ 采纳（一致性）——复杂矢量排除清单统一（两处对齐）、iOS `properties` 缺省语义注释、报告 `schemaVersion`。☑️ 修正前提——`sourceId` 影响面更小（仓库内无报告消费方、测试仅断言 `relativePath/status/role`，轻量护栏即可）、pen→figma 依赖为既有惯性（记录后续项，非本次新增）。❌ 未采纳——v1 为 `candidates` 预留空字段（MCP 增量字段非破坏、无严格 schema 消费方，文档已声明 v1.5 形态）。
- 实施通知后：拆票据（v1 ids-only 位图 → 候选清单 → SVG 评估），实施按 AGENTS 完工标准更新 DESIGN/README/AGENTS + 测试。
