import type { NativeToolDefinition } from "./types.js";
import { z } from "zod";
import { compareDesignAndDevice, type CompareArgs } from "../composite.js";
import { designDeviceDiff, type DesignDeviceDiffArgs } from "../../diff/tool.js";
import { screenMap, type ScreenMapArgs } from "../../diff/screen-map.js";
import { reconciliation, type ReconciliationArgs } from "../../figma/reconciliation.js";

/** 设计对比/映射 域原生工具（DESIGN §13.89）。 */
export const DESIGN_NATIVE_TOOLS: NativeToolDefinition[] = [
  {
    name: "compare_design_and_device",
    description:
      "组合工具：拉取 Figma 节点的渲染图（PNG@2x，REST）与当前真机截图，一并返回两张图片，供多模态模型比对布局/间距/颜色/文案。lossless=true 时真机侧改用 adb 无损 PNG 截图（避免 JPEG 伪影；失败自动回退 live JPEG）；platform=\"ios\" 时真机侧改走 macOS 模拟器（idb→simctl，需 deviceSerial 传 UDID 或唯一已启动模拟器）。",
    schema: z.object({
      figmaUrl: z.string().min(1).describe("Figma URL（建议带 ?node-id=）"),
      nodeId: z.string().optional().describe("覆盖 URL 中的 node-id"),
      deviceSerial: z.string().optional().describe("目标设备 serial（默认自动选择；平台 ios 时为模拟器 UDID）"),
      platform: z
        .enum(["android", "ios"])
        .optional()
        .describe("设备平台：android（默认，ARTEMIS/adb）| ios（仅 macOS 模拟器，经 idb/simctl 截图）"),
      lossless: z
        .boolean()
        .optional()
        .describe("真机侧无损 PNG（adb exec-out screencap -p）；失败回退 live JPEG，默认 false")
    }),
    handler: (runtime, args) => compareDesignAndDevice(runtime, args as unknown as CompareArgs)
  },
  {
    name: "design_device_diff",
    description:
      "设计 vs 真机差异：取设计渲染（Figma 节点 PNG@2x，或 `design:{source:\"pen\"}` 经 pen CLI 渲染 .pen）与真机截图（device.mode=live 实时截图，或 device.mode=step + traceId（stepNumber 可选：省略则用失败证据自动检索步骤）指定失败步骤截图，默认 post），做确定性对齐（设计宽度缩放 + 顶部对齐；insets/ignoreRegions/降采样可配）与像素差异判定，产出结构化差异报告（区域/严重度/证据）与标注图，默认落盘 <项目>/.artemis/design/diffs/<node>-<时间戳>/（report.json / annotated.png / design.png / device.png）；响应返回摘要 + 标注图 + 产物路径。dryRun 只回计划；判定不依赖 LLM。",
    schema: z.object({
      design: z.object({
        source: z.enum(["figma", "pen"]).optional().describe("设计源；省略时按 figmaUrl/penPath 推断"),
        figmaUrl: z.string().optional().describe("Figma 文件 URL（建议带 ?node-id=；source=figma 或推断）"),
        penPath: z.string().optional().describe("相对项目根或绝对路径的 .pen（source=pen；缺省取 .artemis/design 下最新）"),
        nodeId: z.string().optional().describe("覆盖 URL 中的 node-id"),
        renderOut: z.string().optional().describe("pen 渲染输出路径（相对项目根；默认 .artemis/design/pen/<name>.png）")
      }),
      device: z
        .object({
          mode: z.enum(["live", "step"]).optional().describe("设备源模式：live（实时截图，默认）| step（trace 步骤截图）"),
          platform: z
            .enum(["android", "ios"])
            .optional()
            .describe("设备平台：android（默认）| ios（macOS 模拟器；live 经 idb/simctl 截图，step 走 iOS trace 截图）"),
          serial: z.string().optional().describe("目标设备 serial（默认自动选择；平台 ios 时为模拟器 UDID）"),
          traceId: z.string().optional().describe("mode=step 必填：任务 trace id（mobile_run_task 返回）"),
          stepNumber: z.number().int().positive().optional().describe("mode=step 步骤号；省略则用失败证据自动检索步骤（Pro 任务，best-effort）"),
          image: z.enum(["post", "pre"]).optional().describe("步骤截图选 post（行动后，默认）或 pre（行动前）"),
          lossless: z
            .boolean()
            .optional()
            .describe("mode=live 时经 adb 抓无损 PNG（避免 JPEG 伪影；失败自动回退 live JPEG），默认 false")
        })
        .optional(),
      alignment: z
        .object({
          insets: z
            .object({
              top: z.number().optional(),
              right: z.number().optional(),
              bottom: z.number().optional(),
              left: z.number().optional()
            })
            .optional()
            .describe("设备截图边缘裁剪（px），用于系统栏/手势条"),
          ignoreRegions: z
            .array(z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }))
            .optional()
            .describe("按设计坐标屏蔽的区域（动态内容：视频位/轮播/时钟等）")
        })
        .optional(),
      diff: z
        .object({
          pixelThreshold: z.number().min(0).max(1).optional().describe("pixelmatch 阈值，默认 0.1"),
          minAreaRatio: z.number().min(0).max(1).optional().describe("最小区域面积占比，默认 0.005"),
          clusterGap: z.number().int().nonnegative().optional().describe("区域聚类间距（px），默认 8"),
          maxRegions: z.number().int().positive().optional().describe("区域数上限，默认 20"),
          maxEdge: z.number().int().positive().optional().describe("降采样最长边，默认 1440"),
          nodeProximity: z.number().int().nonnegative().optional().describe("无交集区域判为 position-size 的最近节点距离（px），默认 24"),
          colorTolerance: z.number().int().nonnegative().optional().describe("父级填充色比较容差（0-255），默认 24"),
          systemBandRatio: z.number().min(0).max(0.25).optional().describe("上下系统边缘条带比例（无节点引用区域降级 system-area），默认 0.05")
        })
        .optional(),
      save: z.boolean().optional().describe("是否落盘产物，默认 true"),
      dryRun: z.boolean().optional().describe("仅返回计划，不取图不写盘，默认 false")
    }),
    handler: (runtime, args) => designDeviceDiff(runtime, args as unknown as DesignDeviceDiffArgs)
  },
  {
    name: "screen_map",
    description:
      "屏幕映射（持久定位资产）：维护 <项目>/.artemis/design/screen-map.json——设计屏幕/组件 ↔ 路由/组件/文件，另含元素级映射 elements（设计运行期文本 ↔ 观察标签 + accessibilityIdentifier 建议；iOS 套件运行自动发现，save 人工可补）。action=propose 基于 build-brief + 栈约定给出粗粒度候选（带 confidence 与 unmatched，需复核）；action=save 显式写入（幂等，merge:true 增量合并；elements 按 screen+text 合并、source 强制 manual、manual identifier 不被观察覆盖）；action=list 读取。design_device_diff 报告用该映射为每个差异区域输出 localized（mapped/unmapped/no-candidates）。",
    schema: z.object({
      action: z.enum(["list", "propose", "save"]).describe("list 读取 / propose 生成候选 / save 显式写入"),
      entries: z
        .array(z.record(z.unknown()))
        .optional()
        .describe('save 用：{design:{screen,nodeId?,component?}, code:{route?,component?,file?}} 数组'),
      elements: z
        .array(z.record(z.unknown()))
        .optional()
        .describe(
          "save 用：{screen,text,observedLabel?,identifier?,confidence?} 元素级映射数组（source 强制 manual）"
        ),
      merge: z.boolean().optional().describe("save 时按 design key 增量合并已有映射，默认 false（替换）")
    }),
    handler: (runtime, args) => screenMap(runtime, args as unknown as ScreenMapArgs)
  },
  {
    name: "reconciliation",
    description:
      "交互对账审阅（持久资产）：维护 <项目>/.artemis/design/reconciliation.json——设计边 ↔ 真机观测命中/升级/审阅状态（含「真机有设计无」的 runtime-only 逆向观测，证据级不参与生成；改判保留决定历史）。action=list 列举（含来源 designProvenance→provenance、命中数、traces、审阅记录与历史）；action=confirm 人工确认边为可信导航（human-confirmed，下一次 figma_generate_tests 以硬断言生成；幂等，记录 reviewer/时间）；action=reject 判为不成立（该边不进入后续生成）。未裁决项保持待办、不升权。iOS/Android 套件运行自动写入观测与差异条目（见 suite run / DESIGN §13.67–§13.74）。",
    schema: z.object({
      action: z.enum(["list", "confirm", "reject"]).describe("list 列举 / confirm 确认 / reject 驳回"),
      from: z.string().optional().describe("边起点屏幕名（confirm/reject 必填，与 list 输出一致）"),
      to: z.string().optional().describe("边终点屏幕名（confirm/reject 必填）"),
      reviewer: z.string().optional().describe("审阅人标识（写入资产，可省略）"),
      note: z.string().optional().describe("备注（写入资产）")
    }),
    handler: (runtime, args) => reconciliation(runtime, args as unknown as ReconciliationArgs)
  },
];
