# 设计 vs 真机差异：可反馈、可定位

Status: ready-for-agent

## Problem Statement

移动开发者用 ARTEMIS 在真机上跑完端到端任务后，无法可靠地知道「真机显示与设计稿是否有明显差异、差异在哪、该改哪里」。现有 `compare_design_and_device` 只把设计渲染图与**实时**截图并排返回，交给多模态人眼看：失败那一步的截图取不到，差异没有区域/类型/严重度，报告不落盘不可复现，代码定位全靠猜。结果是视觉回归依赖人工、失败反馈断链、修复成本高。

## Solution

新增两个原生工具：

- `design_device_diff`：把「设计渲染」与「真机截图」作为一次**对比单元**，做确定性对齐与像素差异判定，产出结构化**差异报告**（类型/区域/严重度/证据）与标注图，落盘到项目 `.artemis/design/diffs/`。设备侧优先使用**步骤截图**（trace 的失败步骤），也支持实时截图；设计侧支持 Figma 与 `.pen`。
- `screen_map`：维护持久**屏幕映射** `screen-map.json`（设计屏幕/组件 ↔ 路由/组件/文件），让差异报告完成实现侧**定位**；未映射时标记 `unmapped` 并给候选，不猜测。

差异的**解释与修复建议**不在工具内做：工具给足结构化证据与标注图，由调用方的多模态 agent 完成（判定与解释分离）。

## User Stories

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

## Implementation Decisions

- **工具形态**：新增原生工具 `design_device_diff` 与 `screen_map`；现有 `compare_design_and_device` 保持不变（向后兼容）。两者都用 zod schema，符合原生工具约定。
- **设计渲染源抽象**：统一「设计渲染源」接口（输入屏幕/节点标识，输出位图 + 设计侧节点几何 + 名称）。v1 实现两源：Figma（REST 导出 1× + 节点树几何/文本；`compare_design_and_device` 仍为 2×）与 `.pen`（经 `pen_export` 渲染 1× + 解析文件节点几何）。`.pen` 渲染缺 CLI/未登录时复用既有错误分类与提示。
- **设备采集**：两种模式——`live`（经 `runtime.proxy.callTool("mobile_get_device_state")` 取实时截图）与 `step`（显式 `trace_id + step_number`，经 `mobile_inspect_trace(action="view_step_screenshots")` 取图，默认用 post，允许选 pre）。自动锚点模式：仅给 `trace_id` 时，用失败证据文本经 `mobile_inspect_trace(action="search")` 找回步骤；报告记录锚点来源（`explicit` / `search`）；Flash 任务无 `run_outcome`，自动模式返回明确说明而非静默失败（见 ADR-0003）。
- **差异计算落点**：AOS TypeScript 纯 JS 图像栈（`pngjs` 解设计图、`jpeg-js` 解真机 JPEG、`pixelmatch` 比对；见 ADR-0002）。不新增 Python 通道、不直读上游 SQLite。
- **对齐与降采样**：以设计宽度缩放 + 顶部对齐为默认锚点；`insets`（top/right/bottom/left，px）显式修正；不自动检测系统栏（后置）。对齐记录（scale/offset/insets/downsampledTo）写入报告；降采样按**设计图最长边**判定（默认 1440px 可配，设备图直接缩放到设计宽度，不参与触发），区域坐标按比例还原；`scale` 为设备像素 → 工作（设计）坐标系比例。
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

> 实现补充（票据 03–06，`schemaVersion` 保持 1，均为增量字段）：报告顶层增 `designScreens`（顶层屏幕名称/几何，≤10）、`thresholds`（实际生效的 8 项阈值）、`warnings`、仅自动锚点时出现的 `anchor{source,query,candidates,ambiguous}`；region 增 `suspected:"system-area"` 与 `localized{status,mapEntry?,candidates?,reason?}`；`unit.device.image` 仅 step 模式出现（live 模式省略）。

