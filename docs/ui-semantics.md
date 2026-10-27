# UI 语义一致性（ui-semantics / ui-parity）

> 面向“设计稿 vs 实现”的稳定结构检查：把分类树、标签、角色、覆盖率与动态商品/价格/图片分开。全部 additive；项目不建 `ui-semantics.json` 时行为不变。

## 1. 坐标空间（先看这张表）

| 空间 | 字段/入口 | 单位/锚点 | 受 `designCrop` 影响 | 受缩放影响 | 校验阶段 |
|---|---|---|---|---|---|
| design-source | `semantics.designBbox`、`alignment.designCrop` | 设计原图像素，左上角 (0,0) | 否（use-time 再减 crop 原点） | 是（引擎 downsample factor） | `design_device_diff` use-time |
| cropped-design | `alignment.ignoreRegions`、`dynamicIgnoreRegions` | 裁剪后设计图像素，左上角 (0,0) | 是 | 引擎内部再乘 factor | `design_device_diff` |
| device-viewport | `semantics.deviceBbox`、`space:"viewport"` 的 `UiRuntimeText` | 设备截图像素；同一 viewport 内有效 | 否 | 否 | `ui-parity` role/truncation |
| device-content | trace `run.json` 的 `texts[].x/y/width/height`、`space:"content"` | 设备逻辑内容坐标；可超出视口（y 可到数千） | 否 | 乘 `scale` → 设备像素 | `ui-parity` trace adapter |
| visual-text | `--visual-text` / snapshot 的 `source:"visual"` | 视口截图像素；OCR/人工标注 | 是（按当前 viewport） | 否 | `ui-parity` 截断/资产 |
| output-regions | `DiffResult.regions[].bbox` | 设计工作区坐标（引擎口径） | 是 | 是 | `design_device_diff` |

规则：

- trace AX 的 `texts[]` **不是**视口文本；adapter 标 `space:"content"`，按截图视口算 `visible/offscreen`，不能把 content y 当 viewport y。
- 单视口只覆盖部分 invariant → `insufficient-coverage`；`visible + unverified + offscreen == invariant`。
- AX 完整文本（`每日精選咖啡`）不能证明“未截断”；截断结论只来自 `source:"visual"`。
- Figma 的 `Flow/Header`、`Flow/Remarks`、系统栏是 chrome/annotation，不进入 crop/diff。

## 2. 文件与 schema

默认路径：`.artemis/design/ui-semantics.json`；`--semantics` 可覆盖。`version` 只接受 `1`；任一字段错误 → 整个文件 `file:null`（fail-closed），错误带 `screens[i]/regions[j]/taxonomy[k]` 定位。

```json
{
  "version": 1,
  "draft": true,
  "source": { "contract": ".artemis/design/ui-contract.json", "contractFingerprint": "…" },
  "screens": [
    {
      "screenId": "home",
      "screenName": "首頁",
      "viewport": { "width": 440, "height": 956, "scale": 3 },
      "displayNames": { "咖啡飲品": ["每日精選咖啡"] },
      "regions": [
        {
          "id": "category-rail",
          "role": "category-list",
          "designBbox": { "x": 0, "y": 1128, "width": 80, "height": 960 },
          "allowedRoles": ["category-list", "group-header"],
          "taxonomy": [
            {
              "id": "drinks",
              "label": "飲料",
              "kind": "group-header",
              "children": [
                {
                  "id": "coffee",
                  "label": "咖啡飲品",
                  "kind": "category",
                  "aliases": ["每日精選咖啡", "熱濃縮咖啡飲料", "冰濃縮咖啡飲料"]
                }
              ]
            },
            { "id": "recommended", "label": "推薦", "kind": "virtual", "allowDuplicates": true }
          ]
        },
        {
          "id": "product-list",
          "role": "product-list",
          "isDynamic": true,
          "dynamicAssets": true,
          "expectedAssets": 1,
          "dynamicExamples": ["冰蘋果山茶花風味美式", "$120 起"],
          "dynamicPatterns": ["\\$[0-9]+(?:\\.[0-9]+)?(?:\\s*起)?"]
        }
      ]
    }
  ]
}
```

