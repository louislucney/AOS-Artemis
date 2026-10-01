# 设计 vs 真机差异：可反馈、可定位 — 完整方案

> 本文件合成自 `.scratch/design-device-diff/spec.md`、`docs/adr/0001-0004`、`CONTEXT.md` 与 7 张票据，便于单文件阅读；冲突时以各源文件为准。

---

## 1. 背景与方案

### 问题（Problem Statement）

移动开发者用 ARTEMIS 在真机上跑完端到端任务后，无法可靠地知道「真机显示与设计稿是否有明显差异、差异在哪、该改哪里」。现有 `compare_design_and_device` 只把设计渲染图与**实时**截图并排返回，交给多模态人眼看：失败那一步的截图取不到，差异没有区域/类型/严重度，报告不落盘不可复现，代码定位全靠猜。结果是视觉回归依赖人工、失败反馈断链、修复成本高。

### 方案（Solution）

新增两个原生工具：

- `design_device_diff`：把「设计渲染」与「真机截图」作为一次**对比单元**，做确定性对齐与像素差异判定，产出结构化**差异报告**（类型/区域/严重度/证据）与标注图，落盘到项目 `.artemis/design/diffs/`。设备侧优先使用**步骤截图**（trace 的失败步骤），也支持实时截图；设计侧支持 Figma 与 `.pen`。
- `screen_map`：维护持久**屏幕映射** `screen-map.json`（设计屏幕/组件 ↔ 路由/组件/文件），让差异报告完成实现侧**定位**；未映射时标记 `unmapped` 并给候选，不猜测。

差异的**解释与修复建议**不在工具内做：工具给足结构化证据与标注图，由调用方的多模态 agent 完成（判定与解释分离）。

---

## 2. 术语表（CONTEXT.md）

### 设计与真机对比

- **设计渲染（design render）**：设计源的可视快照，作为对比的基准侧。例如 Figma 节点导出图、`.pen` 文件的渲染图。与具体来源工具无关（来源可替换）。
- **真机截图（device capture）**：ARTEMIS 从设备获取的屏幕图，作为对比的观察侧。按获取时机分为「实时截图」与「步骤截图」。
- **步骤截图（step screenshot）**：某一次任务执行中，某一交互步骤的截图（含动作标注 overlay）；用于把差异锚定到具体执行步骤。
- **对比单元（comparison unit）**：一次对比中的配对单位——一个设计渲染与一张真机截图，配对依据是同一屏幕/节点。
- **对齐（alignment）**：把设计渲染与真机截图放到同一坐标系所需的缩放/平移/裁剪；结果必须可复现、可写入报告。
- **差异判定（diff judgment）**：判定两张图是否存在「明显差异」并给出候选差异区域。分层：确定性判定产生候选与证据；模型只做归类与解释，不承担判定。
- **差异报告（diff report）**：差异的机器可读产物。每条差异包含类型、区域、严重度、证据与置信度；是反馈与定位的共同输入。
- **定位（localization）**：把一条差异映射到实现侧的组件/文件（粗粒度），或映射到设计稿节点、测试用例步骤、执行步骤（作为分类标签）。
- **屏幕映射（screen map）**：设计屏幕/组件与实现侧路由、组件、文件之间的持久对应表；差异报告经由它完成实现侧定位。
- **差异分类（diff category）**：差异的类别（缺失/多余/位置尺寸/颜色/文案/资源）与严重度（blocker/major/minor/info），由确定性规则给出，模型不参与。
- **修复建议（fix suggestion）**：针对一条已定位差异给出的修改方向；解释层产物，不参与判定。

---

## 3. 关键决策总览（grilling 共识）

**目标与闭环**
1. 第一消费者：人审（双图+标注+定位清单）；下次演进到 agent 自动闭环；CI 门禁最后。
2. 判定分层：确定性算法出候选与证据，模型只做归类/解释（判定/解释分离）。
3. 对比单元：设计节点 ↔ 真机截图；失败步骤截图优先于实时截图。
4. 定位目标：实现代码组件/文件为主，设计/用例/执行步骤作为分类标签。
5. 设计源抽象：Figma 先落地，`.pen` 作第二源。

