import fs from "node:fs";

import {
  resultPayload,
  resultText,
  taskStatusOf,
  type TaskStatus
} from "../artemis/task-result.js";
import { captureIosPng, type IosPngCapture } from "../device/ios.js";
import { captureAdbPng, type AdbPngCapture } from "../device/screenshot.js";
import type { Runtime } from "../runtime.js";
import { extractDeviceImage } from "../tools/device-image.js";
import { errorMessage } from "../util.js";

export interface DeviceCapture {
  bytes: Buffer;
  note: string;
  serial?: string;
}

export interface LiveCaptureOptions {
  lossless?: boolean;
  platform?: "android" | "ios";
  capturePng?: (options?: { serial?: string | null }) => Promise<AdbPngCapture>;
  captureIosPng?: (options?: { serial?: string | null }) => Promise<IosPngCapture>;
}

export interface StepScreenshotRequest {
  traceId: string;
  stepNumber: number;
  image: "post" | "pre";
}

export interface StepAnchorCandidate {
  stepNumber: number;
  label: string;
}

export interface StepAnchor {
  stepNumber: number;
  query: string;
  candidates: StepAnchorCandidate[];
}

async function captureArtemisLive(runtime: Runtime, serial?: string): Promise<DeviceCapture> {
  const result = await runtime.proxy.callTool("mobile_get_device_state", {
    view_type: "screenshot",
    ...(serial ? { device_serial: serial } : {})
  });
  const extracted = extractDeviceImage(result);
  if (!extracted) {
    throw new Error("无法从 mobile_get_device_state 结果中解析截图（image 块或本地文件路径）。");
  }
  return { bytes: Buffer.from(extracted.data, "base64"), note: extracted.note };
}

const IOS_ERROR_HINTS: Record<string, string> = {
  "ios-unsupported": "iOS 模拟器仅支持 macOS。",
  "no-device": "没有已启动的模拟器；请先执行 xcrun simctl boot <udid>。",
  "no-serial": "有多台已启动的模拟器；请用 device.serial 指定 UDID。",
  "not-found": "未找到 idb/xcrun（需要 Xcode；可用 AOS_IDB_PATH / AOS_XCRUN_PATH 指定路径）。"
};

/** Live device capture. `lossless` grabs a PNG straight from adb
 * (`exec-out screencap -p`) to keep pixel diffs free of JPEG artifacts; when
 * adb is unavailable it falls back to ARTEMIS's live JPEG and says so.
 * `platform:"ios"` switches to the macOS simulator backend (idb → simctl),
 * which always yields PNG (ARTEMIS itself is Android-only, so there is no
 * JPEG fallback). */
export async function captureLiveScreenshot(
  runtime: Runtime,
  serial?: string,
  options: LiveCaptureOptions = {}
): Promise<DeviceCapture> {
  if (options.platform === "ios") {
    const captureIos = options.captureIosPng ?? ((captureOptions) => captureIosPng(captureOptions ?? {}));
    let png: IosPngCapture;
    try {
      png = await captureIos({ serial });
    } catch (error) {
      png = { ok: false, serial: serial ?? null, error: errorMessage(error) };
    }
    if (png.ok && png.bytes) {
      const tool = png.tool === "simctl" ? "simctl 兜底" : "idb";
      return {
        bytes: png.bytes,
        note: `iOS 模拟器 PNG（${tool}，udid=${png.serial ?? "?"}）`,
        ...(png.serial ? { serial: png.serial } : {})
      };
    }
    const hint = IOS_ERROR_HINTS[png.error ?? ""] ?? "请确认模拟器已启动且 idb/simctl 可用。";
    throw new Error(`iOS 模拟器截图失败（${png.error ?? "unknown"}）；${hint}`);
  }
  if (options.lossless !== true) return captureArtemisLive(runtime, serial);
  const capturePng = options.capturePng ?? ((captureOptions) => captureAdbPng(captureOptions ?? {}));
  let png: AdbPngCapture;
  try {
    png = await capturePng({ serial });
  } catch (error) {
    png = {
      ok: false,
      serial: serial ?? null,
      adb: { path: null, source: "missing" },
      error: errorMessage(error)
    };
  }
  if (png.ok && png.bytes) {
    return {
      bytes: png.bytes,
      note: `adb exec-out screencap -p（无损 PNG，serial=${png.serial ?? "?"}）`,
      ...(png.serial ? { serial: png.serial } : {})
    };
  }
  const fallback = await captureArtemisLive(runtime, serial);
  const normalized = fallback.serial ?? serial;
  return {
    bytes: fallback.bytes,
    note: `${fallback.note}；无损 PNG 不可用（${png.error ?? "unknown"}），已回退 live JPEG`,
    ...(normalized ? { serial: normalized } : {})
  };
}

