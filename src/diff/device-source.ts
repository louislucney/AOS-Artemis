import fs from "node:fs";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Runtime } from "../runtime.js";
import { extractDeviceImage } from "../tools/composite.js";

export interface DeviceCapture {
  bytes: Buffer;
  note: string;
  serial?: string;
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

export async function captureLiveScreenshot(runtime: Runtime, serial?: string): Promise<DeviceCapture> {
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

function textContent(result: CallToolResult): string {
  let text = "";
  for (const item of result.content ?? []) {
    if (item.type === "text") text += `${item.text}\n`;
  }
  return text;
}

function parsePayload(result: CallToolResult): Record<string, unknown> | null {
  const text = textContent(result).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function failureQueryOf(payload: Record<string, unknown> | null): string | null {
  const summary = payload?.test_summary;
  if (!summary || typeof summary !== "object") return null;
  const failed = (summary as Record<string, unknown>).failed_items;
  if (!Array.isArray(failed) || failed.length === 0) return null;
  const first = failed[0];
  if (!first || typeof first !== "object") return null;
  const record = first as Record<string, unknown>;
  const evidence = typeof record.evidence === "string" ? record.evidence.trim() : "";
  const itemText = typeof record.item_text === "string" ? record.item_text.trim() : "";
  const query = (evidence || itemText).replace(/\s+/g, " ").slice(0, 160);
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

function upstreamError(prefix: string, payload: Record<string, unknown>): string {
  const message = typeof payload.message === "string" ? ` - ${payload.message}` : "";
  return `${prefix}：${String(payload.error)}${message}`;
}

export async function resolveTraceStepAnchor(runtime: Runtime, traceId: string): Promise<StepAnchor> {
  const statusResult = await runtime.proxy.callTool("mobile_manage_task", {
    action: "status",
    trace_id: traceId
  });
  const statusPayload = parsePayload(statusResult);
  if (statusPayload && typeof statusPayload.error === "string") {
    throw new Error(upstreamError("读取失败证据失败", statusPayload));
  }
  const query = failureQueryOf(statusPayload);
  if (!query) {
    const summary = statusPayload?.test_summary;
    if (summary && typeof summary === "object") {
      throw new Error(
        `trace ${traceId} 的失败项为空（任务可能已通过）；请显式传 device.stepNumber 或确认失败断言。`
      );
    }
    const status = typeof statusPayload?.status === "string" ? statusPayload.status : "unknown";
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
  const searchPayload = parsePayload(searchResult);
  if (searchPayload && typeof searchPayload.error === "string") {
    throw new Error(upstreamError("步骤检索失败", searchPayload));
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
  const payload = parsePayload(result);
  if (!payload) {
    const text = textContent(result).trim();
    throw new Error(
      `步骤截图获取失败：无法解析上游返回${text ? `（${text.slice(0, 200)}）` : ""}；请确认 traceId 与 stepNumber 是否正确、任务是否已产生轨迹。`
    );
  }
  if (typeof payload.error === "string") {
    throw new Error(`${upstreamError("步骤截图获取失败", payload)}；请核对 traceId/stepNumber 后重试。`);
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