**引擎**
6. 计算落点：AOS TS 纯 JS（`pngjs`+`jpeg-js`+`pixelmatch`），ARTEMIS 结构信号作输入。
7. 对齐：设计宽度缩放 + 顶部对齐，`insets` 参数修正；自动检测系统栏后置；默认降采样最长边 1440px（可配）；`ignoreRegions` 屏蔽动态区域；贴边差异按系统安全区降级标注。
8. 分类：`missing/extra/position-size/color/text/asset` × `blocker/major/minor/info`，阈值默认 0.1 / 0.5% / 8px / 20 区，可配。
9. 失败步骤：显式 `trace_id+step_number` 为稳定接口，自动模式用 `mobile_inspect_trace(search)` 找回步骤；上游加锚点记 backlog；Flash 无 `run_outcome`。

**产物**
10. 落盘 `.artemis/design/diffs/<screen>-<ts>/`：`report.json`（带 schemaVersion）+ `annotated.png` + 原图；响应=摘要 + 标注图 + 路径。
11. 解释/修复建议由调用方多模态 agent 做；工具不硬依赖 active LLM。
12. 屏幕映射：持久 `screen-map.json`，独立小工具（list/propose/save），未映射标 `unmapped`。
13. 触发：v1 手动 → 失败任务自动 → 全终态自动。

**工具与验收**
14. 新工具 `design_device_diff`（现有 compare 不变）+ 屏幕映射小工具；输入含设计源/设备源（live|step）/对齐参数。
15. 验收：合成 golden（CI 确定性）+ 一对真实设备离线 fixture；指标=区域召回/类型命中。
16. 术语固化到 `CONTEXT.md`。

---

## 4. 架构决策记录（ADR）

### ADR-0001 差异判定与解释分离

设计稿与真机截图的差异判定必须可回归、可复现：由确定性规则产生候选差异区域并给出类别与严重度，模型只允许做归类、解释与修复建议，不参与「是否存在差异」的判定。理由：判定结果要能写进测试基线（golden 回归），且 AOS 的 active LLM 不保证多模态（当前 deepseek-flash），不能把判定托付给模型。

**考虑过的选项**：纯多模态 LLM 直接判图（不可复现、依赖模型能力、无法稳定回归，拒绝）；服务端只做取图不做判定（差异只能在客户端人眼/模型里消失，无法定位，拒绝）。

### ADR-0002 差异计算落在 AOS TypeScript 侧

像素级差异比较在 AOS（TypeScript）进程内完成，采用纯 JS 图像栈：`pngjs`（设计渲染图解码）、`jpeg-js`（真机截图解码，ARTEMIS 截图固定为 JPEG）、`pixelmatch`（像素对比）。ARTEMIS 的结构信号（UI hierarchy/OCR）继续通过既有 MCP 工具获取，不新增子模块脚本通道、不直连 Python venv。

**考虑过的选项**：复用 ARTEMIS Python（pillow/opencv 已就绪）零新依赖，但需要跨子模块新增调用通道，测试与 CI 会绑定 venv，拒绝；服务端不做像素计算（仅结构信号）无法稳定产出差异区域与证据，拒绝。

**后果**：新增三个小体积运行时依赖（无原生编译）；大图需先降采样；差异引擎可在无设备、无网络、无 Python 的测试环境里跑 golden 回归。

### ADR-0003 失败步骤锚定经上游工具编排，不直读 data_engine.db

「失败步骤截图」的来源不直读上游 SQLite（`data_engine.db`）与 `check_ledger.jsonl`：稳定接口要求调用方显式给 `trace_id + step_number`；自动模式通过 AOS 内部调用上游 `mobile_inspect_trace(action="search")`，用失败证据文本找回步骤；截图路径由 `mobile_inspect_trace(action="view_step_screenshots")` 返回（pre/post/overlay）。理由：不绑定上游数据库 schema、不引入 sqlite 依赖、复用上游已编排好的读取逻辑；AOS 已具备内部调用上游工具的通路（`runtime.proxy.callTool`）。

**后果**：自动模式只对 Pro 任务有效（Flash 任务没有 `run_outcome.json`），且按文本检索属于 best-effort；上游若把步骤锚点写进 `run_outcome.failed_items`（记入 backlog），自动模式可升级为精确映射。

### ADR-0004 屏幕映射是持久产物（screen-map.json）

