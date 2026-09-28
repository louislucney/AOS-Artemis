import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";

import type { AosConfig, ArtemisConfig, FigmaConfig, InstallConfig, LlmProfile } from "./types.js";
import { DEFAULT_CONFIG_DIR } from "./types.js";
import { makeResolver, validateConfig, type ValidationResult, type ValueResolver } from "./validate.js";

export const CONFIG_FILENAME = "aos.config.jsonc";

export interface LoadedProject {
  rootDir: string;
  configPath: string | null;
  config: AosConfig;
  dotenvValues: Record<string, string>;
  resolver: ValueResolver;
  validation: ValidationResult;
}

export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ProjectResolution {
  rootDir: string;
  configPath: string | null;
}

export function emptyConfig(): AosConfig {
  return { llm: { profiles: {} }, artemis: { repo: "" } };
}

/** Default artemis repo: the `artemis/` directory next to the service install. */
export function defaultArtemisRepo(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // <root>/dist/config
    return path.resolve(here, "..", "..", "artemis");
  } catch {
    return path.resolve(process.cwd(), "artemis");
  }
}

/** Resolve the project root + optional config file.
 * Order: AOS_CONFIG > AOS_PROJECT_DIR > upward walk for aos.config.jsonc > cwd. */
export function resolveProject(opts: DiscoveryOptions = {}): ProjectResolution {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const explicitConfig = env.AOS_CONFIG?.trim();
  if (explicitConfig) {
    const resolved = path.resolve(explicitConfig);
    if (!fs.existsSync(resolved)) {
      throw new Error(`AOS_CONFIG 指向的文件不存在: ${resolved}`);
    }
    return { rootDir: path.dirname(resolved), configPath: resolved };
  }

  const projectDir = env.AOS_PROJECT_DIR?.trim();
  if (projectDir) {
    const rootDir = path.resolve(projectDir);
    const candidate = path.join(rootDir, CONFIG_FILENAME);
    return { rootDir, configPath: fs.existsSync(candidate) ? candidate : null };
  }

  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return { rootDir: dir, configPath: candidate };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { rootDir: path.resolve(cwd), configPath: null };
}

export function parseConfigFile(configPath: string): AosConfig {
  const raw = fs.readFileSync(configPath, "utf-8");
  const errors: ParseError[] = [];
  const data: unknown = parseJsonc(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(
      `Invalid JSONC in ${configPath}: ${printParseErrorCode(first.error)} at offset ${first.offset}`
    );
  }
  return normalizeConfig(data);
}

export function normalizeConfig(data: unknown): AosConfig {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${CONFIG_FILENAME} must be a JSON object`);
  }
  const obj = data as Record<string, unknown>;

  const llmRaw = obj.llm;
  let defaultProfile: string | undefined;
  const profiles: Record<string, LlmProfile> = {};
  if (llmRaw !== undefined && llmRaw !== null) {
    if (typeof llmRaw !== "object" || Array.isArray(llmRaw)) {
      throw new Error(`${CONFIG_FILENAME}: "llm" must be an object`);
    }
    const llmObj = llmRaw as Record<string, unknown>;
    if (typeof llmObj.defaultProfile === "string") defaultProfile = llmObj.defaultProfile;
    const profilesRaw = llmObj.profiles;
    if (profilesRaw !== undefined && profilesRaw !== null) {
      if (typeof profilesRaw !== "object" || Array.isArray(profilesRaw)) {
        throw new Error(`${CONFIG_FILENAME}: "llm.profiles" must be an object`);
      }
      for (const [name, value] of Object.entries(profilesRaw as Record<string, unknown>)) {
        profiles[name] = value as LlmProfile;
      }
    }
  }

  const artemisRaw = obj.artemis;
  let artemis: ArtemisConfig = { repo: "" };
  if (artemisRaw !== undefined && artemisRaw !== null) {
    if (typeof artemisRaw !== "object" || Array.isArray(artemisRaw)) {
      throw new Error(`${CONFIG_FILENAME}: "artemis" must be an object`);
    }
    artemis = { ...(artemisRaw as ArtemisConfig) };
    if (artemis.repo === undefined || artemis.repo === null) artemis.repo = "";
  }

  return {
    llm: { defaultProfile, profiles },
    figma: (obj.figma as FigmaConfig | undefined) ?? undefined,
    artemis,
    install: (obj.install as InstallConfig | undefined) ?? undefined
  };
}

/** Parse the project .env (no overrides; process env wins at resolution time). */
export function loadDotenvValues(rootDir: string): Record<string, string> {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) return {};
  try {
    return dotenv.parse(fs.readFileSync(envPath, "utf-8"));
  } catch {
    return {};
  }
}

export function loadProject(opts: DiscoveryOptions = {}): LoadedProject {
  const env = opts.env ?? process.env;
  const { rootDir, configPath } = resolveProject(opts);

  const config = configPath ? parseConfigFile(configPath) : emptyConfig();

  // Resolve artemis repo: config value > AOS_ARTEMIS_REPO env > service-relative default.
  const configuredRepo = config.artemis.repo?.trim();
  const envRepo = env.AOS_ARTEMIS_REPO?.trim();
  config.artemis.repo = configuredRepo
    ? path.resolve(rootDir, configuredRepo)
    : envRepo
      ? path.resolve(envRepo)
      : defaultArtemisRepo();
  config.artemis.configDir = config.artemis.configDir ?? DEFAULT_CONFIG_DIR;

  const dotenvValues = loadDotenvValues(rootDir);
  const resolver = makeResolver(dotenvValues, env);
  const validation = configPath
    ? validateConfig(config, resolver)
    : { errors: [], warnings: [] };

  return { rootDir, configPath, config, dotenvValues, resolver, validation };
}
