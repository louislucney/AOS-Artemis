import type { IosDevice } from "../device/ios-actions.js";
import type { IosUiNode } from "../device/ios.js";
import { makeChatFn, type ChatMessage } from "../llm/chat.js";
import { entryIssues, type LlmEntry } from "../llm/registry.js";
import { logWarn } from "../log.js";
import { errorMessage } from "../util.js";
import { PROMPT_MAX_ELEMENTS, formatScreenForPrompt } from "./prompt-history.js";
import type { IosScriptAdherence, IosScriptPreflight } from "./script-plan.js";
import type {
  IosTaskRecord,
  IosVerification,
  IosVerificationItem,
  VerifierTarget
} from "./types.js";
import { looksVisionCapable } from "./vision.js";

export function resolveVerifyMode(env: NodeJS.ProcessEnv): "final" | "off" {
  const raw = env.AOS_IOS_VERIFY?.trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" || raw === "no" ? "off" : "final";
}

export function resolveVerifier(
  env: NodeJS.ProcessEnv,
  entries: LlmEntry[],
  main: VerifierTarget
): VerifierTarget {
  const entryName = env.AOS_IOS_VERIFY_LLM?.trim();
  if (!entryName) return main;
  const entry = entries.find((item) => item.name === entryName);
  if (entry && entryIssues(entry).length === 0 && entry.apiKey && entry.baseUrl) {
    return {
      chat: makeChatFn({ baseUrl: entry.baseUrl, apiKey: entry.apiKey, model: entry.model }),
      model: entry.model,
      vision: looksVisionCapable(entry.model)
    };
  }
  logWarn(`AOS_IOS_VERIFY_LLM 条目不可用（${entryName}），验证回退主模型。`);
  return main;
}

function buildVerificationPrompt(
  taskDesc: string,
  claimedSummary: string,
  screen: string,
  stale: boolean,
  scriptUnresolved: IosScriptAdherence["unresolved"] = [],
  scriptDeferredCount = 0,
  preflightUnmatched: IosScriptPreflight | null = null
): string {
  return [
    "你是移动端测试验证器。只依据下面的最终界面证据判断任务是否真正完成；不要采信执行器的自称。",
    `任务：${taskDesc}`,
    `执行器自称：${claimedSummary}`,
    ...(stale ? ["注意：层级补采失败，当前元素快照可能过时，请主要依据截图判断。"] : []),
    ...(scriptUnresolved.length > 0
      ? [
          "",
          "脚本断言核对（确定性，执行全程从未出现的预期）：",
          ...scriptUnresolved.map(
            (item) =>
              `- 步骤${item.index}${item.screen ? ` 应进入「${item.screen}」` : ""}，预期出现「${item.hints.join("」「")}」但从未出现`
          ),
          "若执行路径合理且任务确实完成可忽略；若确为缺失步骤，请写入 failed_items。"
        ]
      : []),
    ...(scriptDeferredCount > 0
      ? [
          "",
          `另有 ${scriptDeferredCount} 步探索（推断跳转，deferred）：不参与本次判定，请勿因此写入 failed_items。`
        ]
      : []),
    ...(preflightUnmatched
      ? [
          "",
          `起始屏核对（确定性）：执行全程未观察到预期起始页「${preflightUnmatched.screen}」（应出现「${preflightUnmatched.hints.join("」「")}」）。若执行路径合理且任务确实完成可忽略；若说明用例起点被跳过，请写入 failed_items。`
        ]
      : []),
    "",
    "当前屏幕元素：",
    screen || "(无可用元素；若附有截图请依据截图判断)",
    "",
    '输出 JSON（不要 markdown 代码块）：{"pass":true|false,"reason":"简要理由","failed_items":[{"item_text":"未满足的要求","evidence":"界面证据","region":[l,t,r,b]}]}',
    "规则：pass=false 时必须列出至少一个具体 failed_items（含证据）；无法指出具体不符项时输出 pass=true。"
  ].join("\n");
}

function parseVerification(
  raw: string
): { pass: boolean; reason: string; failedItems: IosVerificationItem[] } | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.pass !== "boolean") return null;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  const failedItems: IosVerificationItem[] = [];
  if (Array.isArray(record.failed_items)) {
    for (const entry of record.failed_items) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      const text =
        typeof item.item_text === "string" && item.item_text.trim() !== ""
          ? item.item_text.trim()
          : typeof item.text === "string"
            ? item.text.trim()
            : "";
      const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
      if (!text && !evidence) continue;
      failedItems.push({
        item_text: text || evidence,
        evidence: evidence || text,
        ...(item.region !== undefined ? { region: item.region } : {})
      });
    }
  }
  return { pass: record.pass, reason, failedItems };
}

export async function runVerification(
  verifier: VerifierTarget,
  record: IosTaskRecord,
  device: IosDevice,
  fallbackNodes: IosUiNode[],
  claimedSummary: string,
  screenshot: Buffer | null,
  scriptUnresolved: IosScriptAdherence["unresolved"] = [],
  scriptDeferredCount = 0,
  preflightUnmatched: IosScriptPreflight | null = null
): Promise<IosVerification> {
  let nodes = fallbackNodes;
  let stale = false;
  try {
    nodes = await device.nodes();
  } catch {
    stale = true;
  }
  if (stale && !verifier.vision) {
    return {
      status: "unavailable",
      model: verifier.model,
      reason: "层级补采失败且验证模型不支持截图。",
      failedItems: [],
      stale
    };
  }
  const screen = formatScreenForPrompt(nodes, PROMPT_MAX_ELEMENTS, null);
  const prompt = buildVerificationPrompt(
    record.taskDesc,
    claimedSummary,
    screen,
    stale,
    scriptUnresolved,
    scriptDeferredCount,
    preflightUnmatched
  );
  const messages: ChatMessage[] = [
    { role: "system", content: "你是严格的移动端测试验证器，只输出 JSON。" },
    {
      role: "user",
      content:
        verifier.vision && screenshot
          ? [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${screenshot.toString("base64")}` }
              }
            ]
          : prompt
    }
  ];
  let content: string;
  try {
    content = await verifier.chat(messages);
  } catch (error) {
    return {
      status: "unavailable",
      model: verifier.model,
      reason: `验证调用失败：${errorMessage(error)}`,
      failedItems: [],
      stale
    };
  }
  const parsed = parseVerification(content);
  if (!parsed) {
    return {
      status: "unavailable",
      model: verifier.model,
      reason: "验证响应不可解析。",
      failedItems: [],
      stale
    };
  }
  if (!parsed.pass && parsed.failedItems.length === 0) {
    return {
      status: "unavailable",
      model: verifier.model,
      reason: "验证判定失败但未给出具体失效项。",
      failedItems: [],
      stale
    };
  }
  if (parsed.pass) {
    return { status: "passed", model: verifier.model, reason: parsed.reason, failedItems: [], stale };
  }
  return {
    status: "failed",
    model: verifier.model,
    reason: parsed.reason || "验证判定任务未完成。",
    failedItems: parsed.failedItems,
    stale
  };
}
