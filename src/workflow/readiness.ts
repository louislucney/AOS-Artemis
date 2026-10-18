import { penEnvFrom, resolvePenCliPath } from "../pen/cli.js";
import type { Runtime } from "../runtime.js";
import { errorMessage, maskSecret } from "../util.js";
import { checkFigma } from "./setup.js";

/** 静态就绪探针（project_archive）：只做存在性/配置解析——不触网、不跑子进程、不写盘；
 * 每项显式 `verified: false`（未复核）；真实复核属各流程工具首步（D14）。 */

export interface StaticReadinessDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}

export interface ReadinessReport {
  figma: { ready: boolean; missing: string[]; detail: string; verified: false };
  pen: { ready: boolean; detail: string; verified: false };
  jira: {
    ready: boolean;
    missing: string[];
    site: string | null;
    email: string | null;
    detail: string;
    verified: false;
  };
  llm: {
    ready: boolean;
    missing: string[];
    name: string | null;
    model: string | null;
    baseUrl: string | null;
    key: string | null;
    detail: string;
    verified: false;
  };
  degraded: string[];
}

function hasValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export async function staticReadiness(
  runtime: Runtime,
  deps: StaticReadinessDeps = {}
): Promise<ReadinessReport> {
  const degraded: string[] = [];

  const figmaNeed = checkFigma(runtime);
  const figma: ReadinessReport["figma"] =
    figmaNeed === null
      ? { ready: true, missing: [], detail: "FIGMA_ACCESS_TOKEN 已配置（未复核）", verified: false }
      : { ready: false, missing: figmaNeed.missing, detail: "缺 FIGMA_ACCESS_TOKEN", verified: false };

  const env = penEnvFrom(runtime.project.dotenvValues ?? {}, deps.env ?? process.env);
  let pen: ReadinessReport["pen"];
  if (hasValue(env.PEN_CLI_KEY)) {
    pen = { ready: true, detail: "PEN_CLI_KEY 已配置（登录状态未复核）", verified: false };
  } else {
    const cli = resolvePenCliPath(
      env,
      deps.platform ?? process.platform,
      deps.exists ? { exists: deps.exists } : {}
    );
    if (cli.source === "env") {
      pen = { ready: true, detail: `AOS_PEN_CLI_PATH=${cli.path}（登录状态未复核）`, verified: false };
    } else if (cli.source === "managed") {
      pen = { ready: true, detail: `托管安装：${cli.path}（登录状态未复核）`, verified: false };
    } else {
      pen = {
        ready: false,
        detail:
          "未检测到 pen 配置（PATH 兜底未复核；howTo：pen login / 项目 .env 写 PEN_CLI_KEY / AOS_PEN_CLI_PATH；首次调用可自动托管安装）",
        verified: false
      };
    }
  }

  const jiraConfig = runtime.jiraConfig();
  const email = jiraConfig.email === null ? null : maskSecret(jiraConfig.email);
  const jira: ReadinessReport["jira"] = jiraConfig.configured
    ? {
        ready: true,
        missing: jiraConfig.missing,
        site: jiraConfig.siteUrl,
        email,
        detail: `站点 ${jiraConfig.siteUrl}（凭证未复核）`,
        verified: false
      }
    : {
        ready: false,
        missing: jiraConfig.missing,
        site: jiraConfig.siteUrl,
        email,
        detail: `缺 ${jiraConfig.missing.join(" / ")}`,
        verified: false
      };

  let llm: ReadinessReport["llm"];
  try {
    const entry = await runtime.activeEntry();
    if (entry === null) {
      llm = {
        ready: false,
        missing: ["model", "base_url", "api_key"],
        name: null,
        model: null,
        baseUrl: null,
        key: null,
        detail: "未配置（aos_configure / 项目 .env）",
        verified: false
      };
    } else {
      const missing = [
        ...(hasValue(entry.model) ? [] : ["model"]),
        ...(hasValue(entry.baseUrl) ? [] : ["base_url"]),
        ...(hasValue(entry.apiKey) ? [] : ["api_key"])
      ];
      llm = {
        ready: missing.length === 0,
        missing,
        name: entry.name,
        model: entry.model,
        baseUrl: entry.baseUrl,
        key: entry.apiKey === null ? null : maskSecret(entry.apiKey),
        detail:
          missing.length === 0
            ? `条目「${entry.name}」（未复核）`
            : `条目「${entry.name}」缺 ${missing.join(" / ")}（未复核）`,
        verified: false
      };
    }
  } catch (error) {
    const detail = errorMessage(error);
    degraded.push(`LLM 条目读取降级：${detail}`);
    llm = {
      ready: false,
      missing: [],
      name: null,
      model: null,
      baseUrl: null,
      key: null,
      detail: `LLM 条目读取降级：${detail}（未复核）`,
      verified: false
    };
  }

  return { figma, pen, jira, llm, degraded };
}
