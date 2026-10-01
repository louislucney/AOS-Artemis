import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { fetchFigmaDesignNodes, fetchFigmaRenderPng, resolveFigmaNodeId, type FigmaDesignNode } from "../figma/render.js";
import { PEN_CLI_HINT, type PenExecFn } from "../pen/cli.js";
import type { PenEnsureFn } from "../pen/install.js";
import { PEN_HINT, resolvePenTarget } from "../pen/paths.js";
import { errorMessage } from "../util.js";
import type { Runtime } from "../runtime.js";
import { renderAnnotatedPng } from "./annotate.js";
import {
  captureLiveScreenshot,
  captureStepScreenshot,
  resolveTraceStepAnchor,
  type DeviceCapture,
  type StepAnchor
} from "./device-source.js";
import { decodeImage, diffScreens, encodePng, type Bbox, type Insets } from "./engine.js";
import { renderPenDesign } from "./pen-source.js";

export interface DesignSourceArgs {
  source?: "figma" | "pen";
  figmaUrl?: string;
  penPath?: string;
  nodeId?: string;
  renderOut?: string;
}

export interface DesignDeviceDiffArgs {
  design: DesignSourceArgs;
  device?: {
    mode?: "live" | "step";
    serial?: string;
    traceId?: string;
    stepNumber?: number;
    image?: "post" | "pre";
  };
  alignment?: { insets?: Partial<Insets>; ignoreRegions?: Bbox[] };
  diff?: {
    pixelThreshold?: number;
    minAreaRatio?: number;
    clusterGap?: number;
    maxRegions?: number;
    maxEdge?: number;
    nodeProximity?: number;
    colorTolerance?: number;
    systemBandRatio?: number;
  };
  save?: boolean;
  dryRun?: boolean;
}

export interface DesignDeviceDiffDeps {
  exec?: PenExecFn;
  ensure?: PenEnsureFn;
}

function resolveDesignSource(design: DesignSourceArgs): { kind: "figma" } | { kind: "pen" } | { error: string } {
  const hasFigma = typeof design.figmaUrl === "string" && design.figmaUrl.length > 0;
  const hasPen = typeof design.penPath === "string" && design.penPath.length > 0;
  if (design.source === "pen") return { kind: "pen" };
  if (design.source === "figma") {
    return hasFigma ? { kind: "figma" } : { error: "design.source=figma 需要 design.figmaUrl。" };
  }
  if (hasFigma && hasPen) return { error: "design 只能给 figmaUrl 或 penPath 之一。" };
  if (hasFigma) return { kind: "figma" };
  if (hasPen) return { kind: "pen" };
  return {
    error:
      'design 需要设计源：figmaUrl（Figma 链接）或 source:"pen"（可选 penPath，缺省取 .artemis/design 下最新 .pen）。'
  };
}

const FIGMA_HINT =
  "提示：REST 模式需要 FIGMA_ACCESS_TOKEN（写入项目 .env 或调用 aos_configure 携带 figmaToken）。";

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

function jsonError(message: string): CallToolResult {
  return jsonResult({ ok: false, error: message }, true);
}

