import type { IosDevice } from "../device/ios-actions.js";
import type { IosUiNode } from "../device/ios.js";
import type { ChatFn } from "../llm/chat.js";
import { logWarn } from "../log.js";
import { errorMessage } from "../util.js";
import { croppedScreenshotHash, screenSignature } from "./noop.js";
import { buildPerceptionPrompt, fuseVisionElements, parseVisionElements } from "./perception.js";
import { screenTextSummary, updatePreflight } from "./prompt-history.js";
import { matchScriptExpectations, type IosScriptExpectation } from "./script-plan.js";
import { captureStepShot } from "./trace-persist.js";
import type { IosTaskRecord, IosTaskStep } from "./types.js";
import { pngDimensions, type IosVisionMode } from "./vision.js";

const MIN_TEXT_ELEMENTS = 3;
const VISION_MAX_LINES = 30;

/** 循环携带的观察游标（上一屏签名/截图哈希/动作）——调用方持有并逐轮回写。 */
export interface ObservationCursor {
  lastSignature: string | null;
  lastShotHash: string | null;
  previousAction: string | null;
}

export interface StepObservation {
  nodes: IosUiNode[];
  size: { width: number; height: number } | null;
  shot: { rel: string; bytes: Buffer } | null;
  shotDims: { width: number; height: number } | null;
  scale: number | null;
  screen: string;
  scriptHits: number[];
  noop: boolean;
  perception: IosTaskStep["perception"];
  visionLines: string[];
  visionContext: string | null;
}

export interface ObserveStepOptions {
  device: IosDevice;
  record: IosTaskRecord;
  step: number;
  scriptExpectations: IosScriptExpectation[] | null;
  scriptSatisfied: Set<number>;
  cursor: ObservationCursor;
  vision: { mode: IosVisionMode; mainVision: boolean; visionChat: ChatFn | null };
}

function visibleElementCount(nodes: IosUiNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.label.trim() || node.value.trim()) count += 1;
  }
  return count;
}

/** 步骤观察管线：读屏（节点/尺寸/前置截图）→ 脚本贴合与 preflight → 无进展检测 →
 * 视觉感知融合/降级。观察屏幕失败时抛出 `观察屏幕失败: …`（调用方终态收尾）。 */
export async function observeStep(options: ObserveStepOptions): Promise<StepObservation> {
  const { device, record, step, scriptExpectations, scriptSatisfied, cursor, vision } = options;
  let nodes: IosUiNode[];
  try {
    nodes = await device.nodes();
  } catch (error) {
    throw new Error(`观察屏幕失败: ${errorMessage(error)}`);
  }
  let size: { width: number; height: number } | null = null;
  try {
    size = await device.size();
  } catch {
    size = null;
  }
  const shot = await captureStepShot(device, record, step, "pre");
  const screen = screenTextSummary(nodes);
  updatePreflight(record, screen, step);
  const scriptHits =
    scriptExpectations !== null
      ? matchScriptExpectations(scriptExpectations, scriptSatisfied, screen)
      : [];
  const shotDims = shot ? pngDimensions(shot.bytes) : null;
  const scale = shotDims && size && size.width > 0 ? shotDims.width / size.width : null;

  const signature = screenSignature(nodes, size?.height ?? null);
  const shotHash = shot ? croppedScreenshotHash(shot.bytes) : null;
  const comparable = step > 1 && cursor.previousAction !== "wait";
  let noop = false;
  if (comparable && cursor.lastSignature !== null && signature === cursor.lastSignature) {
    const shotSame =
      shotHash !== null && cursor.lastShotHash !== null ? shotHash === cursor.lastShotHash : true;
    if (shotSame) {
      record.noopStreak += 1;
      noop = true;
    } else {
      record.noopStreak = 0;
    }
  } else if (step > 1) {
    record.noopStreak = 0;
  }
  cursor.lastSignature = signature;
  cursor.lastShotHash = shotHash;

  const wantsImage = vision.mode !== "off" && vision.mainVision && shot !== null;
  const wantsPerception =
    vision.mode !== "off" &&
    !vision.mainVision &&
    vision.visionChat !== null &&
    shot !== null &&
    (vision.mode === "auto" || visibleElementCount(nodes) < MIN_TEXT_ELEMENTS);
  let visionLines: string[] = [];
  let visionContext: string | null = null;
  let perception: IosTaskStep["perception"] = "text";
  if (wantsImage && shot) {
    visionContext = shotDims
      ? `本轮附有截图：${shotDims.width}x${shotDims.height} px${
          size ? `（逻辑 ${size.width}x${size.height} pt${scale ? `，scale≈${scale.toFixed(2)}` : ""}）` : ""
        }；坐标以元素 Center 为准，若从截图估计请先除以 scale。`
      : "本轮附有截图；坐标以元素 Center 为准。";
  } else if (wantsPerception && shot) {
    if (shotDims === null || scale === null || !size) {
      record.visionDegraded = record.visionDegraded ?? "视觉感知跳过：截图尺寸或逻辑尺寸未知。";
      perception = "text-degraded";
    } else {
      try {
        const content = await vision.visionChat!([
          {
            role: "user",
            content: [
              { type: "text", text: buildPerceptionPrompt(shotDims.width, shotDims.height) },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${shot.bytes.toString("base64")}` }
              }
            ]
          }
        ]);
        const parsedVision = parseVisionElements(content);
        if (parsedVision === null) {
          record.visionDegraded = record.visionDegraded ?? "视觉感知响应不可解析。";
          perception = "text-degraded";
        } else {
          const fused = fuseVisionElements({
            elements: parsedVision.elements,
            scale,
            width: size.width,
            height: size.height,
            existing: nodes,
            maxLines: VISION_MAX_LINES
          });
          record.visionDropped = record.visionDropped ?? {
            invalid: 0,
            noScale: 0,
            duplicate: 0,
            overflow: 0
          };
          record.visionDropped.invalid += fused.droppedInvalid + parsedVision.dropped;
          record.visionDropped.noScale += fused.droppedNoScale;
          record.visionDropped.duplicate += fused.droppedDuplicate;
          record.visionDropped.overflow += fused.droppedOverflow;
          visionLines = fused.lines;
          visionContext =
            fused.lines.length > 0
              ? `本轮视觉感知补充 ${fused.lines.length} 个元素（像素坐标已换算逻辑点，可能有误）。`
              : "本轮视觉感知未发现可补充元素。";
          perception = "vision-text";
        }
      } catch (error) {
        record.visionDegraded = record.visionDegraded ?? `视觉调用失败：${errorMessage(error)}`;
        logWarn(`iOS 视觉降级为纯文本（${record.traceId}）: ${errorMessage(error)}`);
        perception = "text-degraded";
      }
    }
  }

  return {
    nodes,
    size,
    shot,
    shotDims,
    scale,
    screen,
    scriptHits,
    noop,
    perception,
    visionLines,
    visionContext
  };
}
