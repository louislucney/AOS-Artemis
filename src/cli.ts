#!/usr/bin/env node
import { runDoctor, runInit } from "./commands.js";
import { runDepsCommand } from "./deps-build.js";
import { runHttpServer, type HttpServerOptions } from "./http-server.js";
import { runInstall } from "./install.js";
import { runServer } from "./server.js";

function printUsage(): void {
  console.log(`aos-mcp — AOS × ARTEMIS unified MCP service

Usage:
  aos-mcp serve     Run the MCP server (stdio by default)
  aos-mcp serve --http [--port 8765] [--host 127.0.0.1] [--workspace <dir>]
                    Stateless streamable-HTTP endpoint: POST /mcp/<project>
  aos-mcp init      Generate aos.config.jsonc and .env.example in the current directory
  aos-mcp doctor [--install-deps]
                    Health check; --install-deps installs artemis dependencies from the
                    configured bundle (AOS_ARTEMIS_DEPS_URL / artemis.depsUrl)
  aos-mcp install   Write project-level MCP configs for Claude Code / Cursor / VS Code / opencode
  aos-mcp deps build
                    Build the artemis dependency bundle (cross-platform, per OS/arch):
                    dist-deps/artemis-deps-<os>-<arch>.tar.gz + .sha256
                    options: --out DIR  --repo DIR  --work DIR  --skip-sync  --uv PATH

install options:
  --project <dir>        Target project (default: cwd)
  --targets <list>       Comma list: ${["claude", "cursor", "vscode", "opencode"].join(",")} (default: all)
  --mode local|docker|http
                         local = node <service>/dist/index.js (default)
                         docker = docker exec -i -w /workspace/<project> <container> node /app/dist/index.js
                         http = remote URL http://<host>:<port>/mcp/<project>
  --container <name>     Container name for docker mode (default: aos-mcp)
  --url <base>           Base URL for http mode (default: http://127.0.0.1:8765)
  --service <path>       Service entry path for local mode (default: this install's dist/index.js)
  --force                Overwrite an existing but different aos entry
`);
}

const [command = "serve", ...rest] = process.argv.slice(2);

void (async () => {
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
        await runHttpServer(options);
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
  console.error("[aos-mcp] fatal:", error);
  process.exit(1);
});