「差异 → 实现代码」的定位依赖持久映射文件 `<项目>/.artemis/design/screen-map.json`：设计屏幕/组件 ↔ 路由、组件、文件；首次由独立小工具基于 build-brief（组件清单）与技术栈约定生成候选并经显式保存，后续增量维护。差异报告引用映射条目，未映射的差异标记 `unmapped` 并给出候选，不猜测。理由：每次运行时临时启发式匹配不稳定且不可审计；映射一旦可用，人和 agent 都能复核与修正。

**考虑过的选项**：每次运行临时启发式匹配（结果不稳定、无法积累、无法审计，拒绝）；把映射写进 `tests.json`（生命周期属于测试用例而非定位资产，拒绝）。

---

## 5. 规格（Spec）

### User Stories

1. 作为移动开发者，我想把 Figma 节点与真机当前截图直接对比，以便不用手工截屏看图就能判断是否还原。
2. 作为移动开发者，我想用 `.pen` 文件作为设计源发起对比，以便在不用 Figma 的流程里同样能做视觉校验。
3. 作为移动开发者，我想指定 `trace_id + step_number` 用某一步的截图做对比，以便复核失败发生时的屏幕状态而不是事后猜测。
4. 作为移动开发者，我想只给 `trace_id` 就让它自动找回失败步骤，以便快速复现问题现场。
5. 作为移动开发者，我想显式传入真机截图的 insets（状态栏/导航栏）做对齐修正，以便设计稿与截图坐标系一致。
6. 作为移动开发者，我想拿到一张差异标注图（差异区域框选），以便一眼看出问题位置。
7. 作为移动开发者，我想拿到结构化差异列表（类别/区域/严重度/证据），以便逐条处理而不是凭感觉。
8. 作为移动开发者，我想调整判定阈值（像素阈值/最小区域/聚类间距/区域上限），以便按项目容忍度控制噪声。
9. 作为移动开发者，我想每次对比的报告与图片都落盘并带时间戳，以便回溯历史与对比修复前后。
10. 作为移动开发者，我想差异被定位到实现侧组件/文件，以便知道去哪里改代码。
11. 作为移动开发者，当设计节点尚未映射到代码时，我想看到候选与 `unmapped` 标记，以便补全映射而不是被蒙在鼓里。
12. 作为移动开发者，我想查看当前屏幕映射并对未映射项生成候选，以便逐步补齐。
13. 作为移动开发者，我想显式保存映射修改，以便映射可审计、可回滚。
14. 作为移动开发者，我想 `dryRun` 预览将要执行的对比与产物路径，以便不写盘先确认。
15. 作为移动开发者，我想差异报告带 schema 版本且输出顺序稳定，以便进 CI 或做回归 diff。
16. 作为移动开发者，我想在 Flash 任务（无 `run_outcome`）无法自动找步骤时得到明确说明，以便改用显式 `step_number`。
17. 作为移动开发者，我不想让对比依赖 active LLM 是否多模态，以便在任何 LLM 配置下都能用。
18. 作为移动开发者，我想区分「缺元素/多元素/位置尺寸/颜色/文案/资源」这类差异，以便对症下药。
19. 作为 AI agent，我想读取结构化差异报告与映射条目，以便自动生成修复方案并再次验证。
20. 作为 AI agent，我想把差异报告作为失败反馈的一部分（含证据路径），以便在任务失败后给出可执行的修复建议。
21. 作为测试工程师，我想用合成图的 golden 回归验证判定稳定，以便不依赖设备与网络。
22. 作为测试工程师，我想保留一对真实设备/设计的离线基准，以便校验真实 DPI 与系统栏场景。
23. 作为移动开发者，我想大图自动降采样且不丢区域坐标，以便长截图/高分辨率设备下仍能对比。
24. 作为移动开发者，我想对比失败时不留下半成品产物，以便目录干净。
25. 作为移动开发者，我想报告记录本次对齐参数（scale/offset/insets）与耗时，以便复现同一次判定。
26. 作为移动开发者，我想屏蔽指定区域（状态栏/视频位/轮播/时钟），以便动态内容不会淹没真实差异。
27. 作为移动开发者，我想贴边差异被标注为「可能由系统安全区域导致」并降级，以便不把安全区偏移当实现 Bug 修。
28. 作为移动开发者，我想降采样上限有明确默认值且可配，以便性能与抗噪可预期。

