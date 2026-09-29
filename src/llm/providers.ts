export interface ProviderPreset {
  id: string;
  label: string;
  /** OpenAI-compatible root URL (no trailing slash); models list lives at `${baseUrl}/models`. */
  baseUrl: string;
  docsUrl: string;
  keyEnv: string;
  /** Vendor-stable alias names, most preferred first. A replacement is only
   * ever proposed when the alias is present in the freshly fetched list. */
  aliasModels: string[];
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    docsUrl: "https://api-docs.deepseek.com/zh-cn/",
    keyEnv: "DEEPSEEK_API_KEY",
    aliasModels: ["deepseek-flash", "deepseek-v4-pro"]
  },
  {
    id: "qwen",
    label: "阿里云百炼（通义千问）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    docsUrl: "https://help.aliyun.com/zh/model-studio/",
    keyEnv: "DASHSCOPE_API_KEY",
    aliasModels: ["qwen-plus", "qwen-flash"]
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    docsUrl: "https://open.bigmodel.cn/dev/howuse/introduction",
    keyEnv: "ZHIPU_API_KEY",
    aliasModels: ["glm-4-flash"]
  },
  {
    id: "moonshot",
    label: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    docsUrl: "https://platform.moonshot.cn/docs",
    keyEnv: "MOONSHOT_API_KEY",
    aliasModels: ["moonshot-v1-8k"]
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    docsUrl: "https://docs.siliconflow.cn",
    keyEnv: "SILICONFLOW_API_KEY",
    aliasModels: []
  },
  {
    id: "stepfun",
    label: "阶跃星辰",
    baseUrl: "https://api.stepfun.com/v1",
    docsUrl: "https://platform.stepfun.com/docs/overview/concept",
    keyEnv: "STEPFUN_API_KEY",
    aliasModels: ["step-2-mini"]
  },
  {
    id: "ark",
    label: "火山方舟（豆包）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    docsUrl: "https://www.volcengine.com/docs/82379",
    keyEnv: "ARK_API_KEY",
    aliasModels: []
  },
  {
    id: "hunyuan",
    label: "腾讯混元",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    docsUrl: "https://cloud.tencent.com/document/product/1729",
    keyEnv: "HUNYUAN_API_KEY",
    aliasModels: ["hunyuan-lite"]
  }
];

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").toLowerCase();
}

export function providerPresetById(id: string): ProviderPreset | null {
  const wanted = id.trim().toLowerCase();
  return PROVIDER_PRESETS.find((preset) => preset.id === wanted) ?? null;
}

export function providerPresetForBaseUrl(baseUrl: string | null | undefined): ProviderPreset | null {
  if (!baseUrl || baseUrl.trim() === "") return null;
  const normalized = normalizeBaseUrl(baseUrl);
  return (
    PROVIDER_PRESETS.find((preset) => normalizeBaseUrl(preset.baseUrl) === normalized) ?? null
  );
}

export function presetSummary(preset: ProviderPreset): {
  id: string;
  label: string;
  baseUrl: string;
  docsUrl: string;
  keyEnv: string;
  aliasModels: string[];
} {
  return {
    id: preset.id,
    label: preset.label,
    baseUrl: preset.baseUrl,
    docsUrl: preset.docsUrl,
    keyEnv: preset.keyEnv,
    aliasModels: [...preset.aliasModels]
  };
}
