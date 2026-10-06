import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";

export const INSTALL_TARGETS = ["claude", "cursor", "vscode", "opencode"] as const;
export type InstallTarget = (typeof INSTALL_TARGETS)[number];

export const MCP_SERVER_NAME = "mobile-testing";
const LEGACY_SERVER_NAMES = ["aos", "android-testing"];

export interface InstallOptions {
  projectDir?: string;
  targets?: string[];
  mode?: "local" | "docker" | "http";
  container?: string;
  url?: string;
  serviceEntry?: string;
  force?: boolean;
  help?: boolean;
  log?: (line: string) => void;
}

type ServerEntry =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { kind: "http"; url: string };

interface TargetPlan {
  file: string;
  jsonPath: Array<string>;
  toValue: (entry: ServerEntry) => unknown;
}

function defaultServiceEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "index.js");
}

export function parseInstallArgs(argv: string[], defaults: InstallOptions = {}): Required<
  Pick<
    InstallOptions,
    "projectDir" | "targets" | "mode" | "container" | "url" | "serviceEntry" | "force" | "help"
  >
> {
  const options = {
    projectDir: defaults.projectDir ?? process.cwd(),
    targets: defaults.targets ?? [...INSTALL_TARGETS],
    mode: defaults.mode ?? ("local" as const),
    container: defaults.container ?? "aos-mcp",
    url: defaults.url ?? "http://127.0.0.1:8765",
    serviceEntry: defaults.serviceEntry ?? defaultServiceEntry(),
    force: defaults.force ?? false,
    help: defaults.help ?? false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--project": {
        const value = argv[++index];
        if (!value) throw new Error("--project 需要值");
        options.projectDir = path.resolve(value);
        break;
      }
      case "--targets": {
        const value = argv[++index];
        if (!value) throw new Error("--targets 需要值");
        const requested = value
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== "");
        const invalid = requested.filter(
          (item) => !(INSTALL_TARGETS as readonly string[]).includes(item)
        );
        if (invalid.length > 0) {
          throw new Error(`未知 target: ${invalid.join(", ")}（可选: ${INSTALL_TARGETS.join(", ")}）`);
        }
        options.targets = requested as InstallTarget[];
        break;
      }
      case "--mode": {
        const value = argv[++index];
        if (value !== "docker" && value !== "local" && value !== "http") {
          throw new Error(`未知 mode: ${value ?? "(缺值)"}（可选: local, docker, http）`);
        }
        options.mode = value;
        break;
      }
      case "--container": {
        const value = argv[++index];
        if (!value) throw new Error("--container 需要值");
        options.container = value;
        break;
      }
      case "--url": {
        const value = argv[++index];
        if (!value) throw new Error("--url 需要值");
        options.url = value;
        break;
      }
      case "--service": {
        const value = argv[++index];
        if (!value) throw new Error("--service 需要值");
        options.serviceEntry = path.resolve(value);
        break;
      }
      case "--force":
        options.force = true;
        break;
      default:
        throw new Error(`未知参数 ${arg}（用 --help 查看用法）`);
    }
  }
  return options;
}

export function installUsage(): string {
  return [
    "aos-mcp install — 为项目写入 MCP 客户端配置",
    "",
    "Usage:",
    "  aos-mcp install [options]",
    "",
    "options:",
    "  --project <dir>            目标项目（默认 cwd）",
    `  --targets <list>           逗号列表: ${INSTALL_TARGETS.join(",")}（默认全部）`,
    "  --mode local|docker|http   （默认 local）",
    "  --container <name>         docker 模式容器名（默认 aos-mcp）",
    "  --url <base>               http 模式基址（默认 http://127.0.0.1:8765）",
    "  --service <path>           local 模式服务入口（默认本安装 dist/index.js）",
    "  --force                    覆盖已有但不同的 aos 条目",
    "  -h, --help                 显示本帮助"
  ].join("\n");
}