### Implementation Decisions

- **工具形态**：新增原生工具 `design_device_diff` 与 `screen_map`；现有 `compare_design_and_device` 保持不变（向后兼容）。两者都用 zod schema，符合原生工具约定。
- **设计渲染源抽象**：统一「设计渲染源」接口（输入屏幕/节点标识，输出位图 + 设计侧节点几何 + 名称）。v1 实现两源：Figma（REST 导出 PNG@2x + 节点树几何/文本）与 `.pen`（经 `pen_export` 渲染 + 解析文件节点几何）。`.pen` 渲染缺 CLI/未登录时复用既有错误分类与提示。
- **设备采集**：两种模式——`live`（经 `runtime.proxy.callTool("mobile_get_device_state")` 取实时截图）与 `step`（显式 `trace_id + step_number`，经 `mobile_inspect_trace(action="view_step_screenshots")` 取图，默认用 post，允许选 pre）。自动锚点模式：仅给 `trace_id` 时，用失败证据文本经 `mobile_inspect_trace(action="search")` 找回步骤；报告记录锚点来源（`explicit` / `search`）；Flash 任务无 `run_outcome`，自动模式返回明确说明而非静默失败（见 ADR-0003）。
- **差异计算落点**：AOS TypeScript 纯 JS 图像栈（`pngjs` 解设计图、`jpeg-js` 解真机 JPEG、`pixelmatch` 比对；见 ADR-0002）。不新增 Python 通道、不直读上游 SQLite。
- **对齐与降采样**：以设计宽度缩放 + 顶部对齐为默认锚点；`insets`（top/right/bottom/left，px）显式修正；不自动检测系统栏（后置）。对齐记录（scale/offset/insets/downsampledTo）写入报告；大图先降采样到**默认最长边 1440px（可配）**，区域坐标按比例还原。
- **区域屏蔽与抗噪**：`ignoreRegions`（bbox 数组）在判定前屏蔽指定区域（状态栏、视频位、轮播、时钟等动态内容），并在报告中记录 `ignoredRegions`。真机截图为**有损 JPEG**（上游固定编码）：平坦区噪声由 pixelmatch 阈值吸收（默认 0.1，可配），边缘噪声由降采样 + 最小区域面积（0.5%）+ 聚类间距抑制；阈值最终由票据 07 的真实基准校准，不提前拍高。
- **判定与分类**（见 ADR-0001）：像素差异产生候选区域（pixelmatch 阈值、最小面积占比、聚类间距、区域数上限，均可配且默认 0.1 / 0.5% / 8px / 20）；用设计侧节点几何把候选归入类别 `missing | extra | position-size | color | text | asset`，并映射严重度 `blocker | major | minor | info`（主内容缺失/多余 ≥ major；文本区域差异 major；小面积颜色差异 minor）。输出按「严重度 → 面积 → 坐标」排序，保证确定性。
- **差异报告形状**（决定性的类型轮廓，供实现与回归对齐）：

```ts
interface DiffReport {
  schemaVersion: 1;
  unit: { design: { source: "figma" | "pen"; nodeId?: string; name?: string }; device: { mode: "live" | "step"; traceId?: string; stepNumber?: number; image: "post" | "pre"; serial?: string } };
  alignment: { scale: number; offset: { x: number; y: number }; insets: { top: number; right: number; bottom: number; left: number }; downsampledTo?: number };
  ignoredRegions: Array<{ x: number; y: number; width: number; height: number }>;
  regions: Array<{ bbox: { x: number; y: number; width: number; height: number }; category: string; severity: string; pixelDiffRatio: number; designNode?: { id: string; name: string }; suspected?: "system-area"; localized?: { mapEntry?: object; status: "mapped" | "unmapped" | "no-candidates" } }>;
  summary: { regions: number; bySeverity: Record<string, number>; byCategory: Record<string, number> };
  elapsedMs: number;
}
```

