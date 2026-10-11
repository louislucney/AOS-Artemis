import type { IosDevice } from "../device/ios-actions.js";
import { classifyIosSerial, type IosUiNode } from "../device/ios.js";
import { IosDeviceLogTail } from "../device/ios-log.js";
import { makeChatFn, type ChatContent, type ChatMessage } from "../llm/chat.js";
import type { LlmEntry } from "../llm/registry.js";
import { logWarn } from "../log.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import { collectFailureLogs, resolveLogFeedback } from "./failure-logs.js";
import { croppedScreenshotHash, screenSignature } from "./noop.js";
import { buildPerceptionPrompt, fuseVisionElements, parseVisionElements } from "./perception.js";
import {
  buildUserPrompt,
  IOS_SYSTEM_PROMPT,
  resolveHistorySteps,
  screenTextSummary,
  updatePreflight
} from "./prompt-history.js";
import {
  buildScriptAdherence,
  formatUnresolvedScriptItems,
  matchScriptExpectations,
  parseScriptPlan
} from "./script-plan.js";
import type { StartIosTaskDeps } from "./tool-entry.js";
import { captureStepShot, finish, persistRun } from "./trace-persist.js";
import type { IosTaskRecord, IosTaskStep } from "./types.js";
import { resolveVerifier, resolveVerifyMode, runVerification } from "./verifier.js";
import {
  looksVisionCapable,
  pngDimensions,
  resolveVisionMode,
  type IosVisionMode,
  type VisionTarget
} from "./vision.js";

const DEFAULT_MAX_STEPS = 30;
const MAX_WAIT_MS = 10_000;
const MIN_TEXT_ELEMENTS = 3;
const VISION_MAX_LINES = 30;
const DEFAULT_SETTLE_MS = 200;
const MAX_SETTLE_MS = 2_000;

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveMaxSteps(env: NodeJS.ProcessEnv, override?: number): number {
  if (override !== undefined) return Math.max(1, Math.min(200, Math.floor(override)));
  const raw = Number.parseInt(env.AOS_IOS_MAX_STEPS ?? "", 10);
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_MAX_STEPS;
  return Math.max(1, Math.min(200, raw));
}

function resolveSettleMs(env: NodeJS.ProcessEnv, override?: number): number {
  if (override !== undefined) return Math.max(0, Math.min(MAX_SETTLE_MS, Math.floor(override)));
  const raw = Number.parseInt(env.AOS_IOS_SETTLE_MS ?? "", 10);
  if (!Number.isInteger(raw) || raw < 0) return DEFAULT_SETTLE_MS;
  return Math.max(0, Math.min(MAX_SETTLE_MS, raw));
}

function visibleElementCount(nodes: IosUiNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.label.trim() || node.value.trim()) count += 1;
  }
  return count;
}

function extractJson(content: string): { thought: string; action: string; params: Record<string, unknown> } | null {
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.action !== "string" || record.action.trim() === "") return null;
  const { thought, action, ...params } = record;
  return {
    thought: typeof thought === "string" ? thought : "",
    action: action.trim(),
    params
  };
}

type ActionOutcome = { kind: "step"; text: string } | { kind: "done"; success: boolean; summary: string };

