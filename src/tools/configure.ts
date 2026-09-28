import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { writeEnvUpdates } from "../env-file.js";
import { syncFigmaTokenEnv } from "../figma/token.js";
import { ENV_FIGMA_TOKEN, ENV_LLM_API_KEY, ENV_LLM_BASE_URL, ENV_LLM_MODEL, ENV_LLM_NAME } from "../projects/scan.js";
import { errorMessage, maskSecret } from "../util.js";
import type { Runtime } from "../runtime.js";

export interface ConfigureArgs {
  model: string;
  baseUrl: string;
  apiKey: string;
  name?: string;
  makeActive?: boolean;
  writeEnv?: boolean;
  force?: boolean;
  figmaToken?: string;
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError
  };
}

/** Setup entry point: AI collects the project's OpenAI-compatible LLM triple,
 * persists it (store or session memory), writes the project .env, activates it. */
export async function aosConfigure(runtime: Runtime, args: ConfigureArgs): Promise<CallToolResult> {
  const model = args.model?.trim();
  const baseUrl = args.baseUrl?.trim();
  const apiKey = args.apiKey?.trim();

  if (!model || !baseUrl || !apiKey) {
    return jsonResult(
      {
        ok: false,
        error: "model / baseUrl / apiKey 均为必填（项目级 OpenAI 兼容 LLM 三元组）。"
      },
      true
    );
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return jsonResult({ ok: false, error: `baseUrl 必须是 http(s) URL：${baseUrl}` }, true);
  }

  const name = args.name?.trim() || model;
  const makeActive = args.makeActive ?? true;
  const writeEnv = args.writeEnv ?? true;
  const warnings: string[] = [];

  let stored = false;
  try {
    await runtime.store.upsertLlm(runtime.project.rootDir, {
      name,
      provider: "custom",
      model,
      baseUrl,
      apiKey,
      makeActive: false
    });
    stored = true;
  } catch (error) {
    warnings.push(`存储写入失败（${errorMessage(error)}）：条目将依赖 .env 与会话内存。`);
  }

  let envPath: string | null = null;
  const figmaToken = args.figmaToken?.trim();
  if (writeEnv) {
    const updates: Record<string, string> = {
      [ENV_LLM_NAME]: name,
      [ENV_LLM_MODEL]: model,
      [ENV_LLM_BASE_URL]: baseUrl,
      [ENV_LLM_API_KEY]: apiKey
    };
    if (figmaToken) updates[ENV_FIGMA_TOKEN] = figmaToken;
    envPath = writeEnvUpdates(runtime.project.rootDir, updates);
  }
  if (figmaToken) {
    try {
      await runtime.store.setFigmaToken(runtime.project.rootDir, figmaToken);
      syncFigmaTokenEnv(figmaToken);
    } catch (error) {
      warnings.push(`Figma token 存储失败（${errorMessage(error)}）。`);
    }
  }

  runtime.refreshProjectEnv();

  let activation = null;
  if (makeActive) {
    activation = await runtime.activateEntry(name, { force: args.force === true });
    if (!activation.ok) warnings.push(...activation.warnings);
  }

  return jsonResult({
    ok: true,
    name,
    stored,
    envPath,
    activated: activation?.ok ?? false,
    activation,
    maskedKey: maskSecret(apiKey),
    warnings
  });
}
