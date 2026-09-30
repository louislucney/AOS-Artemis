import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import { detectPenFailure, penEnvFrom, runPenCli, type PenExecFn } from "./cli.js";
import { ensurePenCli, type PenEnsureFn } from "./install.js";
import { loadPenDocument, PEN_HINT, penRelativePath, resolvePenTarget } from "./paths.js";
import { parsePenText } from "./read.js";

export interface PenAgentArgs {
  path?: string;
  out?: string;
  prompt: string;
  agent?: "claude" | "codex" | "gemini";
  model?: string;
  effort?: string;
  anthropicBaseUrl?: string;
  custom?: boolean;
  exportPath?: string;
  exportType?: "png" | "jpeg" | "webp" | "pdf";
  exportScale?: number;
  maxFailedCalls?: number;
  dryRun?: boolean;
  timeoutMs?: number;
}

export interface PenToolDeps {
  exec?: PenExecFn;
  ensure?: PenEnsureFn;
}

const AGENT_RESPONSE_MARKER = "--- Agent Response ---";
const AGENT_RESPONSE_END = "----------------------";
const MAX_RESPONSE_CHARS = 2000;

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

function displayPath(runtime: Runtime, absolute: string): string {
  const relative = path.relative(runtime.project.rootDir, absolute);
  return relative.startsWith("..") ? absolute : relative;
}