字段要点：

- `taxonomy`：`category`/`group-header`/`virtual`；`group-header` 非交互，`virtual` 允许重复商品/自定义名称；`aliases` 是运行时叶子到设计顶层的多对一映射。
- `invariantTexts`：平文本 invariant；与 `taxonomy` 二选一或互补，同一文本不重复计数。
- `displayNames`：设计稳定文本 → 运行时别名；分类栏优先用 `taxonomy[].aliases`。
- `isDynamic` / `dynamicAssets`：像素/数据可变；**不等于忽略**。`expectedAssets` 由 `suite ui-parity` 检查存在性/placeholder；`design_device_diff` 只拒绝把声明 `expectedAssets` 的 region 整块忽略，不内置资产检测。
- `allowedRoles` / `allowDuplicates` / `expectedOccurrences`：同一文本多角色/重复出现（如 `推薦` 同时是 rail、section header、card tag）。
- `dynamicExamples` / `dynamicPatterns`：`suite check` 扫描已知样例/格式；非穷尽，新动态值需 owner 更新。

## 3. 怎么用

### 3.1 生成 draft 骨架

```bash
mobile-testing-mcp suite ui-semantics init \
  [--contract .artemis/design/ui-contract.json] \
  [--out .artemis/design/ui-semantics.json] \
  [--force] [--json]
```

- 只生成 `screens[].screenId/screenName/regions:[]`，`draft:true`；不自动写 invariant/bbox/taxonomy。
- 已有文件且无 `--force` → exit 2；`--force` 覆盖并保留 `.bak`。
- draft/空屏只会 `no-invariants`，不会假绿；owner 填完 invariant/taxonomy 后去掉 `draft`。

### 3.2 跑一致性审计

```bash
# 视口快照（device-pixels）
mobile-testing-mcp suite ui-parity --snapshot .artemis/design/snapshot.json --json

# trace 步骤（AX content-space；只做文本/分类树，截断需 visual-text）
mobile-testing-mcp suite ui-parity --trace <traceId> --step 8 --region category-rail --json

# 视觉文本覆盖（OCR/人工标注）
mobile-testing-mcp suite ui-parity --snapshot snapshot.json --visual-text visual.json --json
```

快照格式：

```json
{
  "screen": "home",
  "viewport": { "width": 440, "height": 956, "scale": 3 },
  "space": "viewport",
  "texts": [{ "text": "推薦", "x": 0, "y": 0, "width": 80, "height": 20 }],
  "assets": [{ "kind": "image", "present": true, "placeholder": false }]
}
```

`--visual-text` 格式：`{ "texts": [{ "text": "每...咖啡", "x": 0, "y": 200, "width": 80, "height": 20 }] }`；有它时视觉文本作为文本源。

### 3.3 判定与退出码

| verdict | 含义 | exit |
|---|---|---|
| `layout-compatible` | 结构/标签一致，覆盖率完整 | 0 |
| `data-diff` | 仅动态样例/值不同 | 0 |
| `truncated-labels` | 视觉截断（需 `source:"visual"`） | 1 |
| `ia-mismatch` | 分类树/缺失/角色/资产问题 | 1 |
| `insufficient-coverage` | 半屏/未验证，不能给绿 | 1 |
| `no-invariants` | 已声明语义但零 invariant | 1 |
| `insufficient-data` | 缺语义文件/无法校验 | 2 |

`counts` 关键恒等式：

- `invariant = matched + missing + truncated + unverified + offscreen`
- `visible = matched + missing + truncated`

`--region <id>` 只审计指定 region（推荐分类栏），避免拿整屏 300 条文本做 unexpected。

### 3.4 基线（增量治理）

```bash
# 先 warn 跑全量，owner 审阅后固化
mobile-testing-mcp suite ui-parity --snapshot snapshot.json --update-baseline --json
# 之后只阻断新 key
mobile-testing-mcp suite ui-parity --snapshot snapshot.json --baseline .artemis/design/ui-parity-baseline.json --json
```

