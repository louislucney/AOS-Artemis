# 资源校准 POC（只读对账表）

> 目的：在进入产品代码前，用最小的 RN / Flutter fixture 验证“设计 ↔ 代码 ↔ 设备”三层资源对账模型。
> 本目录**不进入** `src/`、不新增 MCP 工具、不写项目 `.artemis/`；`poc.mjs` 只读 fixture 并打印结果。

## 运行

```bash
npm run build   # poc 使用 dist/projects/stack.js 的检测证据
node .scratch/resource-calibration-poc/poc.mjs
```

fixture 的 PNG 可用以下命令重建（不是对账步骤）：

```bash
node .scratch/resource-calibration-poc/generate-fixtures.mjs
```

## 输入

```text
design/contract.json                 设计侧：逻辑尺寸、fit、字体/字号/行高/字重/字距/maxLines
fixtures/react-native/               RN 0.78 fixture（package.json、theme、screen、@2x/@3x、device.json）
fixtures/flutter/                    Flutter fixture（pubspec、theme、screen、2.0x/3.0x、字体声明、device.json）
```

`device.json` 是 POC 的设备上下文，不是产品 schema：

```json
{ "nativeUnit": "pt", "pixelRatio": 3, "fontScale": 1.3 }
```

## 对账规则

### 图片

- 设计侧是 `design-px @1x`；代码声明逻辑宽高；设备按 `pixelRatio` 选变体。
- RN：`avatar.png` / `avatar@2x.png` / `avatar@3x.png`；`ImageSource.scale` 默认 1.0。
- Flutter：`avatar.png` / `2.0x/avatar.png` / `3.0x/avatar.png`；主资源按 1.0，`AssetImage` 按 `devicePixelRatio` 选择。
- 比较的是 `px / scale = 逻辑尺寸`，不是文件字节或原始像素尺寸。
- `fit` 按各自枚举归一：RN `resizeMode`、Flutter `BoxFit`。
- 设备需要的最高倍率没有对应变体 → `upscale`，不假装 match。

### 文字

- 字号、字距在设计/RN/Flutter 都是逻辑单位。
- 行高表示不同：
  - RN `lineHeight` 是绝对值（基线间距）；
  - Flutter `height` 是 `fontSize` 的倍数。
  - POC 先换算成逻辑行高再比较。
- 字重先比声明值；Flutter 还要检查 `pubspec.yaml` 的字体 family/weight 是否真的存在。缺失 → `font-weight-substituted`。
- `fontScale/textScaler` 不混进“设计 vs 代码”结论；设备侧单独标 `text-scale`，避免把系统字体放大误报成代码错误。
- `maxLines` 与设计不一致 → `mismatch`，不归因成字体问题。

### 状态

| 状态 | 含义 |
|---|---|
| `match` | 逻辑值/语义一致 |
| `mismatch` | 尺寸、fit、字号、行高、字距、字重、maxLines 或文案不一致 |
| `upscale` | 设备倍率高于现有最高变体（会放大） |
| `font-weight-substituted` | 代码声明了字重，但字体文件没有该字重 |
| `font-unbundled` | 字体 family 未在代码中声明 |
| `unmapped` | 设计资源找不到对应代码 |
| `unverifiable` | 缺行高/字体度量等，无法确认 |

## 当前输出（节选）

```text
KIND   RESOURCE                DESIGN                  CODE                                      STATUS                        DEVICE
image  react-native/avatar     72x72 cover             RN 72x72 cover (Home.tsx:8)               match                         pt @3x
image  react-native/hero       343x160 cover           RN 343x160 contain (Home.tsx:9)           mismatch                      pt @3x
image  react-native/banner     343x120 cover           RN 343x120 cover (Home.tsx:10)            upscale                       pt @3x
text   react-native/pickup     14/20 w600              RN 14/20 w600                             match                         text-scale 1.3 (18.2pt)
text   react-native/title      20/28 w700              RN 20/24 w700                             mismatch                      text-scale 1.3 (26pt)
text   flutter/title           20/28 w700              Flutter 20/28 (height 1.4) w700           font-weight-substituted       normal
text   flutter/body            14/20 w400              Flutter 14/16.8 (height 1.2) w400         mismatch                      normal
```

## 这版 POC 刻意没做什么

- 解析器是 fixture 级正则，不是完整 TS/Dart AST；只用于验证模型与状态语义。
- 字体文件是占位文件，只验证 `pubspec.yaml` 声明与文件存在，不解析真实字重表。
- RN 没有 `pubspec` 式字体声明，POC 只标 `font-weight-unverified`，不假装确认。
- 没有接真实设备；`device.json` 是手写的设备上下文。
- 没有写回 `ui-contract` / `design_to_test`；等模型确认后再决定产品切片。
