#!/usr/bin/env node
/**
 * Generic mobile-testing MCP tool caller (temp helper).
 *   node scripts/mobile-testing-call.mjs <calls.json> [projectDir]
 * calls.json: [{ "name": "tool", "args": {...}, "out": "optional/file.json" }]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const [, , callsFile, projectArg] = process.argv;
if (!callsFile) {
  console.error("usage: node scripts/mobile-testing-call.mjs <calls.json> [projectDir]");
  process.exit(3);
}
const projectDir = path.resolve(projectArg ?? process.cwd());
const calls = JSON.parse(fs.readFileSync(callsFile, "utf-8"));
const envTimeout = Number(process.env.AOS_CALL_TIMEOUT_MS ?? "");
const requestTimeoutMs =
  Number.isFinite(envTimeout) && envTimeout > 0 ? Math.min(envTimeout, 2_147_483_647) : 600_000;
console.error(`[mobile-testing-call] 项目=${projectDir} 请求超时=${requestTimeoutMs}ms`);

const client = new Client({ name: "mobile-testing-call", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "index.js")],
    cwd: repoRoot,
    env: { ...process.env, AOS_PROJECT_DIR: projectDir }
  })
);

try {
  for (const c of calls) {
    const result = await client.callTool(
      { name: c.name, arguments: c.args ?? {} },
      undefined,
      { timeout: requestTimeoutMs }
    );
    const text = (result.content ?? [])
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("\n");
    const body = text || JSON.stringify(result);
    if (c.out) {
      fs.mkdirSync(path.dirname(c.out), { recursive: true });
      fs.writeFileSync(c.out, body, "utf-8");
      console.log(`===== ${c.name}${result.isError ? " (error)" : ""} ===== -> ${c.out} (${body.length} chars)`);
    } else {
      console.log(`\n===== ${c.name}${result.isError ? " (error)" : ""} =====`);
      console.log(body.slice(0, 4000));
      if (body.length > 4000) console.log(`... (${body.length - 4000} more chars)`);
    }
  }
} finally {
  await client.close();
}
