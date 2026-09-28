#!/usr/bin/env node
/**
 * Real-device E2E acceptance script (manual run).
 *
 *   node scripts/e2e-device.mjs "Open Settings and report the battery level"
 *
 * Prerequisites:
 *   - project .env configured (or run `aos-mcp doctor`)
 *   - artemis venv ready (cd artemis && uv sync)
 *   - an authorized Android device (adb devices)
 *
 * Exits: 0 = task completed, 1 = task failed, 2 = setup required, 3 = usage/infra error.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const taskDesc =
  process.argv[2] ??
  "Open the Settings app, go to Battery, and report the current battery percentage.";
const projectDir = process.env.AOS_PROJECT_DIR ?? repoRoot;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parse = (result) => {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return {};
  }
};

const client = new Client({ name: "aos-mcp-e2e", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "index.js")],
    cwd: repoRoot,
    env: { ...process.env, AOS_PROJECT_DIR: projectDir }
  })
);

try {
  console.log(`[1/4] 项目: ${projectDir}`);
  const list = parse(await client.callTool({ name: "llm_list", arguments: {} }));
  if (list.setupRequired) {
    console.error("[setup_required]", list.setup?.message);
    for (const line of list.setup?.howToFix ?? []) console.error("  -", line);
    process.exit(2);
  }
  const active = list.llms?.find((entry) => entry.isActive);
  console.log(`[1/4] active LLM: ${list.activeProfile} (${active?.model ?? "?"})`);

  console.log("[2/4] 设备诊断中…");
  const diag = parse(await client.callTool({ name: "mobile_diagnose", arguments: {} }));
  const device = diag.device?.serial ?? "(未检测到)";
  console.log(`[2/4] verdict=${diag.verdict ?? "?"} device=${device}`);

  console.log(`[3/4] 提交任务: ${taskDesc}`);
  const run = parse(
    await client.callTool({
      name: "mobile_run_task",
      arguments: { task_desc: taskDesc, model: "Flash" }
    })
  );
  const traceId = run.trace_id ?? run.traceId;
  if (!traceId) {
    console.error("[3/4] 无法获取 trace_id:", JSON.stringify(run));
    process.exit(3);
  }
  console.log(`[3/4] trace_id=${traceId}`);

  console.log("[4/4] 轮询任务状态…");
  for (let attempt = 0; attempt < 72; attempt += 1) {
    await sleep(5000);
    const status = parse(
      await client.callTool({
        name: "mobile_manage_task",
        arguments: { action: "status", trace_id: traceId }
      })
    );
    const state = status.status ?? "unknown";
    process.stdout.write(`\r[4/4] ${state} (${attempt * 5}s)      `);
    if (["completed", "failed", "cancelled"].includes(state)) {
      console.log("");
      console.log(`任务结果: ${state}`);
      if (status.test_summary) console.log("checks:", JSON.stringify(status.test_summary));
      process.exit(state === "completed" ? 0 : 1);
    }
  }
  console.error("\n[4/4] 超时（6 分钟）——任务可能仍在运行，可用 mobile_manage_task 继续查询。");
  process.exit(1);
} finally {
  await client.close();
}
