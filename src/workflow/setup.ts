import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import { makeChatFn, type ChatMessage } from "../llm/chat.js";
import { log as logInfo } from "../log.js";
import {
  penEnvFrom,
  penExec,
  resolvePenCliPath,
  stripAnsi,
  type PenExecFn,
  type PenExecResult
} from "../pen/cli.js";
import { ENV_FIGMA_TOKEN } from "../projects/scan.js";

export type SetupTarget = "figma" | "pen" | "llm" | "device";

/** 前置检查结果：就绪＝null；SetupNeed＝预期缺失（非错误，供 needs-setup 结构化返回）。 */
export interface SetupNeed {
  target: SetupTarget;
  missing: string[];
  howTo: string[];
  note?: string;
}

export interface SetupDeps {
  exec?: PenExecFn;
  env?: NodeJS.ProcessEnv;
  chat?: (messages: ChatMessage[], signal?: AbortSignal) => Promise<string>;
  penTimeoutMs?: number;
  llmTimeoutMs?: number;
  log?: (line: string) => void;
}

const DEFAULT_PEN_TIMEOUT_MS = 10_000;
const DEFAULT_LLM_TIMEOUT_MS = 15_000;

const PEN_LOGGED_OUT_RE = /not logged in|未登录|please (run )?["'`]?pen login/i;
const PEN_SPAWN_FAILURE_RE = /ENOENT|EACCES|not found|no such file/i;

function hasValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function checkFigma(runtime: Runtime): SetupNeed | null {
  const dotenv = runtime.project.dotenvValues ?? {};
  if (hasValue(dotenv[ENV_FIGMA_TOKEN]) || hasValue(process.env[ENV_FIGMA_TOKEN])) return null;
  return {
    target: "figma",
    missing: [ENV_FIGMA_TOKEN],
    howTo: ["aos_configure(figmaToken=…) 或写项目 .env"]
  };
}

function penCliMissingNeed(detail: string): SetupNeed {
  return {
    target: "pen",
    missing: ["pen CLI"],
    howTo: [
      "首次调用 pen 工具会自动托管安装到 ~/.aos/pen-cli（Node ≥ 22.19，需网络）",
      "自动安装不可用时需预装：npm install -g @pen.dev/cli（AOS_PEN_NO_INSTALL=1 时属此情况）",
      "或用 AOS_PEN_CLI_PATH 指向已有 pen 二进制路径"
    ],
    note: `pen status 无法执行：${detail}`
  };
}

function penAuthNeed(summary: string): SetupNeed {
  return {
    target: "pen",
    missing: ["pen 登录状态"],
    howTo: [
      "运行 pen login 登录 pen.dev 账号",
      "或在项目 .env 写 PEN_CLI_KEY（pen.dev 组织设置 → Developer Keys）"
    ],
    note: `pen status：${summary}`
  };
}

function penTimeoutNeed(timeoutMs: number): SetupNeed {
  return {
    target: "pen",
    missing: ["pen 登录状态（pen status 超时）"],
    howTo: [
      "运行 pen login 登录 pen.dev 账号（若尚未登录）",
      "或在项目 .env 写 PEN_CLI_KEY（pen.dev 组织设置 → Developer Keys）",
      `若 pen CLI 本身异常：手动执行 pen status 排查（AOS_PEN_TIMEOUT_MS 可调，本次 ${timeoutMs}ms）`
    ],
    note: `pen status：超时（${timeoutMs}ms）`
  };
}

export async function checkPen(runtime: Runtime, deps: SetupDeps = {}): Promise<SetupNeed | null> {
  const env = penEnvFrom(runtime.project.dotenvValues ?? {}, deps.env ?? process.env);
  if (env.PEN_CLI_KEY) return null;

  const cli = resolvePenCliPath(env);
  const exec = deps.exec ?? penExec;
  const timeoutMs = deps.penTimeoutMs ?? DEFAULT_PEN_TIMEOUT_MS;
  let result: PenExecResult;
  try {
    result = await exec(cli.path, ["status"], { timeoutMs, env });
  } catch (error) {
    result = { code: null, stdout: "", stderr: "", error: errorMessage(error) };
  }

  if (result.error === "timeout") return penTimeoutNeed(timeoutMs);
  if (result.error && PEN_SPAWN_FAILURE_RE.test(result.error)) return penCliMissingNeed(result.error);

  const log = stripAnsi(`${result.stdout}\n${result.stderr}`).trim();
  const loggedOut = PEN_LOGGED_OUT_RE.exec(log);
  if (loggedOut) return penAuthNeed(loggedOut[0].trim());
  if (result.code !== 0) {
    return penAuthNeed(`退出码 ${result.code ?? "null"}${result.error ? `（${result.error}）` : ""}`);
  }
  return null;
}

function llmConfigNeed(detail: string | null): SetupNeed {
  return {
    target: "llm",
    missing: [detail ?? "LLM 配置（model / base_url / api_key）"],
    howTo: [
      "调用 aos_configure 配置 model / base_url / api_key（写入项目 .env 与数据库）",
      "或在项目 .env 写 AOS_LLM_MODEL / AOS_LLM_API_KEY / AOS_LLM_BASE_URL"
    ]
  };
}

function llmPingNeed(name: string, detail: string): SetupNeed {
  return {
    target: "llm",
    missing: [`LLM 连通性（${name} ping 未通过）`],
    howTo: [
      "核对 model / base_url / api_key 是否正确（aos_configure 或项目 .env）",
      "检查网络与代理是否可达 base_url（防火墙 / VPN / 代理设置）"
    ],
    note: `ping 失败：${detail}`
  };
}

/** 每次调用都对 active 条目做一次真实 ping（llmTimeoutMs 短超时），不做跨调用缓存；
 * ping 与后续真实调用分离。 */
export async function checkLlm(runtime: Runtime, deps: SetupDeps = {}): Promise<SetupNeed | null> {
  const entry = await runtime.activeEntry();
  if (!entry) return llmConfigNeed(null);
  if (!hasValue(entry.model) || !hasValue(entry.baseUrl) || !hasValue(entry.apiKey)) {
    const missing = [
      ...(hasValue(entry.model) ? [] : ["model"]),
      ...(hasValue(entry.baseUrl) ? [] : ["base_url"]),
      ...(hasValue(entry.apiKey) ? [] : ["api_key"])
    ];
    return llmConfigNeed(`LLM 条目「${entry.name}」缺 ${missing.join(" / ")}`);
  }

  const chat = deps.chat ?? makeChatFn({ baseUrl: entry.baseUrl, apiKey: entry.apiKey, model: entry.model });
  const timeoutMs = deps.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const logLine = deps.log ?? logInfo;
  const startedAtMs = Date.now();
  let reply: string;
  try {
    reply = await chat([{ role: "user", content: "ping" }], AbortSignal.timeout(timeoutMs));
  } catch (error) {
    const detail = errorMessage(error);
    logLine(`LLM ping 失败 model=${entry.model} ms=${Date.now() - startedAtMs}：${detail}`);
    return llmPingNeed(entry.name, detail);
  }
  const elapsedMs = Date.now() - startedAtMs;
  if (reply.trim() === "") {
    logLine(`LLM ping 失败 model=${entry.model} ms=${elapsedMs}：空响应`);
    return llmPingNeed(entry.name, "空响应");
  }
  logLine(`LLM ping 通过 model=${entry.model} ms=${elapsedMs}`);
  return null;
}