- **产物落盘**：`<design>/diffs/<screen-slug>-<时间戳>/` 下写 `report.json`（含上结构）、`annotated.png`（差异框 + 编号）、`design.png`、`device.png`。工具响应返回摘要 JSON + 标注图（image block）+ 产物路径；原图不回传，避免 payload 膨胀。失败时不保留半成品目录。
- **定位**：读取持久 `screen-map.json`（schema 版本化；条目含设计侧屏幕/节点与实现侧 route/component/file）；命中则写入 `localized.mapEntry`，否则 `unmapped`，若存在 build-brief 则附候选。
- **`screen_map` 工具**：动作 `list` / `propose` / `save`。`propose` 基于 build-brief（组件清单、屏幕）与技术栈约定生成**粗粒度候选**（屏幕名→路由/文件命名、AOS scaffold 过的组件），带 `confidence` 与 `unmatched`，不承诺全覆盖——Figma 节点 id 与代码无天然映射，最终由调用 agent（可带 LLM 推理）复核后 `save`；`save` 显式写入（幂等，重复内容不写）。差异工具只读，不自动写映射（见 ADR-0004）。
- **解释层**：v1 不做内置 LLM 解释；报告与标注图即交付物（ADR-0001）。
- **触发**：v1 仅手动调用；失败任务自动触发与全终态自动触发后置。
- **错误与提示**：复用既有分类——Figma token 缺失、`.pen`/CLI 未登录、无 trace/步骤、无映射；所有错误给出下一步操作提示。

### Testing Decisions

- **只测外部行为**：断言「输入图像/选项 → 报告内容/产物文件」；不测内部实现细节（不绑定具体算法步数或私有函数）。
- **主测试面是纯 diff 引擎 seam**（唯一新增 seam）：合成设计 PNG 与真机 JPEG，注入已知差异（缺块、位移、变色、文本变化、多余元素），断言区域类别、严重度、bbox 容差与报告确定性（同输入两次运行报告逐字节一致）。
- **工具层复用既有 seam**：temp project + `makeTempProject` / StubProxy（设备截图返回 fixture 路径）、全局 fetch stub（Figma REST）、假 `pen` CLI exec（`.pen` 渲染）、文件系统断言产物落盘与失败清理。
- **`screen_map` 工具**：propose/save 在 temp project 上跑，断言候选项、显式保存、幂等与只读行为。
- **验收指标**：合成用例的区域召回与类别命中；报告 schema 快照；真实设备/设计基准 fixture 离线跑一次（不要求 CI 联网/连设备）。
- **先例**：`test/composite.test.js`（取图与路径解析、token 引导）、`test/pen-cli.test.js`（假 exec + 原子写 + 回滚）、`test/import-tokens.test.js`（幂等）、`test/figma.test.js`（fetch stub）。
- 测试不依赖真实 PG / 设备 / 外网 / Python。

### Out of Scope

- LLM 参与判定或内置修复建议（ADR-0001；解释交给调用方 agent）。
- 自动触发（任务终态自动 diff、CI 门禁）。
- Flash 任务的自动步骤锚点（无 `run_outcome`）。
- 多步骤/流程级序列对比与视频/录屏差异。
- 系统栏自动检测（向上游建议暴露 `status_bar_height` 后再评估）。
- 特征锚点（中心点）对齐：v1 用 insets + `ignoreRegions` + 贴边 `suspected` 标注兜底；后续评估（live 可用 hierarchy，step 只有图片）。
- 上游 `run_outcome.failed_items` 增加步骤锚点，以及 Flash 任务在 trace 顶层暴露「最后一步截图」字段（backlog；「最后一步」≠ 失败步骤）。
- 非 Android 设备的采集路径（仍经 ARTEMIS）。

### Further Notes

- 术语一律使用 `CONTEXT.md`；相关 ADR：0001-0004。
- `run_outcome` 仅 Pro 任务存在；自动锚点属 best-effort，报告需带锚点来源。
- 视觉判定不依赖 active LLM 的多模态能力；当前 active LLM 为 DeepSeek（非多模态）也应完整可用。
- 真机截图（live 与 step）都是**有损 JPEG**（上游 `_pil_to_base64(..., "JPEG")` 固定编码）；抗噪参数由票据 07 用真实基准校准，不凭经验拍值。

---

## 6. 票据（Tickets）

### 01 — Figma × 实时截图 最小闭环

**What to build:** 用户用一条命令把 Figma 设计节点与真机当前截图对比：工具完成取图、默认对齐（设计宽度缩放 + 顶部对齐）、像素差异判定，产出确定性的差异报告与标注图（差异框选），并落盘到项目 `.artemis/design/diffs/<screen>-<时间戳>/`（report.json / annotated.png / design.png / device.png）。支持 `dryRun` 只回计划；失败不留半成品。

