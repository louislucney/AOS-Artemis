import type { ProjectStore } from "../db/types.js";
import type { DesignConfig } from "../config/types.js";

/** Minimal LLM entry the design pipeline needs (active entry shape). */
export interface DesignLlmEntry {
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
}

/** Runtime surface used by design extraction/generation.
 *
 * The MCP path passes a full `Runtime`; the CMS open service supplies a per-job
 * object so credentials never fall back to process env / project `.env`. */
export interface DesignRuntimeLike {
  configDirAbs: string;
  project: {
    rootDir: string;
    dotenvValues?: Record<string, string>;
    config?: { design?: DesignConfig };
  };
  store: ProjectStore;
  /** Only called when no explicit `chat` is injected; the open service always injects. */
  activeEntry?: () => Promise<DesignLlmEntry | null>;
}

/** Per-request design dependencies (Figma token / explicit chat). */
export interface DesignDeps {
  figmaToken?: string | null;
  chat?: import("../llm/chat.js").ChatFn;
}
