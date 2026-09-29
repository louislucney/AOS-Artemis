import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { writeEnvUpdates } from "../env-file.js";
import { syncFigmaTokenEnv } from "../figma/token.js";
import { PROVIDER_PRESETS, providerPresetById } from "../llm/providers.js";
import { ENV_FIGMA_TOKEN, ENV_LLM_API_KEY, ENV_LLM_BASE_URL, ENV_LLM_MODEL, ENV_LLM_NAME } from "../projects/scan.js";
import { errorMessage, maskSecret } from "../util.js";
import type { Runtime } from "../runtime.js";

export interface ConfigureArgs {
  model?: string;
  baseUrl?: string;
  apiKey: string;
  name?: string;
  vendor?: string;
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
 * persists it (store or session memory), writes the project .env, activates it.
 * A `vendor` preset can fill baseUrl and pick a current model via /models. */
export async function aosConfigure(runtime: Runtime, args: ConfigureArgs): Promise<CallToolResult> {
  const apiKey = args.apiKey?.trim();
  if (!apiKey) {
    return jsonResult({ ok: false, error: "apiKey 为必填（项目级 OpenAI 兼容 LLM key）。" }, true);
  }

  let preset = null;
  if (args.vendor?.trim()) {
    preset = providerPresetById(args.vendor);
    if (!preset) {
      return jsonResult(
        {
          ok: false,
          error: `未知 vendor "${args.vendor}"。可选：${PROVIDER_PRESETS.map((item) => item.id).join(", ")}`
        },
        true
      );
    }
  }

  let model = args.model?.trim() ?? "";
  const baseUrl = args.baseUrl?.trim() || preset?.baseUrl || "";
  if (!baseUrl) {
    return jsonResult(
      { ok: false, error: "baseUrl 为必填（也可提供 vendor 预设名自动填充，如 deepseek）。" },
      true
    );
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return jsonResult({ ok: false, error: `baseUrl 必须是 http(s) URL：${baseUrl}` }, true);
  }

  const warnings: string[] = [];
  let fetched: { fetchedAt: string; models: string[] } | null = null;
  const shouldFetch = model === "" || preset !== null || args.baseUrl === undefined;
  if (shouldFetch) {
    const result = await runtime.modelCatalog.fetchIds(baseUrl, apiKey);
    if (result.ok && result.models.length > 0) {
      fetched = { fetchedAt: new Date().toISOString(), models: result.models };
    } else if (!result.ok) {
      warnings.push(`模型列表刷新失败（${result.error}）。`);
    }
  }

  if (model === "") {
    const alias = preset?.aliasModels.find((candidate) =>
      fetched?.models.some((id) => id.toLowerCase() === candidate.toLowerCase())
    );
    if (alias) {
      model = alias;
      warnings.push(`未提供 model：已按 ${preset!.label} 稳定别名选择 "${alias}"。`);
    } else if (fetched) {
      model = fetched.models[0]!;
      warnings.push(`未提供 model：已选择列表首项 "${model}"，请确认是否合适。`);
    } else {
      return jsonResult(
        {
          ok: false,
          error: `未提供 model，且无法从 ${baseUrl}/models 获取列表：请显式提供 model（或配置可用的 apiKey 后重试）。`,
          vendor: preset ? preset.id : undefined,
          warnings
        },
        true
      );
    }
  } else if (fetched && !fetched.models.some((id) => id.toLowerCase() === model.toLowerCase())) {
    warnings.push(
      `model "${model}" 不在 ${baseUrl} 的最新列表（${fetched.models.length} 个）中：可能已下线，请用 llm_models 核对。`
    );
  }

  if (fetched) {
    try {
      await runtime.store.putModelCache(runtime.project.rootDir, {
        cacheKey: runtime.modelCatalog.cacheKey(baseUrl, apiKey),
        baseUrl,
        models: fetched.models,
        fetchedAt: fetched.fetchedAt,
        lastError: null
      });
    } catch (error) {
      warnings.push(`模型列表缓存写入失败（${errorMessage(error)}）。`);
    }
  }

  const name = args.name?.trim() || model;
  const makeActive = args.makeActive ?? true;
  const writeEnv = args.writeEnv ?? true;

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
    model,
    vendor: preset ? preset.id : null,
    stored,
    envPath,
    activated: activation?.ok ?? false,
    activation,
    maskedKey: maskSecret(apiKey),
    modelsFetched: fetched ? fetched.models.length : 0,
    warnings
  });
}