- 只抑制已登记 `tool|screen|kind|text|role` key；新 finding 不被吞。
- `--update-baseline` 替换整个文件为当前快照；不自动清理旧 key（owner 显式更新）。
- `ui-parity` 与 `check` 默认使用两个文件：`ui-parity-baseline.json` / `ui-dynamic-baseline.json`。

### 3.5 设计裁剪与动态区域

```jsonc
{
  "design": { "source": "image", "imagePath": ".artemis/design/screens/home.png" },
  "alignment": {
    "designCrop": { "x": 0, "y": 600, "width": 390, "height": 400 },
    "ignoreRegions": [{ "x": 0, "y": 100, "width": 390, "height": 300 }]
  },
  "ui": { "screenId": "home", "ignoreDynamicRegions": true, "expectedAssets": true }
}
```

- `designCrop` 是 design-source 像素；越界/0 宽高/非有限 → 错误且不写产物。
- 裁剪后节点坐标平移；`ignoreRegions` 按 cropped-design 传入。
- `ignoreDynamicRegions` 只忽略 `isDynamic || dynamicAssets` 且含 `designBbox` 的 region；无 bbox/完全在 crop 外 → warning。
- `expectedAssets:true` 时不忽略有 `expectedAssets` 的动态区，提示用 `ui-parity` 检查存在性；Hero 空白/商品图 fallback 不得被吞。**本工具不内置 presence/placeholder 检测**，这一步必须在 `ui-parity` 的 assets 输入里完成。
- Figma chrome/annotation（`Flow/Header`/`Flow/Remarks`/状态栏）**不会自动识别**；调用方用 `designCrop` 把它们裁掉（或在设计源渲染前排除）。

## 4. `suite check` 动态断言

```bash
mobile-testing-mcp suite check [--fail-on-dynamic] \
  [--dynamic-baseline .artemis/design/ui-dynamic-baseline.json] \
  [--update-dynamic-baseline] [--semantics <path>] [--json]
```

- 扫描每条 tests 的 `taskDesc` 与 `steps`，命中 `dynamicExamples`/`dynamicPatterns` 记入 `dynamicContent`。
- 默认 warning、exit 0；`--fail-on-dynamic` 对 fresh 命中 exit 2。
- 只匹配已登记词表，**非穷尽**；新运行时商品/价格需 owner 更新。
- 基线 key = `caseId|text`；`--update-dynamic-baseline` 替换为当前快照。

## 5. 真实 fixture 与 rollout

- 首个真实 fixture：原版 Figma `Mobile ordering-Landing page`（375×2088）→ 17 项分类树 + 2 个 group header + `選擇門市`/`選擇取餐時間` + section header + 底部 tab。
- 真实菜单案例：alias 归一后 `taxonomyMatched=13/17`、missing 4（`飲料`/`餐點`/`調理咖啡`/`包裝食品`）；带 region bbox 的视口快照还能看到 unexpected 6（`氮氣冷萃咖啡`/`咖啡豆`/`VIA`/`掛耳式咖啡`/`零食點心`/`禮盒`）。纯 trace AX 无 bbox 时按“不臆造 unexpected”只报 missing；verdict 仍是 `ia-mismatch`，不是 `truncated-labels`。
- 进 CI 前：先用默认 warn 跑全量，记录命中分布；再 `--update-*-baseline` 固化历史，最后开 `--fail-on-dynamic` / `ui-parity` 基线。不要直接把历史噪声变成红灯。
- 像素绿 ≠ 结构绿：动态 region 内稳定子元素（标题/标签/按钮）由文本 parity invariant 兜底；Hero/商品图另做 presence 检查。

## 6. 非目标

- 不自动改应用代码、不自动判断 API/页面是否存在、不自动修复分类截断。
- Phase 1 不做 OCR/视觉角色推断；视觉文本由 `--visual-text`/人工 snapshot 提供（OCR adapter 后续）。
- 不把没有语义文件的旧项目判失败；不自动生成 owner/日期例外。
- 不替代像素 diff：`design_device_diff` 负责视口像素/资产，`ui-parity` 负责结构/分类树/覆盖率。