- **产物落盘**：`<design>/diffs/<screen-slug>-<时间戳>/` 下写 `report.json`（含上结构）、`annotated.png`（差异框 + 编号）、`design.png`、`device.png`。工具响应返回摘要 JSON + 标注图（image block）+ 产物路径；原图不回传，避免 payload 膨胀。失败时不保留半成品目录。
- **定位**：读取持久 `screen-map.json`（schema 版本化；条目含设计侧屏幕/节点与实现侧 route/component/file）；命中则写入 `localized.mapEntry`，否则 `unmapped`，若存在 build-brief 则附候选。
- **`screen_map` 工具**：动作 `list` / `propose` / `save`。`propose` 基于 build-brief（组件清单、屏幕）与技术栈约定生成**粗粒度候选**（屏幕名→路由/文件命名、AOS scaffold 过的组件），带 `confidence` 与 `unmatched`，不承诺全覆盖——Figma 节点 id 与代码无天然映射，最终由调用 agent（可带 LLM 推理）复核后 `save`；`save` 显式写入（幂等，重复内容不写）。差异工具只读，不自动写映射（见 ADR-0004）。
- **解释层**：v1 不做内置 LLM 解释；报告与标注图即交付物（ADR-0001）。
- **触发**：v1 仅手动调用；失败任务自动触发与全终态自动触发后置。
- **错误与提示**：复用既有分类——Figma token 缺失、`.pen`/CLI 未登录、无 trace/步骤、无映射；所有错误给出下一步操作提示。

## Testing Decisions

- **只测外部行为**：断言「输入图像/选项 → 报告内容/产物文件」；不测内部实现细节（不绑定具体算法步数或私有函数）。
- **主测试面是纯 diff 引擎 seam**（唯一新增 seam）：合成设计 PNG 与真机 JPEG，注入已知差异（缺块、位移、变色、文本变化、多余元素），断言区域类别、严重度、bbox 容差与报告确定性（同输入两次运行报告逐字节一致）。
- **工具层复用既有 seam**：temp project + `makeTempProject` / StubProxy（设备截图返回 fixture 路径）、全局 fetch stub（Figma REST）、假 `pen` CLI exec（`.pen` 渲染）、文件系统断言产物落盘与失败清理。
- **`screen_map` 工具**：propose/save 在 temp project 上跑，断言候选项、显式保存、幂等与只读行为。
- **验收指标**：合成用例的区域召回与类别命中；报告 schema 快照；真实设备/设计基准 fixture 离线跑一次（不要求 CI 联网/连设备）。
- **先例**：`test/composite.test.js`（取图与路径解析、token 引导）、`test/pen-cli.test.js`（假 exec + 原子写 + 回滚）、`test/import-tokens.test.js`（幂等）、`test/figma.test.js`（fetch stub）。
- 测试不依赖真实 PG / 设备 / 外网 / Python。

## Out of Scope

- LLM 参与判定或内置修复建议（ADR-0001；解释交给调用方 agent）。
- 自动触发（任务终态自动 diff、CI 门禁）。
- Flash 任务的自动步骤锚点（无 `run_outcome`）。
- 多步骤/流程级序列对比与视频/录屏差异。
- 系统栏自动检测（向上游建议暴露 `status_bar_height` 后再评估）。
- 特征锚点（中心点）对齐：v1 用 insets + `ignoreRegions` + 贴边 `suspected` 标注兜底；后续评估（live 可用 hierarchy，step 只有图片）。
- 上游 `run_outcome.failed_items` 增加步骤锚点，以及 Flash 任务在 trace 顶层暴露「最后一步截图」字段（backlog；「最后一步」≠ 失败步骤）。
- 非 Android 设备的采集路径（仍经 ARTEMIS）。

## Further Notes

- 术语一律使用 `CONTEXT.md`：设计渲染 / 真机截图 / 步骤截图 / 对比单元 / 对齐 / 差异判定 / 差异报告 / 定位 / 屏幕映射 / 差异分类 / 修复建议。
- 相关 ADR：0001 判定与解释分离；0002 差异计算落 AOS TS；0003 失败步骤经上游工具编排；0004 屏幕映射持久产物。
- `run_outcome` 仅 Pro 任务存在；自动锚点属 best-effort，报告需带锚点来源。
- 视觉判定不依赖 active LLM 的多模态能力；当前 active LLM 为 DeepSeek（非多模态）也应完整可用。
- 真机截图（live 与 step）都是**有损 JPEG**（上游 `_pil_to_base64(..., "JPEG")` 固定编码）；抗噪参数由票据 07 用真实基准校准，不凭经验拍值。