**Blocked by:** None — can start immediately.

- [x] 新增图像依赖（纯 JS：PNG 解码、JPEG 解码、像素比对），无原生编译、无网络
- [x] 纯 diff 引擎：输入两张已解码位图 + 选项，输出稳定 DiffReport（对齐记录、区域、汇总、耗时）；同输入两次运行报告逐字节一致
- [x] 对齐默认：设计宽度缩放 + 顶部对齐；大图降采样到默认最长边 1440px（可配）且区域坐标按比例还原
- [x] `ignoreRegions`（bbox 数组）：判定前屏蔽指定区域，报告中记录 `ignoredRegions`
- [x] 抗噪底线：平坦区（无差异内容）在有损 JPEG 下不产生误报区域（阈值/最小面积/聚类默认参数由合成噪声用例覆盖）
- [x] 新原生工具最小 schema：设计源 `figma`（URL + 可选 nodeId），设备源 `live`（可选 serial），`save`/`dryRun`
- [x] 设备截图经既有代理通路获取；设计渲染经 Figma REST 获取，token 缺失时给既有引导提示
- [x] 响应返回摘要 JSON + 标注图（image block）+ 产物路径；原图只落盘不回传
- [x] 测试：引擎合成 golden（已知差异 → 区域/bbox 容差/确定性）；工具层 temp project + StubProxy + fetch stub；失败清理与 dryRun
- [x] 与现有 `compare_design_and_device` 完全并存，契约测试不回归

### 02 — 步骤截图（显式 trace_id + step_number）

**What to build:** 用户指定 `trace_id + step_number`，工具用该步骤的截图作为真机侧对比图（默认 post，可切 pre），而不是实时截图；截图路径经上游 `mobile_inspect_trace(view_step_screenshots)` 获取。缺 trace/步骤、步骤无图时给出明确错误与提示。

**Blocked by:** 01（Figma × 实时截图 最小闭环）

- [ ] 设备源新增 `step` 模式：`trace_id` + `step_number` 必填，`image: "post" | "pre"`（默认 post）
- [ ] 通过上游代理工具取步骤截图路径并读取文件；不直读上游数据库/内部文件布局
- [ ] 报告 `unit.device` 记录 `mode/traceId/stepNumber/image/serial`
- [ ] 错误路径：trace 不存在、步骤越界、截图缺失、upstream 报错，均结构化返回并附下一步提示
- [ ] 测试：StubProxy 返回步骤截图路径的 fixture；错误分支；报告字段断言

### 03 — 差异分类与严重度 + 阈值参数

**What to build:** 差异区域不再只有像素差异：用设计侧节点几何（设计树的 bbox/文本/名称）把每个候选区域归入 `missing / extra / position-size / color / text / asset`，并映射严重度 `blocker / major / minor / info`（主内容缺失/多余 ≥ major，文本区域差异 major，小面积颜色差异 minor）。判定阈值全部可配：像素阈值、最小区域面积、聚类间距、区域数上限（默认 0.1 / 0.5% / 8px / 20）。输出按「严重度 → 面积 → 坐标」排序。

**Blocked by:** 01（Figma × 实时截图 最小闭环）

- [ ] 设计侧几何进入引擎：每个区域可携带设计节点引用（id/name）
- [ ] 类别判定规则与严重度映射按上述默认实现，且不依赖真机侧结构数据
- [ ] 工具参数暴露阈值（缺省用默认值），报告记录实际使用的阈值
- [ ] 落在系统边缘条带、且无对应设计节点的区域标 `suspected: "system-area"`，严重度压到 `info`
- [ ] 汇总 `byCategory` / `bySeverity` 正确且稳定排序
- [ ] 测试：合成用例覆盖每一类别与严重度（缺块、位移、变色、文本变化、多余元素）

### 04 — 自动锚点（trace_id → 失败步骤，best-effort）

**What to build:** 用户只给 `trace_id` 时，工具用失败证据文本（来自 Pro 任务终态 `run_outcome`）经上游 `mobile_inspect_trace(search)` 找回候选步骤并选取锚点，报告记录锚点来源（`explicit` / `search`）与候选信息。Flash 任务（无 `run_outcome`）或找不到失败证据时，明确说明并建议显式 `step_number`，不静默失败。

