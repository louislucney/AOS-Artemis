#!/usr/bin/env node
/**
 * pen 资源导入人工冒烟（真实 pen CLI + 登录，manual run）。
 *
 *   node scripts/e2e-pen-assets.mjs --pen <file.pen> --ids id1,id2 [--project <dir>] [--dry-run]
 *
 * 前置：npm run build；pen CLI 已安装并登录（pen login 或项目 .env 的 PEN_CLI_KEY）。
 * 行为：经 stdio 启动 dist/index.js（AOS_PROJECT_DIR 指向目标项目），调用
 * pen_import_assets，打印 counts/产物与告警；真实验收 Export 契约（Exported 路径对账、
 * scale 生效、按栈命名落盘、报告 schemaVersion/penCliVersion）。
 *
 * Exits: 0 = ok，1 = 工具报错（ok:false/isError），2 = 用法/基础设施错误。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function usage(message) {
  console.error(message);
  console.error(
    "Usage: node scripts/e2e-pen-assets.mjs --pen <file.pen> --ids id1,id2 [--project <dir>] [--dry-run]"
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { pen: null, ids: null, project: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--pen") args.pen = argv[++i] ?? null;
    else if (token === "--ids") args.ids = argv[++i] ?? null;
    else if (token === "--project") args.project = argv[++i] ?? null;
    else if (token === "--dry-run") args.dryRun = true;
    else usage(`未知参数: ${token}`);
  }
  if (!args.pen) usage("缺少 --pen <file.pen>");
  if (!args.ids) usage("缺少 --ids id1,id2");
  args.project = path.resolve(args.project ?? process.env.AOS_PROJECT_DIR ?? process.cwd());
  args.ids = args.ids
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (args.ids.length === 0) usage("--ids 不能为空");
  return args;
}

const args = parseArgs(process.argv.slice(2));

const parse = (result) => {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return { ok: false, error: "无法解析工具响应" };
  }
};

const client = new Client({ name: "aos-mcp-pen-assets-e2e", version: "0.0.1" });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repoRoot, "dist", "index.js")],
      cwd: repoRoot,
      env: { ...process.env, AOS_PROJECT_DIR: args.project }
    })
  );
} catch (error) {
  console.error(`[infra] 启动 MCP 服务失败: ${error.message}`);
  process.exit(2);
}

try {
  console.log(`[1/2] 项目: ${args.project}`);
  console.log(`      .pen: ${args.pen}  ids: ${args.ids.join(", ")}${args.dryRun ? "  (dryRun)" : ""}`);
  const result = await client.callTool({
    name: "pen_import_assets",
    arguments: { path: args.pen, ids: args.ids, dryRun: args.dryRun }
  });
  const payload = parse(result);
  if (result.isError || payload.ok !== true) {
    console.error(`[2/2] FAIL: ${payload.error ?? "未知错误"}`);
    if (payload.warnings) for (const line of payload.warnings) console.error(`      warning: ${line}`);
    if (payload.log) console.error(`      log: ${String(payload.log).slice(-1200)}`);
    process.exit(1);
  }
  console.log(`[2/2] OK  counts=${JSON.stringify(payload.counts)}`);
  console.log(
    `      session=${JSON.stringify(payload.session)}  vector=${payload.vector}  cli=${payload.penCliVersion ?? "?"}`
  );
  if (payload.warnings?.length) for (const line of payload.warnings) console.log(`      warning: ${line}`);
  if (payload.savedTo) console.log(`      report: ${payload.savedTo}`);
  for (const entry of payload.results ?? []) {
    console.log(`      ${entry.status.padEnd(14)} ${entry.file ?? entry.relativePath}${entry.variant ? ` (${entry.variant})` : ""}`);
  }
  process.exit(0);
} catch (error) {
  console.error(`[infra] 调用失败: ${error.message}`);
  process.exit(2);
} finally {
  await client.close().catch(() => {});
}