function buildServerEntry(options: {
  mode: "local" | "docker" | "http";
  container: string;
  url: string;
  serviceEntry: string;
  projectDir: string;
}): ServerEntry {
  const projectName = path.basename(options.projectDir);
  if (options.mode === "http") {
    const base = options.url.replace(/\/+$/, "");
    return { kind: "http", url: `${base}/mcp/${encodeURIComponent(projectName)}` };
  }
  if (options.mode === "docker") {
    return {
      kind: "stdio",
      command: "docker",
      args: [
        "exec",
        "-i",
        "-w",
        `/workspace/${projectName}`,
        options.container,
        "node",
        "/app/dist/index.js"
      ],
      env: {}
    };
  }
  const env: Record<string, string> = { AOS_PROJECT_DIR: options.projectDir };
  const databaseUrl = process.env.AOS_DATABASE_URL?.trim();
  if (databaseUrl) env.AOS_DATABASE_URL = databaseUrl;
  // Carry explicit tool paths so CLI-spawned servers find adb/ffmpeg/traces
  // without relying on the client's PATH (artemis resolver Tier-1 overrides).
  for (const key of ["ARTEMIS_ADB_PATH", "ARTEMIS_TRACES_DIR", "ARTEMIS_DAEMON_PORT"]) {
    const value = process.env[key]?.trim();
    if (value) env[key] = value;
  }
  // Corporate networks: Node's fetch ignores *_PROXY unless NODE_USE_ENV_PROXY
  // is set (Node >= 24); carry whatever this shell had so model refresh and
  // Figma REST keep working under the client.
  for (const key of ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) {
    const value = process.env[key]?.trim();
    if (value) env[key] = value;
  }
  return { kind: "stdio", command: "node", args: [options.serviceEntry], env };
}