**Blocked by:** 02（步骤截图（显式 trace_id + step_number））

- [ ] 设备源支持仅 `trace_id`：先读取/获取失败证据，再检索步骤，取回截图
- [ ] 报告记录锚点来源与命中依据（证据文本/步骤号），便于复核
- [ ] 无失败证据（Flash）→ 结构化提示，可用显式步骤替代
- [ ] 检索零命中/多命中歧义 → 返回候选列表与建议
- [ ] 测试：StubProxy 模拟 run_outcome/检索结果的三类分支（命中、无记录、歧义）

### 05 — `.pen` 设计源

**What to build:** 设计源新增 `.pen`：经 pen CLI 渲染出位图（复用 `pen_export` 的定位/登录/超时/失败分类），并从 `.pen` 解析节点几何供分类使用；用户可以不依赖 Figma 完成同一条对比闭环。

**Blocked by:** 01（Figma × 实时截图 最小闭环）

- [ ] 设计源参数支持 `.pen` 路径（缺省取项目内最新文件，与既有 pen 工具一致）
- [ ] 渲染复用既有 CLI 通路（可注入假 exec 供测试），未安装/未登录/超时错误分类一致
- [ ] 报告 `unit.design.source = "pen"`，并携带设计节点（屏幕/组件）名称与几何
- [ ] 渲染产物路径可配置，默认落既有 pen 导出目录
- [ ] 测试：假 CLI exec 产出 fixture 图 + `.pen` fixture；错误分支

### 06 — `screen_map` 工具 + 报告定位

**What to build:** 新增 `screen_map` 工具（`list` / `propose` / `save`）维护持久屏幕映射 `screen-map.json`（设计屏幕/组件 ↔ 路由、组件、文件；schema 版本化）；`propose` 基于 build-brief 与栈约定生成候选，`save` 显式幂等写入，差异工具只读。差异报告为每个区域写入 `localized`：命中映射则带条目，否则 `unmapped` 并给候选；无 build-brief 时说明原因。

**Blocked by:** 03（差异分类与严重度 + 阈值参数）、01（Figma × 实时截图 最小闭环）

- [ ] `screen_map` list：读取并返回映射与 schema 版本；文件缺失返回空表与提示
- [ ] `screen_map` propose：粗粒度候选（带 `confidence` 与 `unmatched`，不承诺全覆盖；Figma 节点 id 与代码无天然映射），由 agent 复核后 save
- [ ] `screen_map` save：显式写入、幂等（重复内容不写）、非法输入报错
- [ ] 差异报告 `localized` 字段：`mapped`（含条目）/ `unmapped`（含候选或原因）
- [ ] 测试：temp project 上 propose/save/幂等/只读；报告定位字段断言

### 07 — 真实基准 fixture 与验收指标

**What to build:** 一对真实设备截图与设计渲染的离线基准 fixture（含状态栏/DPI 场景），用于校准对齐与分类；测试输出量化指标（区域召回、类别命中）并断言不低于约定阈值；文档记录基准来源、已知偏差与复现方式。全部离线，不依赖设备/网络。

**Blocked by:** 03（差异分类与严重度 + 阈值参数）

- [ ] 基准 fixture 入库（设计图 + 真机图 + 期望差异清单），来源与参数记录在测试旁
- [ ] 指标测试：区域召回与类别命中达到约定阈值，失败时输出可读的对比明细
- [ ] 抗噪基准：无差异内容经低质量 JPEG 重编码后不产生误报区域（平坦区误报上限），据此校准默认阈值
- [ ] 安全区/状态栏场景：`ignoreRegions` 生效、贴边差异按 `suspected: "system-area"` 降级
- [ ] 报告 schema 快照测试，防止无意破坏兼容
- [ ] 测试在无设备、无网络、无 Python 环境可跑

---

## 7. 下一步

- **Frontier**：票据 01（无阻塞，可立即开始）。
- 按流程每个 ticket 用干净上下文执行：`/implement .scratch/design-device-diff/issues/01-figma-live-minimal-loop.md`。
- 完成 01 后，02 与 03 解锁；04 依赖 02；05 依赖 01；06 依赖 01、03；07 依赖 03。