function failureQueryOf(status: TaskStatus | null): string | null {
  const first = status?.testSummary?.failedItems[0];
  if (!first) return null;
  const query = (first.evidence ?? first.itemText ?? "").replace(/\s+/g, " ").slice(0, 160);
  return query || null;
}

function stepCandidatesOf(resultsText: string): StepAnchorCandidate[] {
  const candidates: StepAnchorCandidate[] = [];
  for (const match of resultsText.matchAll(/^\[Step (\d+)([^\]]*)\]/gm)) {
    const stepNumber = Number.parseInt(match[1]!, 10);
    if (!Number.isInteger(stepNumber) || stepNumber <= 0) continue;
    if (candidates.some((candidate) => candidate.stepNumber === stepNumber)) continue;
    candidates.push({ stepNumber, label: match[2]?.trim() ?? "" });
  }
  return candidates;
}

function upstreamError(prefix: string, status: TaskStatus): string {
  const message = status.message ? ` - ${status.message}` : "";
  return `${prefix}：${status.error}${message}`;
}

export async function resolveTraceStepAnchor(runtime: Runtime, traceId: string): Promise<StepAnchor> {
  const statusResult = await runtime.proxy.callTool("mobile_manage_task", {
    action: "status",
    trace_id: traceId
  });
  const statusPayload = resultPayload(statusResult);
  const statusInfo = taskStatusOf(statusPayload);
  if (statusInfo?.error && !statusInfo.status) {
    throw new Error(upstreamError("读取失败证据失败", statusInfo));
  }
  const query = failureQueryOf(statusInfo);
  if (!query) {
    if (statusInfo?.testSummary) {
      throw new Error(
        `trace ${traceId} 的失败项为空（任务可能已通过）；请显式传 device.stepNumber 或确认失败断言。`
      );
    }
    const status = statusInfo?.status ?? "unknown";
    throw new Error(
      `trace ${traceId} 没有失败证据（status=${status}；Flash 任务没有 run_outcome，或任务运行中/无 check items）；请显式传 device.stepNumber（可用 mobile_inspect_trace 查看步骤）。`
    );
  }
  const searchResult = await runtime.proxy.callTool("mobile_inspect_trace", {
    action: "search",
    trace_id: traceId,
    query,
    max_results: 5
  });
  const searchPayload = resultPayload(searchResult);
  const searchInfo = taskStatusOf(searchPayload);
  if (searchInfo?.error) {
    throw new Error(upstreamError("步骤检索失败", searchInfo));
  }
  const resultsText = typeof searchPayload?.results === "string" ? searchPayload.results : "";
  const candidates = stepCandidatesOf(resultsText);
  if (candidates.length === 0) {
    throw new Error(
      `未检索到与失败证据匹配的步骤（query: ${query}；检索原文：${resultsText.slice(0, 200) || "(空)"}）；请显式传 device.stepNumber。`
    );
  }
  return { stepNumber: candidates[0]!.stepNumber, query, candidates };
}

function pathOf(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.startsWith("file://") ? decodeURIComponent(value.slice(7)) : value;
}

export async function captureStepScreenshot(
  runtime: Runtime,
  request: StepScreenshotRequest
): Promise<DeviceCapture> {
  if (request.image !== "post" && request.image !== "pre") {
    throw new Error(`不支持的 image=${String(request.image)}（可选 post/pre）`);
  }
  const result = await runtime.proxy.callTool("mobile_inspect_trace", {
    action: "view_step_screenshots",
    trace_id: request.traceId,
    step_number: request.stepNumber
  });
  const payload = resultPayload(result);
  if (!payload) {
    const text = resultText(result).trim();
    throw new Error(
      `步骤截图获取失败：无法解析上游返回${text ? `（${text.slice(0, 200)}）` : ""}；请确认 traceId 与 stepNumber 是否正确、任务是否已产生轨迹。`
    );
  }
  const statusInfo = taskStatusOf(payload);
  if (statusInfo?.error) {
    throw new Error(`${upstreamError("步骤截图获取失败", statusInfo)}；请核对 traceId/stepNumber 后重试。`);
  }
  const key = request.image === "post" ? "after_screenshot" : "before_screenshot";
  const filePath = pathOf(payload[key]);
  if (!filePath) {
    const alternate = request.image === "post" ? "pre" : "post";
    throw new Error(
      `步骤 ${request.stepNumber} 没有 ${request.image} 截图（${key} 为空）；该步骤可能无界面变化或截图未落盘，可改用 image:"${alternate}" 或核对步骤号。`
    );
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `步骤截图文件不存在：${filePath}；轨迹产物可能已被清理，可确认 .artemis/traces 完整或改用 device.mode:"live"。`
    );
  }
  const serial =
    typeof payload.device_serial === "string" && payload.device_serial ? payload.device_serial : undefined;
  return { bytes: fs.readFileSync(filePath), note: `${key} ${filePath}`, ...(serial ? { serial } : {}) };
}
