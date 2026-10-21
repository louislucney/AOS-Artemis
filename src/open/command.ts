import { startCmsOpenServer } from "./server.js";

export interface CmsOpenCliDeps {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
  signal?: AbortSignal;
}

const USAGE = `mobile-testing-mcp cms-open [options]

  CMS 开放服务：设计图 → 理解 → 测试用例（md + xlsx zip）

  options:
    --host <host>            监听地址（默认 127.0.0.1）
    --port <port>            监听端口（默认 8780）
    --cors <origins>         允许的浏览器来源，逗号分隔（默认不放开）
    --allowed-hosts <hosts>  额外允许的 Host 头，逗号分隔（LAN 访问时必须显式配置）
    --max-queue <n>          队列上限（默认 20）
    --max-concurrent <n>     并发生成数（默认 3）
    --job-timeout-ms <ms>    单任务超时（默认 600000）
    --retention-ms <ms>      产物保留（默认 7200000）
    --work-root <dir>        临时工作目录（默认系统临时目录下 aos-cms-open）
    --check                  启动自检后立即退出（部署/CI 用）
    --help                   显示本帮助
`;

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, "true");
    }
  }
  return flags;
}

function intFlag(
  flags: Map<string, string>,
  name: string,
  fallback: number,
  min: number,
  max: number,
  errorLog: (line: string) => void
): number | null {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    errorLog(`--${name} 需要 ${min}-${max} 的整数（当前 ${raw}）`);
    return null;
  }
  return value;
}

function listFlag(flags: Map<string, string>, name: string): string[] {
  const raw = flags.get(name);
  if (raw === undefined || raw === "true") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export async function runCmsOpen(
  argv: string[],
  deps: CmsOpenCliDeps = {}
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  const flags = parseFlags(argv);
  if (flags.has("help") || flags.has("h")) {
    log(USAGE.trimEnd());
    return 0;
  }
  const port = intFlag(flags, "port", 8780, 0, 65535, errorLog);
  const maxQueue = intFlag(flags, "max-queue", 20, 1, 1000, errorLog);
  const maxConcurrent = intFlag(flags, "max-concurrent", 3, 1, 32, errorLog);
  const jobTimeoutMs = intFlag(flags, "job-timeout-ms", 600_000, 1_000, 3_600_000, errorLog);
  const retentionMs = intFlag(flags, "retention-ms", 7_200_000, 0, 86_400_000, errorLog);
  if ([port, maxQueue, maxConcurrent, jobTimeoutMs, retentionMs].some((value) => value === null)) {
    return 2;
  }
  const host = flags.get("host")?.trim() || "127.0.0.1";
  const cors = listFlag(flags, "cors");
  const allowedHosts = listFlag(flags, "allowed-hosts");
  const workRoot = flags.get("work-root")?.trim() || undefined;
  if (host === "0.0.0.0" || host === "::") {
    log(`WARN 监听 ${host}：服务无鉴权，请确认处于可信内网；浏览器来源默认仍拒绝（--cors 显式放行）。`);
  }
  const server = await startCmsOpenServer({
    host,
    port: port!,
    cors,
    allowedHosts,
    maxQueue: maxQueue!,
    maxConcurrent: maxConcurrent!,
    jobTimeoutMs: jobTimeoutMs!,
    retentionMs: retentionMs!,
    ...(workRoot ? { workRoot } : {})
  });
  log(`CMS 开放服务: http://${host}:${server.port}`);
  log(`CORS: ${cors.length === 0 ? "未启用（默认拒绝跨源）" : cors.join(", ")}`);
  log("pen: 使用服务机登录态（pen login / PEN_CLI_KEY）；未就绪时 .pen 任务显式失败");
  if (flags.has("check")) {
    await server.close();
    log("自检通过，已退出。");
    return 0;
  }
  return await new Promise<number>((resolve) => {
    let closed = false;
    const stop = (): void => {
      if (closed) return;
      closed = true;
      void server.close().then(() => resolve(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    deps.signal?.addEventListener("abort", stop, { once: true });
  });
}
