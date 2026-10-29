#!/usr/bin/env node
import { runDoctor, runInit } from "./commands.js";
import { runDepsCommand } from "./deps-build.js";
import { runExportCommand } from "./export-command.js";
import { printHostUsage, runHostCommand } from "./host-command.js";
import {
  runHttpServer,
  AuthConfigError,
  InsecureBindRefusedError,
  type HttpServerOptions
} from "./http-server.js";
import { runInstall } from "./install.js";
import { runJiraCommand } from "./jira-command.js";
import { printUserUsage, runUserCommand } from "./user-command.js";
import { runServer } from "./server.js";
import { printSuiteUsage, runSuiteCommand } from "./suite-command.js";
import { printWebRunnerUsage, runWebRunnerCommand } from "./runner/web-agent.js";
import { runUsageCommand } from "./usage-command.js";
import { runPanelCommand } from "./panel-command.js";
import { runCmsOpen } from "./open/command.js";
import { printWebUsage, runWebCommand } from "./web-command.js";

function printUsage(): void {
  console.log(`mobile-testing-mcp — unified MCP service for mobile testing

Usage:
  mobile-testing-mcp serve     Run the MCP server (stdio by default)
  mobile-testing-mcp serve --http [--port 8765] [--host 127.0.0.1] [--workspace <dir>]
                    Stateless streamable-HTTP endpoint: POST /mcp/<project>
  mobile-testing-mcp init      Generate aos.config.jsonc and .env.example in the current directory
  mobile-testing-mcp doctor [--install-deps]
                    Health check; --install-deps installs artemis dependencies from the
                    configured bundle (AOS_ARTEMIS_DEPS_URL / artemis.depsUrl)
  mobile-testing-mcp install   Write project-level MCP configs for Claude Code / Cursor / VS Code / opencode
  mobile-testing-mcp deps build
                    Build the artemis dependency bundle (cross-platform, per OS/arch):
                    dist-deps/artemis-deps-<os>-<arch>.tar.gz + .sha256
                    options: --out DIR  --repo DIR  --work DIR  --skip-sync  --uv PATH
  mobile-testing-mcp suite <run|check|calibrate|loop|flake|evidence|baseline|report|feedback> [options]
                    Deterministic test loop over .artemis/design/tests.json:
                    run | check | calibrate | loop | flake | evidence <traceId> | baseline save|compare | report | feedback
                    (see "mobile-testing-mcp suite help" for options; exit codes: 0 ok / 1 test failure / 2 error)
  mobile-testing-mcp host <list|show|register|adopt-legacy> [options]
                    中心主机登记（只连 PostgreSQL，需 MOBILE_TESTING_DATABASE_URL）：
                    list | show <id|hostname> | register <id> | adopt-legacy --local|--host <id> --path <rootPath>
                    (见 "mobile-testing-mcp host help"；缺省 dry-run，--apply 才写库)
  mobile-testing-mcp web-runner [--name <n>] [--artifact-base-url <url>] [--once]
                    host 级远端 Web 任务执行机（只连中心 PG，不要求项目目录；每台设备一个 worker）
  mobile-testing-mcp web scripts generate --project <dir> --excel <assetId> --package <assetId>
                    --platform <android|ios> [--app-id <id>] [--strict|--assume-prepared]
                    [--dry-run] [--json]
                    从 Excel/CSV 资产生成 Maestro 脚本集；--dry-run 只出 manifest 不写资产
  mobile-testing-mcp jira issue <create|comment|label|transition|link> [options]
                    Jira 工作流（与 MCP 工具共用客户端与凭证；见 "mobile-testing-mcp jira help"；
                    exit codes: 0 成功 / 1 请求或配置失败 / 2 用法错误）
  mobile-testing-mcp user <add|list|revoke|rotate> [options]
                    HTTP 命名用户生命周期（令牌只存 SHA-256、HTTP 热加载；见 "mobile-testing-mcp user help"；
                    exit codes: 0 成功 / 1 操作失败 / 2 用法错误）
  mobile-testing-mcp usage [--json] [--all] [--project <名称>] [--host <id|主机名>] [--days <n>]
                    使用统计：默认当前项目摘要（--days 默认 7）；--json 机器可读；
                    --all 跨项目总览；--project 选择已注册项目；
                    --host 只看该主机项目（--web 下仍为监听地址）
  mobile-testing-mcp usage --web [--port 8766] [--host 127.0.0.1]
                    只读看板（复用 /usage 与 /usage.json）；端口占用 exit 2
  mobile-testing-mcp panel --web [--port 8767] [--host 127.0.0.1] [--workspace <dir>]
                    多项目总览面板（只读；复用 /panel 与 /panel.json）
  mobile-testing-mcp cms-open [--host 127.0.0.1] [--port 8780] [--cors <origins>]
                    CMS 开放服务：静态 Figma/.pen → design.md + cases.xlsx（zip）；默认只读本机
  mobile-testing-mcp export --what results|process|data [--format json|csv] [--project <dir>]
                    [--out <file>] [--since <ISO>] [--limit <n>]
                    三口径导出：results（测试结果）/ process（测试过程）/ data（测试用的数据）

install options:
  --project <dir>        Target project (default: cwd)
  --targets <list>       Comma list: ${["claude", "cursor", "vscode", "opencode"].join(",")} (default: all)
  --mode local|docker|http
                         local = node <service>/dist/index.js (default)
                         docker = docker exec -i -w /workspace/<project> <container> node /app/dist/index.js
                         http = remote URL http://<host>:<port>/mcp/<project>
  --container <name>     Container name for docker mode (default: mobile-testing-mcp)
  --url <base>           Base URL for http mode (default: http://127.0.0.1:8765)
  --service <path>       Service entry path for local mode (default: this install's dist/index.js)
  --force                Overwrite an existing but different aos entry
`);
}

