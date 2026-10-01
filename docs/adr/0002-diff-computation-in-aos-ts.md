# 差异计算落在 AOS TypeScript 侧

像素级差异比较在 AOS（TypeScript）进程内完成，采用纯 JS 图像栈：`pngjs`（设计渲染图解码）、`jpeg-js`（真机截图解码，ARTEMIS 截图固定为 JPEG）、`pixelmatch`（像素对比）。ARTEMIS 的结构信号（UI hierarchy/OCR）继续通过既有 MCP 工具获取，不新增子模块脚本通道、不直连 Python venv。

## Considered Options

- 复用 ARTEMIS Python（pillow/opencv 已就绪）：零新依赖，但需要跨子模块新增调用通道，测试与 CI 会绑定 venv，拒绝。
- 服务端不做像素计算（仅结构信号）：无法稳定产出差异区域与证据，拒绝。

## Consequences

- 新增三个小体积运行时依赖（无原生编译）；大图需先降采样；
- 差异引擎可在无设备、无网络、无 Python 的测试环境里跑 golden 回归。