export function diffSlug(nodeId: string): string {
  return nodeId.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "screen";
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export async function designDeviceDiff(
  runtime: Runtime,
  args: DesignDeviceDiffArgs,
  deps: DesignDeviceDiffDeps = {}
): Promise<CallToolResult> {
  try {
    const source = resolveDesignSource(args.design ?? {});
    if ("error" in source) return jsonError(source.error);
    const started = Date.now();
    const mode = args.device?.mode ?? "live";
    if (mode === "step") {
      if (!args.device?.traceId) {
        return jsonError("device.mode=step 需要 device.traceId（截图经 mobile_inspect_trace 获取）。");
      }
      if (args.device.stepNumber !== undefined && (!Number.isInteger(args.device.stepNumber) || args.device.stepNumber <= 0)) {
        return jsonError("device.stepNumber 必须是正整数（省略则用失败证据自动检索步骤）。");
      }
    }
    const stepRequest = mode === "step"
      ? {
          traceId: args.device!.traceId!,
          stepNumber: args.device!.stepNumber,
          image: args.device?.image ?? ("post" as const)
        }
      : null;

    let plannedNodeId: string | null = null;
    try {
      plannedNodeId = source.kind === "figma" ? resolveFigmaNodeId(args.design.figmaUrl!, args.design.nodeId) : null;
    } catch {
      plannedNodeId = null;
    }
    const penTarget = source.kind === "pen" ? resolvePenTarget(runtime, args.design.penPath) : null;

    if (args.dryRun === true) {
      const slug =
        source.kind === "figma"
          ? plannedNodeId
            ? diffSlug(plannedNodeId)
            : "screen"
          : penTarget
            ? diffSlug(path.basename(penTarget, ".pen"))
            : "screen";
      return jsonResult({
        ok: true,
        dryRun: true,
        design:
          source.kind === "figma"
            ? { source: "figma", figmaUrl: args.design.figmaUrl, nodeId: plannedNodeId }
            : { source: "pen", penPath: args.design.penPath ?? null, resolved: penTarget ? path.relative(runtime.project.rootDir, penTarget) : null, renderOut: args.design.renderOut ?? null },
        device:
          stepRequest !== null
            ? {
                mode: "step",
                traceId: stepRequest.traceId,
                stepNumber: stepRequest.stepNumber ?? null,
                autoAnchor: stepRequest.stepNumber === undefined,
                image: stepRequest.image,
                serial: args.device?.serial ?? null
              }
            : { mode: "live", serial: args.device?.serial ?? null },
        plannedDir: path.join(runtime.configDirAbs, "design", "diffs", `${slug}-<timestamp>`),
        hint: "dryRun 不拉取设计/设备截图、不写盘。"
      });
    }

    let stepAnchor: StepAnchor | null = null;
    let anchorSource: "explicit" | "search" | null = null;
    let stepNumber: number | null = null;
    if (stepRequest !== null) {
      if (stepRequest.stepNumber !== undefined) {
        stepNumber = stepRequest.stepNumber;
        anchorSource = "explicit";
      } else {
        try {
          stepAnchor = await resolveTraceStepAnchor(runtime, stepRequest.traceId);
        } catch (error) {
          return jsonError(`自动锚点失败: ${errorMessage(error)}`);
        }
        stepNumber = stepAnchor.stepNumber;
        anchorSource = "search";
      }
    }

    let captured: DeviceCapture;
    try {
      captured = stepRequest !== null && stepNumber !== null
        ? await captureStepScreenshot(runtime, {
            traceId: stepRequest.traceId,
            stepNumber,
            image: stepRequest.image
          })
        : await captureLiveScreenshot(runtime, args.device?.serial);
    } catch (error) {
      return jsonError(stepRequest !== null ? `步骤截图失败: ${errorMessage(error)}` : `真机截图失败: ${errorMessage(error)}`);
    }
    const deviceBytes = captured.bytes;
    const deviceNote = captured.note;

    let designPng: Buffer;
    let designNodes: FigmaDesignNode[] = [];
    let nodeWarning: string | null = null;
    let designUnit: Record<string, unknown>;
    let designResponse: Record<string, unknown>;
    let designSlug = "screen";
    if (source.kind === "figma") {
      try {
        const render = await fetchFigmaRenderPng(args.design.figmaUrl!, args.design.nodeId, 1);
        designPng = render.png;
        designUnit = { source: "figma", nodeId: render.nodeId };
        designResponse = { source: "figma", nodeId: render.nodeId, renderUrl: render.renderUrl };
        designSlug = diffSlug(render.nodeId);
      } catch (error) {
        return jsonResult({ ok: false, error: `Figma 渲染失败: ${errorMessage(error)}`, hint: FIGMA_HINT }, true);
      }
      try {
        designNodes = await fetchFigmaDesignNodes(args.design.figmaUrl!, args.design.nodeId);
      } catch (error) {
        nodeWarning = `设计节点几何获取失败（分类降级为 pixel）：${errorMessage(error)}`;
      }
    } else {
      try {
        const rendered = await renderPenDesign(runtime, {
          penPath: args.design.penPath,
          renderOut: args.design.renderOut,
          exec: deps.exec,
          ensure: deps.ensure
        });
        designPng = rendered.png;
        designNodes = rendered.nodes;
        designUnit = { source: "pen", name: rendered.penPath };
        designSlug = diffSlug(path.basename(rendered.penPath, ".pen"));
        designResponse = {
          source: "pen",
          path: rendered.penPath,
          output: path.relative(runtime.project.rootDir, rendered.output)
        };
      } catch (error) {
        const message = errorMessage(error);
        return jsonResult(
          { ok: false, error: `pen 渲染失败: ${message}`, hint: message.includes("没有找到 .pen 文件") ? PEN_HINT : PEN_CLI_HINT },
          true
        );
      }
    }

    const resolvedStepNumber = stepRequest !== null ? stepNumber : null;
    const anchorAmbiguous = stepAnchor !== null && stepAnchor.candidates.length > 1;
    const anchorInfo = stepAnchor
      ? {
          source: anchorSource,
          query: stepAnchor.query,
          candidates: stepAnchor.candidates.slice(0, 5),
          ...(anchorAmbiguous ? { ambiguous: true } : {})
        }
      : anchorSource
        ? { source: anchorSource }
        : null;

    let annotated: Buffer;
    let deviceImage: ReturnType<typeof decodeImage>;
    let diffResult: ReturnType<typeof diffScreens>;
    try {
      const design = decodeImage(designPng);
      const device = decodeImage(deviceBytes);
      deviceImage = device;
      diffResult = diffScreens(design, device, {
        insets: args.alignment?.insets,
        ignoreRegions: args.alignment?.ignoreRegions,
        designNodes,
        ...args.diff
      });
      annotated = renderAnnotatedPng(design, diffResult.regions);
    } catch (error) {
      return jsonError(`差异计算失败: ${errorMessage(error)}`);
    }

    const warnings = [
      ...(nodeWarning ? [nodeWarning] : []),
      ...(anchorAmbiguous
        ? [`失败证据命中 ${stepAnchor!.candidates.length} 个步骤，已取首个 Step ${stepAnchor!.stepNumber}；可用 device.stepNumber 显式指定。`]
        : [])
    ];
    const designScreens = designNodes
      .filter((node) => (node.depth ?? 0) === 0)
      .slice(0, 10)
      .map((node) => ({ id: node.id, name: node.name, width: node.width, height: node.height }));
    const shared = {
      alignment: diffResult.alignment,
      designScreens,
      ignoredRegions: diffResult.ignoredRegions,
      designNodes: designNodes.length,
      thresholds: diffResult.thresholds,
      warnings,
      ...(anchorInfo ? { anchor: anchorInfo } : {}),
      regions: diffResult.regions,
      summary: diffResult.summary
    };
    const report = {
      schemaVersion: 1 as const,
      unit: {
        design: designUnit,
        device:
          stepRequest !== null
            ? {
                mode: "step" as const,
                traceId: stepRequest.traceId,
                stepNumber: resolvedStepNumber,
                image: stepRequest.image,
                anchor: anchorSource,
                ...(captured.serial ? { serial: captured.serial } : {})
              }
            : {
                mode: "live" as const,
                ...(args.device?.serial ? { serial: args.device.serial } : {})
              }
      },
      ...shared,
      elapsedMs: Date.now() - started
    };

    let saved: Record<string, string> | undefined;
    if (args.save !== false) {
      const dir = path.join(runtime.configDirAbs, "design", "diffs", `${designSlug}-${timestamp()}`);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
        fs.writeFileSync(path.join(dir, "annotated.png"), annotated);
        fs.writeFileSync(path.join(dir, "design.png"), designPng);
        fs.writeFileSync(path.join(dir, "device.png"), encodePng(deviceImage));
      } catch (error) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        return jsonError(`产物写入失败: ${errorMessage(error)}`);
      }
      saved = {
        dir,
        report: path.join(dir, "report.json"),
        annotated: path.join(dir, "annotated.png"),
        design: path.join(dir, "design.png"),
        device: path.join(dir, "device.png")
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              dryRun: false,
              design: designResponse,
              device: { source: deviceNote, serial: captured.serial ?? args.device?.serial ?? "(auto)" },
              ...shared,
              saved
            },
            null,
            2
          )
        },
        { type: "image", data: annotated.toString("base64"), mimeType: "image/png" }
      ]
    };
  } catch (error) {
    return jsonError(`设计 vs 真机对比失败: ${errorMessage(error)}`);
  }
}