async function executeAction(
  device: IosDevice,
  action: string,
  params: Record<string, unknown>,
  lockedAppPackage: string | null
): Promise<ActionOutcome> {
  const bundleId = typeof params.bundleId === "string" ? params.bundleId : null;
  const bundleAllowed = (): boolean =>
    lockedAppPackage === null || bundleId === lockedAppPackage;
  switch (action) {
    case "tap": {
      const x = asNumber(params.x);
      const y = asNumber(params.y);
      if (x === null || y === null) return { kind: "step", text: "参数错误：tap 需要数字 x/y" };
      await device.tap(x, y);
      return { kind: "step", text: "ok" };
    }
    case "swipe": {
      const x1 = asNumber(params.x1);
      const y1 = asNumber(params.y1);
      const x2 = asNumber(params.x2);
      const y2 = asNumber(params.y2);
      if (x1 === null || y1 === null || x2 === null || y2 === null) {
        return { kind: "step", text: "参数错误：swipe 需要数字 x1/y1/x2/y2" };
      }
      await device.swipe(x1, y1, x2, y2, asNumber(params.durationMs) ?? 300);
      return { kind: "step", text: "ok" };
    }
    case "text": {
      if (typeof params.text !== "string") return { kind: "step", text: "参数错误：text 需要字符串 text" };
      const x = asNumber(params.x);
      const y = asNumber(params.y);
      const result = await device.inputText(params.text, x !== null && y !== null ? { x, y } : undefined);
      return { kind: "step", text: `输入完成（${result.mode}）` };
    }
    case "launch": {
      if (bundleId === null) return { kind: "step", text: "参数错误：launch 需要 bundleId" };
      if (!bundleAllowed()) {
        return {
          kind: "step",
          text: `已被 locked_app_package 限制：拒绝 launch ${bundleId}（仅允许 ${lockedAppPackage}）。`
        };
      }
      await device.launch(bundleId);
      return { kind: "step", text: "ok" };
    }
    case "terminate": {
      if (bundleId === null) return { kind: "step", text: "参数错误：terminate 需要 bundleId" };
      if (!bundleAllowed()) {
        return {
          kind: "step",
          text: `已被 locked_app_package 限制：拒绝 terminate ${bundleId}（仅允许 ${lockedAppPackage}）。`
        };
      }
      const ok = await device.terminate(bundleId);
      return { kind: "step", text: ok ? "ok" : "终止失败（应用可能未在运行）" };
    }
    case "openUrl": {
      if (typeof params.url !== "string") return { kind: "step", text: "参数错误：openUrl 需要 url" };
      if (lockedAppPackage !== null) {
        return {
          kind: "step",
          text: `已被 locked_app_package 限制：禁止 openUrl（仅允许目标应用 ${lockedAppPackage} 内的操作）。`
        };
      }
      await device.openUrl(params.url);
      return { kind: "step", text: "ok" };
    }
    case "alerts": {
      const mode = params.mode === "dismiss" ? "dismiss" : params.mode === "keep" ? "keep" : "accept";
      const result = await device.handleAlerts({ mode });
      return { kind: "step", text: `处理弹窗 ${result.handled} 个` };
    }
    case "wait": {
      const ms = Math.max(0, Math.min(MAX_WAIT_MS, asNumber(params.ms) ?? 1000));
      await sleep(ms);
      return { kind: "step", text: `等待 ${ms}ms` };
    }
    case "back":
      return {
        kind: "step",
        text: "iOS 无系统返回键（capabilities.back=none）；请点击界面上的返回控件"
      };
    case "done": {
      const summary = typeof params.summary === "string" && params.summary.trim() !== ""
        ? params.summary.trim()
        : "任务完成";
      return { kind: "done", success: params.success !== false, summary };
    }
    case "fail": {
      const reason = typeof params.reason === "string" && params.reason.trim() !== ""
        ? params.reason.trim()
        : "模型判定无法完成";
      return { kind: "done", success: false, summary: reason };
    }
    default:
      return { kind: "step", text: `未知动作 ${action}（已忽略）` };
  }
}