const [command = "serve", ...rest] = process.argv.slice(2);

void (async () => {
  // `--help/-h` 优先于一切校验（含拼写错误子命令）：只打印对应用法，不进入任何命令分支。
  const wantsHelp = rest.includes("-h") || rest.includes("--help");
  if (wantsHelp && command !== "jira" && command !== "cms-open") {
    if (command === "suite") printSuiteUsage((line) => console.log(line));
    else if (command === "host") printHostUsage((line) => console.log(line));
    else if (command === "user") printUserUsage((line) => console.log(line));
    else if (command === "web-runner") printWebRunnerUsage((line) => console.log(line));
    else if (command === "web") printWebUsage((line) => console.log(line));
    else printUsage();
    return;
  }
  switch (command) {
    case "serve": {
      if (rest.includes("--http")) {
        const options: HttpServerOptions = {};
        for (let index = 0; index < rest.length; index += 1) {
          if (rest[index] === "--port" && rest[index + 1]) {
            options.port = Number(rest[++index]);
          } else if (rest[index] === "--host" && rest[index + 1]) {
            options.host = rest[++index];
          } else if (rest[index] === "--workspace" && rest[index + 1]) {
            options.workspaceRoot = rest[++index];
          }
        }
        try {
          await runHttpServer(options);
        } catch (error) {
          if (error instanceof InsecureBindRefusedError || error instanceof AuthConfigError) {
            console.error(error.message);
            process.exit(2);
          }
          throw error;
        }
      } else {
        await runServer();
      }
      break;
    }
    case "init":
      runInit(rest);
      break;
    case "doctor": {
      const code = await runDoctor(rest);
      process.exit(code);
      break;
    }
    case "install": {
      const code = runInstall(rest);
      process.exit(code);
      break;
    }
    case "deps": {
      const code = await runDepsCommand(rest);
      process.exit(code);
      break;
    }
    case "suite": {
      const code = await runSuiteCommand(rest);
      process.exit(code);
      break;
    }
    case "host": {
      const code = await runHostCommand(rest, {
        log: (line) => console.log(line),
        errorLog: (line) => console.error(line)
      });
      process.exit(code);
      break;
    }
    case "usage": {
      const code = await runUsageCommand(rest);
      process.exit(code);
      break;
    }
    case "web-runner": {
      const code = await runWebRunnerCommand(rest, {
        log: (line) => console.error(line),
        errorLog: (line) => console.error(line)
      });
      process.exit(code);
      break;
    }
    case "web": {
      const code = await runWebCommand(rest);
      process.exit(code);
      break;
    }
    case "panel": {
      const code = await runPanelCommand(rest);
      process.exit(code);
      break;
    }
    case "cms-open": {
      const code = await runCmsOpen(rest);
      process.exit(code);
      break;
    }
    case "export": {
      const code = await runExportCommand(rest);
      process.exit(code);
      break;
    }
    case "jira": {
      const code = await runJiraCommand(rest);
      process.exit(code);
      break;
    }
    case "user": {
      const code = runUserCommand(rest);
      process.exit(code);
      break;
    }
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    default:
      console.error(`未知命令 "${command}"\n`);
      printUsage();
      process.exit(1);
  }
})().catch((error: unknown) => {
  console.error("[mobile-testing-mcp] fatal:", error);
  process.exit(1);
});
