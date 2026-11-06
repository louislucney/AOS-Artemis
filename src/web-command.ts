import { runLlmWorkerCli } from "./web/llm/cli.js";

export interface WebCliDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
}

interface ParsedFlags {
  positional: string[];
  get: (key: string) => string | null;
  bool: (key: string) => boolean;
  has: (key: string) => boolean;
}

function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | true | string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    let key: string;
    let value: string | true;
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }
    const existing = flags.get(key);
    if (existing === undefined) flags.set(key, value);
    else if (Array.isArray(existing)) existing.push(String(value));
    else flags.set(key, [String(existing), String(value)]);
  }
  return {
    positional,
    get: (key) => {
      const value = flags.get(key);
      return typeof value === "string" ? value : null;
    },
    bool: (key) => {
      const value = flags.get(key);
      return value !== undefined && value !== "false";
    },
    has: (key) => flags.has(key)
  };
}

export function printWebUsage(log: (line: string) => void): void {
  log(`mobile-testing-mcp web — Web/LLM 执行工具

Usage:
  mobile-testing-mcp web llm-worker [--once] [--poll-ms <n>] [--max-jobs <n>]
      [--case-timeout-ms <n>] [--job-max-ms <n>]
      中心 LLM 执行器（P0 Android；需要中心 PG/控制面与 runner 设备网关）

说明:
  Maestro 脚本生成 / web-runner 已移除；Android 真机请用 run_regression / mobile_run_task。
  --once               只跑一轮
  --poll-ms <n>        空闲轮询间隔
  --max-jobs <n>       本轮最多处理任务数
  --case-timeout-ms    单用例超时
  --job-max-ms         单任务上限
  --help               本帮助

exit codes: 0 成功；1 执行失败；2 参数错误`);
}

export async function runWebCommand(argv: string[], deps: WebCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  const flags = parseFlags(argv);
  if (argv.includes("-h") || argv.includes("--help")) {
    printWebUsage(log);
    return 0;
  }
  if (flags.positional[0] === "llm-worker") {
    const once = flags.bool("once");
    const pollMs = Number.parseInt(flags.get("poll-ms") ?? "", 10);
    const maxJobs = Number.parseInt(flags.get("max-jobs") ?? "", 10);
    const caseTimeoutMs = Number.parseInt(flags.get("case-timeout-ms") ?? "", 10);
    const jobMaxMs = Number.parseInt(flags.get("job-max-ms") ?? "", 10);
    return await runLlmWorkerCli({
      once,
      ...(Number.isFinite(pollMs) && pollMs > 0 ? { pollMs } : {}),
      ...(Number.isFinite(maxJobs) && maxJobs > 0 ? { maxJobs } : {}),
      ...(Number.isFinite(caseTimeoutMs) && caseTimeoutMs > 0 ? { caseTimeoutMs } : {}),
      ...(Number.isFinite(jobMaxMs) && jobMaxMs > 0 ? { jobMaxMs } : {}),
      log,
      errorLog
    });
  }
  errorLog(`未知 web 子命令 "${flags.positional.join(" ") || "(空)"}"`);
  printWebUsage(errorLog);
  return 2;
}