export async function runLoop(
  runtime: Runtime,
  record: IosTaskRecord,
  entry: LlmEntry,
  visionTarget: VisionTarget | null,
  deps: StartIosTaskDeps
): Promise<void> {
  const env = deps.env ?? runtime.iosEnvironment();
  const device = deps.device ?? (await runtime.iosDevice(record.udid));
  if (!device) {
    finish(record, "failed", `无法解析 iOS 设备：${record.udid}`);
    return;
  }
  const chat =
    deps.chat ??
    makeChatFn({ baseUrl: entry.baseUrl ?? "", apiKey: entry.apiKey ?? "", model: entry.model });
  const visionChat = deps.visionChat ?? (visionTarget ? makeChatFn(visionTarget.chat) : null);
  const mode: IosVisionMode = resolveVisionMode(env);
  const mainVision = deps.mainVision ?? looksVisionCapable(entry.model);
  const maxSteps = resolveMaxSteps(env, deps.maxSteps);
  const stepDelayMs = deps.stepDelayMs ?? 300;
  const settleMs = resolveSettleMs(env, deps.settleMs);
  const historySteps = resolveHistorySteps(env);
  const verifier =
    resolveVerifyMode(env) === "final"
      ? deps.verifier !== undefined
        ? deps.verifier
        : resolveVerifier(env, await runtime.entries(), {
            chat,
            model: entry.model,
            vision: mainVision
          })
      : null;
  const feedbackEnabled = resolveLogFeedback(env);
  const tail =
    feedbackEnabled && classifyIosSerial(record.udid) === "device"
      ? deps.logTail !== undefined
        ? deps.logTail
        : new IosDeviceLogTail({ serial: record.udid, env })
      : null;
  if (tail) {
    try {
      tail.start();
    } catch (error) {
      logWarn(`iOS 设备日志缓冲启动失败（${record.traceId}）: ${errorMessage(error)}`);
    }
  }
  if (mode === "auto" && !mainVision && !visionChat) {
    record.visionDegraded =
      record.visionDegraded ??
      "自动视觉不可用：active 模型不支持截图且未配置 AOS_IOS_VISION_LLM；已按纯文本执行。";
  }
  const messages: ChatMessage[] = [{ role: "system", content: IOS_SYSTEM_PROMPT }];
  let lastSignature: string | null = null;
  let lastShotHash: string | null = null;
  let previousAction: string | null = null;
  const scriptPlan = parseScriptPlan(record.taskDesc);
  const scriptExpectations = scriptPlan?.steps ?? null;
  const scriptSatisfied = new Set<number>();
  if (scriptPlan?.start) {
    record.preflight = {
      screen: scriptPlan.start.screen,
      hints: scriptPlan.start.hints,
      status: scriptPlan.start.hints.length > 0 ? "pending" : "unchecked",
      matchedAtStep: null
    };
  }

  const finalize = async (
    status: "completed" | "failed" | "cancelled",
    summary: string
  ): Promise<void> => {
    let finalSummary = summary;
    if (status === "failed" && feedbackEnabled) {
      const logs = await collectFailureLogs(runtime, record, tail, deps.logCollector);
      record.failureLogs = logs;
      if (logs.status === "ok" && logs.lines) {
        finalSummary = `${summary}\n设备日志已采集（${logs.lines} 行，来源 ${logs.source}）。`;
      }
    } else if (tail) {
      try {
        tail.stop();
      } catch {
        /* ignore */
      }
    }
    finish(record, status, finalSummary);
    if (runtime.crashCaptureEnabled()) {
      const processName = record.lockedAppPackage
        ? record.lockedAppPackage.split(".").pop() ?? null
        : null;
      void runtime.captureIosCrashes({
        traceId: record.traceId,
        udid: record.udid,
        processName,
        startMs: record.startedAtMs,
        endMs: record.finishedAtMs ?? Date.now()
      });
    }
  };

  try {
    if (record.lockedAppPackage) {
      try {
        await device.launch(record.lockedAppPackage);
        await sleep(1000);
      } catch (error) {
        await finalize("failed", `启动应用 ${record.lockedAppPackage} 失败: ${errorMessage(error)}`);
        return;
      }
    }
    for (let step = 1; step <= maxSteps; step += 1) {
      if (record.stopRequested) {
        await finalize("cancelled", "任务已被停止");
        return;
      }
      let nodes: IosUiNode[];
      try {
        nodes = await device.nodes();
      } catch (error) {
        await finalize("failed", `观察屏幕失败: ${errorMessage(error)}`);
        return;
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
      const instruction = record.instruction;
      record.instruction = null;

      const signature = screenSignature(nodes, size?.height ?? null);
      const shotHash = shot ? croppedScreenshotHash(shot.bytes) : null;
      const comparable = step > 1 && previousAction !== "wait";
      let noop = false;
      if (comparable && lastSignature !== null && signature === lastSignature) {
        const shotSame =
          shotHash !== null && lastShotHash !== null ? shotHash === lastShotHash : true;
        if (shotSame) {
          record.noopStreak += 1;
          noop = true;
        } else {
          record.noopStreak = 0;
        }
      } else if (step > 1) {
        record.noopStreak = 0;
      }
      lastSignature = signature;
      lastShotHash = shotHash;

      const wantsImage = mode !== "off" && mainVision && shot !== null;
      const wantsPerception =
        mode !== "off" &&
        !mainVision &&
        visionChat !== null &&
        shot !== null &&
        (mode === "auto" || visibleElementCount(nodes) < MIN_TEXT_ELEMENTS);
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
            const content = await visionChat!([
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

      const textPrompt = buildUserPrompt(
        record,
        nodes,
        size,
        step,
        maxSteps,
        instruction,
        visionContext,
        visionLines,
        historySteps
      );

      let content: string;
      if (wantsImage && shot) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: textPrompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${shot.bytes.toString("base64")}` } }
          ] satisfies ChatContent
        });
        try {
          content = await chat(messages);
          perception = "image";
        } catch (error) {
          record.visionDegraded = record.visionDegraded ?? `多模态决策调用失败：${errorMessage(error)}`;
          logWarn(`iOS 多模态降级为纯文本（${record.traceId}）: ${errorMessage(error)}`);
          messages[messages.length - 1] = { role: "user", content: textPrompt };
          perception = "text-degraded";
          try {
            content = await chat(messages);
          } catch (fallbackError) {
            await finalize("failed", `LLM 调用失败: ${errorMessage(fallbackError)}`);
            return;
          }
        }
        // 历史中不保留旧截图，避免每步重传（对齐 Android 的中间截图裁剪）。
        messages[messages.length - 1] = { role: "user", content: textPrompt };
      } else {
        messages.push({ role: "user", content: textPrompt });
        try {
          content = await chat(messages);
        } catch (error) {
          await finalize("failed", `LLM 调用失败: ${errorMessage(error)}`);
          return;
        }
      }
      messages.push({ role: "assistant", content });

      const parsed = extractJson(content);
      if (!parsed) {
        previousAction = "invalid";
        record.steps.push({
          step,
          thought: "",
          action: "invalid",
          params: { raw: content.slice(0, 200) },
          outcome: "模型输出不是合法动作 JSON",
          ...(shot ? { shot: shot.rel } : {}),
          ...(screen ? { screen } : {}),
          ...(scale !== null ? { scale } : {}),
          ...(noop ? { noop: true } : {}),
          ...(scriptHits.length > 0 ? { scriptHits } : {}),
          perception
        });
        persistRun(record);
        if (stepDelayMs > 0) await sleep(stepDelayMs);
        continue;
      }
      previousAction = parsed.action;

      let outcome: ActionOutcome;
      try {
        outcome = await executeAction(device, parsed.action, parsed.params, record.lockedAppPackage);
      } catch (error) {
        outcome = { kind: "step", text: `执行失败: ${errorMessage(error)}` };
      }
      if (outcome.kind === "done") {
        if (settleMs > 0) await sleep(settleMs);
        const donePost = await captureStepShot(device, record, step, "post");
        let doneNodes: IosUiNode[] | null = null;
        if (scriptExpectations !== null) {
          try {
            doneNodes = await device.nodes();
          } catch {
            doneNodes = null;
          }
        }
        const doneHits =
          doneNodes && scriptExpectations
            ? matchScriptExpectations(scriptExpectations, scriptSatisfied, screenTextSummary(doneNodes))
            : [];
        record.steps.push({
          step,
          thought: parsed.thought,
          action: parsed.action,
          params: parsed.params,
          outcome: outcome.success ? "done" : "fail",
          ...(shot ? { shot: shot.rel } : {}),
          ...(donePost ? { postShot: donePost.rel } : {}),
          ...(screen ? { screen } : {}),
          ...(scale !== null ? { scale } : {}),
          ...(noop ? { noop: true } : {}),
          ...(scriptHits.length + doneHits.length > 0
            ? { scriptHits: [...scriptHits, ...doneHits] }
            : {}),
          perception
        });
        const scriptAdherence = scriptExpectations
          ? buildScriptAdherence(scriptExpectations, scriptSatisfied)
          : null;
        record.scriptAdherence = scriptAdherence;
        if (outcome.success && verifier) {
          record.verification = await runVerification(
            verifier,
            record,
            device,
            doneNodes ?? nodes,
            outcome.summary,
            donePost ? donePost.bytes : null,
            scriptAdherence?.unresolved ?? [],
            scriptAdherence?.deferred.total ?? 0,
            record.preflight?.status === "unmatched" ? record.preflight : null
          );
          persistRun(record);
        }
        const adherenceNote =
          scriptAdherence && scriptAdherence.unresolved.length > 0
            ? `\n⚠ 脚本断言未出现（确定性核对）：${formatUnresolvedScriptItems(scriptAdherence.unresolved)}`
            : "";
        const preflightNote =
          record.preflight && record.preflight.status === "unmatched"
            ? `\n⚠ 起始屏核对未通过：未观察到「${record.preflight.screen}」页预期文本「${record.preflight.hints.join("」「")}」`
            : "";
        const auditNote = `${adherenceNote}${preflightNote}`;
        if (outcome.success && record.verification?.status === "failed") {
          await finalize("failed", `验证未通过：${record.verification.reason}${auditNote}`);
          return;
        }
        await finalize(
          outcome.success ? "completed" : "failed",
          `${outcome.summary}${auditNote}`
        );
        return;
      }
      if (settleMs > 0) await sleep(settleMs);
      const post = await captureStepShot(device, record, step, "post");
      record.steps.push({
        step,
        thought: parsed.thought,
        action: parsed.action,
        params: parsed.params,
        outcome: outcome.text,
        ...(shot ? { shot: shot.rel } : {}),
        ...(post ? { postShot: post.rel } : {}),
        ...(screen ? { screen } : {}),
        ...(scale !== null ? { scale } : {}),
        ...(noop ? { noop: true } : {}),
        ...(scriptHits.length > 0 ? { scriptHits } : {}),
        perception
      });
      persistRun(record);
      if (stepDelayMs > 0) await sleep(stepDelayMs);
    }
    await finalize("failed", `超出步数上限（${maxSteps}），任务未完成`);
  } catch (error) {
    await finalize("failed", `执行器异常: ${errorMessage(error)}`);
  }
}