function tempOutputPath(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.aos-${process.pid}-${Date.now()}.tmp`);
}

export interface AnthropicBridge {
  id: string;
  label: string;
  /** Anthropic Messages endpoint derived from the entry's OpenAI-compatible base URL. */
  baseUrl: (url: URL) => string;
  /** `apiKey` → x-api-key via pen's PEN_AGENT_API_KEY; `authToken` → Authorization Bearer. */
  auth: "apiKey" | "authToken";
  /** Strict providers need model envs (docs require ANTHROPIC_MODEL/DEFAULT_* mappings). */
  modelEnvs: boolean;
  verified: boolean;
  docs: string;
}

const BRIDGES: AnthropicBridge[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: (url) => {
      const pathname = url.pathname.replace(/\/+$/, "");
      if (/\/anthropic$/i.test(pathname)) return `${url.origin}${pathname}`;
      return `${url.origin}${pathname.replace(/\/v\d+$/i, "")}/anthropic`;
    },
    auth: "apiKey",
    modelEnvs: false,
    verified: true,
    docs: "https://api-docs.deepseek.com/"
  },
  {
    id: "moonshot",
    label: "Moonshot AI / Kimi",
    baseUrl: () => "https://api.moonshot.cn/anthropic",
    auth: "authToken",
    modelEnvs: true,
    verified: false,
    docs: "https://platform.kimi.com/docs/guide/claude-code-kimi"
  },
  {
    id: "zai",
    label: "Z.AI / 智谱 GLM",
    baseUrl: (url) =>
      /(^|\.)z\.ai$/i.test(url.hostname) ? "https://api.z.ai/api/anthropic" : "https://open.bigmodel.cn/api/anthropic",
    auth: "authToken",
    modelEnvs: true,
    verified: false,
    docs: "https://docs.z.ai/scenario-example/develop-tools/claude"
  },
  {
    id: "qwen",
    label: "阿里云百炼 Qwen",
    baseUrl: () => "https://dashscope.aliyuncs.com/apps/anthropic",
    auth: "authToken",
    modelEnvs: true,
    verified: false,
    docs: "https://help.aliyun.com/zh/model-studio/claude-code"
  }
];

function hostMatches(hostname: string, domains: string[]): boolean {
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export function anthropicBridgeFor(
  baseUrl: string | null | undefined
): { bridge: AnthropicBridge; anthropicBaseUrl: string } | null {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\/+$/, "");
  try {
    const url = new URL(normalized);
    if (hostMatches(url.hostname, ["deepseek.com"])) {
      const bridge = BRIDGES[0]!;
      return { bridge, anthropicBaseUrl: bridge.baseUrl(url) };
    }
    if (hostMatches(url.hostname, ["moonshot.cn", "moonshot.ai", "kimi.com"])) {
      const bridge = BRIDGES[1]!;
      return { bridge, anthropicBaseUrl: bridge.baseUrl(url) };
    }
    if (hostMatches(url.hostname, ["z.ai", "bigmodel.cn"])) {
      const bridge = BRIDGES[2]!;
      return { bridge, anthropicBaseUrl: bridge.baseUrl(url) };
    }
    if (hostMatches(url.hostname, ["dashscope.aliyuncs.com"])) {
      const bridge = BRIDGES[3]!;
      return { bridge, anthropicBaseUrl: bridge.baseUrl(url) };
    }
    if (/\/anthropic$/i.test(url.pathname)) {
      return {
        bridge: { id: "custom-anthropic", label: "custom Anthropic endpoint", baseUrl: () => normalized, auth: "apiKey", modelEnvs: false, verified: false, docs: "" },
        anthropicBaseUrl: normalized
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** Kept for compatibility: Anthropic-compatible endpoint for the active LLM entry. */
export function anthropicBaseUrlFor(baseUrl: string | null | undefined): string | null {
  return anthropicBridgeFor(baseUrl)?.anthropicBaseUrl ?? null;
}

function agentKindFor(args: PenAgentArgs): "claude" | "codex" | "gemini" {
  if (args.agent) return args.agent;
  if (args.model?.startsWith("gemini")) return "gemini";
  if (args.model && /^(gpt|o\d|codex)/i.test(args.model)) return "codex";
  return "claude";
}

export interface AgentLlmEntry {
  apiKey: string | null;
  model: string | null;
  baseUrl: string | null;
}

export function buildAgentEnv(
  entry: AgentLlmEntry | null,
  args: PenAgentArgs,
  kind: "claude" | "codex" | "gemini",
  baseEnv: NodeJS.ProcessEnv = process.env
): { env: Record<string, string>; warnings: string[]; credential: Record<string, unknown> } {
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  const key = entry?.apiKey ?? null;
  const model = args.model ?? entry?.model ?? null;
  const explicitBase =
    args.anthropicBaseUrl?.trim() ||
    baseEnv.AOS_PEN_ANTHROPIC_BASE_URL?.trim() ||
    process.env.AOS_PEN_ANTHROPIC_BASE_URL?.trim() ||
    null;
  const derived = anthropicBridgeFor(entry?.baseUrl);
  const matched = explicitBase
    ? { bridge: derived?.bridge ?? null, anthropicBaseUrl: explicitBase }
    : derived;

  if (!key) {
    warnings.push("active LLM 未配置 key：pen agent 需要 PEN_AGENT_API_KEY（或 ANTHROPIC_API_KEY / pen codex-login）");
    return {
      env,
      warnings,
      credential: { provider: matched?.bridge?.id ?? null, anthropicBaseUrl: explicitBase, auth: null, model, verified: matched?.bridge?.verified ?? null }
    };
  }

  if (kind === "claude" && matched) {
    env.ANTHROPIC_BASE_URL = matched.anthropicBaseUrl;
    if (matched.bridge?.auth === "authToken") {
      env.ANTHROPIC_AUTH_TOKEN = key;
    } else {
      env.PEN_AGENT_API_KEY = key;
    }
    if (matched.bridge?.modelEnvs && model) {
      for (const name of [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL"
      ]) {
        env[name] = model;
      }
    }
    if (matched.bridge && !matched.bridge.verified) {
      warnings.push(
        `provider ${matched.bridge.label} 的 Anthropic 兼容端点按官方文档映射（${matched.bridge.docs}），尚未用真实 key 冒烟验证`
      );
    }
  } else {
    env.PEN_AGENT_API_KEY = key;
    if (kind === "claude") {
      warnings.push(
        "active LLM 未识别 Anthropic 兼容端点（DeepSeek/Kimi/Z.AI/百炼 以外）：key 将按 Anthropic API Key 注入，可用 anthropicBaseUrl 或 AOS_PEN_ANTHROPIC_BASE_URL 指定兼容端点"
      );
    }
  }
  return {
    env,
    warnings,
    credential: {
      provider: matched?.bridge?.id ?? null,
      anthropicBaseUrl: kind === "claude" ? matched?.anthropicBaseUrl ?? null : null,
      auth: kind === "claude" && matched ? matched.bridge?.auth ?? "apiKey" : "apiKey",
      model,
      verified: matched?.bridge?.verified ?? null
    }
  };
}

export function extractAgentResponse(log: string): string | null {
  const index = log.lastIndexOf(AGENT_RESPONSE_MARKER);
  if (index < 0) return null;
  const body = log.slice(index + AGENT_RESPONSE_MARKER.length);
  const end = body.indexOf(AGENT_RESPONSE_END);
  const text = (end >= 0 ? body.slice(0, end) : body).trim();
  return text ? text.slice(0, MAX_RESPONSE_CHARS) : null;
}

export async function penAgent(
  runtime: Runtime,
  args: PenAgentArgs,
  deps: PenToolDeps = {}
): Promise<CallToolResult> {
  try {
    const prompt = args.prompt?.trim();
    if (!prompt) {
      return jsonResult({ ok: false, error: "prompt 不能为空" }, true);
    }
    const target = resolvePenTarget(runtime, args.path);
    if (target) loadPenDocument(target);
    if (!target && !args.out) {
      return jsonResult(
        {
          ok: false,
          error: "没有输入 .pen 且未指定 out",
          hint: `${PEN_HINT}；新建设计请提供 out（输出 .pen 路径）。`
        },
        true
      );
    }

    const entry = await runtime.activeEntry();
    const kind = agentKindFor(args);
    const penEnv = penEnvFrom(runtime.project.dotenvValues, process.env);
    const { env: agentEnv, warnings, credential } = buildAgentEnv(
      entry ? { apiKey: entry.apiKey, model: entry.model, baseUrl: entry.baseUrl } : null,
      args,
      kind,
      penEnv
    );
    const env = { ...penEnv, ...agentEnv };
    const useCustom = kind === "claude" && credential.anthropicBaseUrl !== null && args.custom !== false;

    const inPlace = target !== null && args.out === undefined;
    const output = inPlace
      ? tempOutputPath(target!)
      : args.out
        ? path.resolve(runtime.project.rootDir, args.out)
        : null;
    if (!output) {
      return jsonResult({ ok: false, error: "需要 path（原位更新）或 out（新建/另存）" }, true);
    }

    const cliArgs: string[] = [];
    if (target) cliArgs.push("--in", target);
    cliArgs.push("--out", output, "--prompt", prompt);
    if (useCustom) cliArgs.push("--custom");
    if (args.agent) cliArgs.push("--agent", args.agent);
    if (args.model) cliArgs.push("--model", args.model);
    if (args.effort) cliArgs.push("--effort", args.effort);
    if (args.maxFailedCalls !== undefined) {
      cliArgs.push("--max-failed-calls", String(Math.max(1, Math.trunc(args.maxFailedCalls))));
    }
    if (args.exportPath) {
      const exportAbsolute = path.resolve(runtime.project.rootDir, args.exportPath);
      cliArgs.push("--export", exportAbsolute);
      if (args.exportType && args.exportType !== "png") cliArgs.push("--export-type", args.exportType);
      if (args.exportScale !== undefined) {
        const scale = Math.min(Math.max(Math.trunc(args.exportScale), 1), 4);
        cliArgs.push("--export-scale", String(scale));
      }
    }

    const payload: Record<string, unknown> = {
      ok: true,
      dryRun: args.dryRun === true,
      source: target ? penRelativePath(runtime, target) : null,
      output: displayPath(runtime, output),
      inPlace,
      prompt,
      agent: kind,
      model: args.model ?? null,
      anthropicBaseUrl: credential.anthropicBaseUrl ?? null,
      credential,
      custom: useCustom,
      llm: entry ? { name: entry.name, model: entry.model, baseUrl: entry.baseUrl } : null,
      warnings
    };
    if (args.dryRun === true) {
      return jsonResult({ ...payload, command: ["pen", ...cliArgs] });
    }

    const ready = await (deps.ensure ?? ensurePenCli)({ env });
    if (!ready.ok) {
      return jsonResult({ ...payload, ok: false, error: ready.error ?? "pen CLI 不可用", hint: ready.hint }, true);
    }

    const existedBefore = fs.existsSync(output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const started = Date.now();
    const run = await runPenCli(cliArgs, {
      env,
      timeoutMs: args.timeoutMs,
      exec: deps.exec,
      cliPath: ready.path ?? undefined
    });
    const failure = detectPenFailure(run.result, run.log);
    if (failure || !fs.existsSync(output)) {
      if (!existedBefore) {
        try {
          fs.rmSync(output, { force: true });
        } catch {
          /* best effort */
        }
      }
      return jsonResult(
        {
          ...payload,
          ok: false,
          error: failure ?? "pen agent 未产出文件（检查输入 .pen 与凭证）",
          log: run.log.slice(-2000),
          hint: PEN_HINT
        },
        true
      );
    }

    let parsed = true;
    try {
      parsePenText(fs.readFileSync(output, "utf-8"));
    } catch {
      parsed = false;
    }
    if (!parsed) {
      if (!existedBefore) {
        try {
          fs.rmSync(output, { force: true });
        } catch {
          /* best effort */
        }
      }
      return jsonResult(
        { ...payload, ok: false, error: "pen agent 输出不是有效的 .pen（未写盘）", log: run.log.slice(-2000) },
        true
      );
    }

    let finalPath = output;
    if (inPlace) {
      fs.renameSync(output, target!);
      finalPath = target!;
    }
    return jsonResult({
      ...payload,
      output: displayPath(runtime, finalPath),
      elapsedMs: Date.now() - started,
      agentResponse: extractAgentResponse(run.log)
    });
  } catch (error) {
    return jsonResult({ ok: false, error: `pen agent 执行失败: ${errorMessage(error)}`, hint: PEN_HINT }, true);
  }
}
