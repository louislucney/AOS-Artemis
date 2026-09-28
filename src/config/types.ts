export const PROVIDER_IDS = ["google", "openai", "custom", "anthropic", "openrouter", "xai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Where the user stores the key (source variable, resolved from process env or project .env). */
export const DEFAULT_API_KEY_ENV: Record<ProviderId, string> = {
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  custom: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPEN_ROUTER_API_KEY",
  xai: "XAI_API_KEY"
};

/** The variable name artemis actually reads at runtime (router.py), per provider.
 * For `custom` (OpenAI-compatible endpoints: DeepSeek/Ollama/vLLM/proxies) artemis
 * reads OPENAI_API_KEY + OPENAI_BASE_URL. */
export const ARTEMIS_KEY_ENV: Record<ProviderId, string> = {
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  custom: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPEN_ROUTER_API_KEY",
  xai: "XAI_API_KEY"
};

export const GOOGLE_KEY_ENV_CANDIDATES = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

/** Nodes pinned to Google models by artemis' base config (config/artemis.jsonc).
 * A non-Google profile must explicitly override (or null-disable) all of them,
 * otherwise llm_switch is blocked — see DESIGN.md §5.2. */
export const PINNED_GOOGLE_NODES = ["object_detector", "hopper"] as const;

export interface LlmFallback {
  provider: ProviderId;
  model: string;
}

export interface LlmProfile {
  provider: ProviderId;
  model: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  baseUrlEnv?: string;
  thinking_level?: "minimal" | "low" | "medium" | "high";
  thinking_budget?: number;
  reasoning_effort?: "none" | "low" | "medium" | "high";
  include_thoughts?: boolean;
  enable_grounding?: boolean;
  fallback?: LlmFallback;
  nodeOverrides?: Record<string, unknown>;
}

export interface LlmConfig {
  defaultProfile?: string;
  profiles: Record<string, LlmProfile>;
}

export interface FigmaConfig {
  tokenEnv?: string;
}

export interface ArtemisConfig {
  repo: string;
  python?: string;
  mode?: "standalone";
  configDir?: string;
  deviceSerial?: string | null;
  /** Optional: artemis dependency bundle (tar.gz) URL for first-run installs.
   * env AOS_ARTEMIS_DEPS_URL / AOS_ARTEMIS_DEPS_SHA256 take precedence. */
  depsUrl?: string;
  depsSha256?: string;
}

export interface InstallConfig {
  targets?: string[];
}

export interface AosConfig {
  llm: LlmConfig;
  figma?: FigmaConfig;
  artemis: ArtemisConfig;
  install?: InstallConfig;
}

export const FIGMA_BRIDGE_PORT = 3055;
export const DEFAULT_FIGMA_TOKEN_ENV = "FIGMA_ACCESS_TOKEN";
export const DEFAULT_CONFIG_DIR = ".artemis";