function targetPlan(target: InstallTarget, projectDir: string): TargetPlan {
  switch (target) {
    case "claude":
      return {
        file: path.join(projectDir, ".mcp.json"),
        jsonPath: ["mcpServers", MCP_SERVER_NAME],
        toValue: (entry) =>
          entry.kind === "http"
            ? { type: "http", url: entry.url }
            : { command: entry.command, args: entry.args, env: entry.env }
      };
    case "cursor":
      return {
        file: path.join(projectDir, ".cursor", "mcp.json"),
        jsonPath: ["mcpServers", MCP_SERVER_NAME],
        toValue: (entry) =>
          entry.kind === "http"
            ? { url: entry.url }
            : { command: entry.command, args: entry.args, env: entry.env }
      };
    case "vscode":
      return {
        file: path.join(projectDir, ".vscode", "mcp.json"),
        jsonPath: ["servers", MCP_SERVER_NAME],
        toValue: (entry) =>
          entry.kind === "http"
            ? { type: "http", url: entry.url }
            : { command: entry.command, args: entry.args, env: entry.env }
      };
    case "opencode":
      return {
        file: path.join(projectDir, "opencode.json"),
        jsonPath: ["mcp", MCP_SERVER_NAME],
        toValue: (entry) =>
          entry.kind === "http"
            ? { type: "remote", url: entry.url, enabled: true }
            : {
                type: "local",
                command: [entry.command, ...entry.args],
                environment: entry.env,
                enabled: true
              }
      };
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function getValueAt(text: string, jsonPath: Array<string>): { found: boolean; value: unknown } {
  const errors: ParseError[] = [];
  const root: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error("invalid JSONC");
  let current: unknown = root;
  for (const key of jsonPath) {
    if (!current || typeof current !== "object") return { found: false, value: undefined };
    const record = current as Record<string, unknown>;
    if (!(key in record)) return { found: false, value: undefined };
    current = record[key];
  }
  return { found: true, value: current };
}

export type WriteStatus = "written" | "unchanged" | "skipped_exists" | "invalid";

export function upsertJsoncFile(
  filePath: string,
  jsonPath: Array<string>,
  value: unknown,
  force: boolean
): WriteStatus {
  const exists = fs.existsSync(filePath);
  const text = exists ? fs.readFileSync(filePath, "utf-8") : "";
  const base = text.trim() === "" ? "{}\n" : text;

  let current: { found: boolean; value: unknown } = { found: false, value: undefined };
  try {
    current = getValueAt(base, jsonPath);
  } catch {
    return "invalid";
  }

  if (current.found) {
    if (stableStringify(current.value) === stableStringify(value)) return "unchanged";
    if (!force) return "skipped_exists";
  }

  const edits = modify(base, jsonPath, value, {
    formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" }
  });
  const output = applyEdits(base, edits);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, output, "utf-8");
  return "written";
}

export function removeJsoncPath(filePath: string, jsonPath: Array<string>): boolean {
  if (!fs.existsSync(filePath)) return false;
  const text = fs.readFileSync(filePath, "utf-8");
  const base = text.trim() === "" ? "{}\n" : text;
  let current: { found: boolean; value: unknown };
  try {
    current = getValueAt(base, jsonPath);
  } catch {
    return false;
  }
  if (!current.found) return false;
  const edits = modify(base, jsonPath, undefined, {
    formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" }
  });
  fs.writeFileSync(filePath, applyEdits(base, edits), "utf-8");
  return true;
}

export function runInstall(argv: string[], defaults: InstallOptions = {}): number {
  const log = defaults.log ?? ((line: string) => console.log(line));
  let options: ReturnType<typeof parseInstallArgs>;
  try {
    options = parseInstallArgs(argv, defaults);
  } catch (error) {
    log(`参数错误: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (options.help) {
    log(installUsage());
    return 0;
  }

  if (!fs.existsSync(options.projectDir)) {
    log(`✗ 项目目录不存在: ${options.projectDir}`);
    return 1;
  }
  if (options.targets.length === 0) {
    log(`✗ --targets 为空；可选: ${INSTALL_TARGETS.join(", ")}`);
    return 1;
  }

  const entry = buildServerEntry(options);
  log(`项目: ${options.projectDir}`);
  log(
    `模式: ${options.mode}` +
      (options.mode === "docker" ? ` (container=${options.container})` : "") +
      (options.mode === "http" ? ` (url=${entry.kind === "http" ? entry.url : ""})` : "")
  );
  log("");

  for (const target of options.targets) {
    const plan = targetPlan(target as InstallTarget, options.projectDir);
    const relative = path.relative(options.projectDir, plan.file) || plan.file;
    for (const legacy of LEGACY_SERVER_NAMES) {
      const legacyPath = [...plan.jsonPath.slice(0, -1), legacy];
      if (removeJsoncPath(plan.file, legacyPath)) {
        log(`- ${target.padEnd(9)} → ${relative}（已移除旧键 ${legacy}）`);
      }
    }
    const status = upsertJsoncFile(plan.file, plan.jsonPath, plan.toValue(entry), options.force);
    switch (status) {
      case "written":
        log(`✓ ${target.padEnd(9)} → ${relative}`);
        break;
      case "unchanged":
        log(`= ${target.padEnd(9)} → ${relative}（无变化）`);
        break;
      case "skipped_exists":
        log(`! ${target.padEnd(9)} → ${relative} 已存在不同配置；使用 --force 覆盖`);
        break;
      case "invalid":
        log(`✗ ${target.padEnd(9)} → ${relative} 不是合法 JSONC；未修改`);
        break;
    }
  }

  log("");
  log("不可写项目级配置的客户端（手动添加）：");
  log("  • Codex (~/.codex/config.toml):");
  log(`      [mcp_servers.${MCP_SERVER_NAME}]`);
  if (entry.kind === "http") {
    log(`      url = ${JSON.stringify(entry.url)}`);
  } else {
    log(`      command = ${JSON.stringify(entry.command)}`);
    log(`      args = ${JSON.stringify(entry.args)}`);
    if (Object.keys(entry.env).length > 0) {
      log(`      [mcp_servers.${MCP_SERVER_NAME}.env]`);
      for (const [key, value] of Object.entries(entry.env)) {
        log(`      ${key} = ${JSON.stringify(value)}`);
      }
    }
  }
  log(`  • Claude Desktop / Windsurf：同 Codex 结构（各自全局配置文件的 mcpServers.${MCP_SERVER_NAME}）`);

  return 0;
}
