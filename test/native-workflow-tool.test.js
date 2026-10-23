import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServerForRuntime, inProcessToolCatalog } from "../dist/server.js";
import { baseConfig, loadTestRuntime, makeTempProject, StubProxy } from "./helpers.js";

async function makeHarness() {
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: "DEEPSEEK_API_KEY=sk-abcdef123456\n"
  });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy({ running: false }) });
  const server = createServerForRuntime(runtime, null);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "native-workflow-tool-test", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    dir,
    runtime,
    client,
    async close() {
      await client.close();
      await server.close();
    }
  };
}

async function workflowTool(client) {
  const { tools } = await client.listTools();
  const tool = tools.find((entry) => entry.name === "design_to_test");
  assert.ok(tool, `design_to_test missing from ${tools.map((entry) => entry.name).join(",")}`);
  return tool;
}

test("design_to_test: registered in the catalog and exposed with a minimal optional schema", async () => {
  assert.ok(inProcessToolCatalog().includes("design_to_test"));
  const harness = await makeHarness();
  try {
    const tool = await workflowTool(harness.client);
    assert.ok(tool.description.length > 0);
    const properties = tool.inputSchema.properties ?? {};
    for (const key of [
      "figmaUrl",
      "nodeId",
      "penPath",
      "vision",
      "reuseExistingFlows",
      "reuseExistingTests",
      "device",
      "run",
      "async",
      "maxFlows",
      "maxDepth"
    ]) {
      assert.ok(key in properties, `inputSchema exposes ${key}`);
    }
  } finally {
    await harness.close();
  }
});

test("design_to_test: description pins the pipeline protocol (no drift)", async () => {
  const harness = await makeHarness();
  try {
    const tool = await workflowTool(harness.client);
    for (const phrase of [
      "设计稿",
      "Figma",
      ".pen",
      "CR",
      "前置自检→读设计→懂交互→出用例→校验→可选执行",
      "run 缺省 false",
      "止于校验",
      "nextAction",
      "needs-setup",
      "needs-info",
      "checks[]"
    ]) {
      assert.ok(tool.description.includes(phrase), `description must mention "${phrase}"`);
    }
  } finally {
    await harness.close();
  }
});

test("design_to_test: zod rejects illegal types, accepts documented shapes", async () => {
  const harness = await makeHarness();
  try {
    for (const args of [
      { device: 123 },
      { run: "true" },
      { reuseExistingFlows: "yes" },
      { vision: "sometimes" },
      { vision: 1 },
      { figmaUrl: 42 },
      { maxFlows: 0 },
      { maxFlows: 1001 },
      { maxFlows: 2.5 },
      { maxDepth: 0 },
      { maxDepth: 51 },
      { maxDepth: 2.5 }
    ]) {
      const rejected = await harness.client.callTool({ name: "design_to_test", arguments: args });
      assert.equal(rejected.isError, true, JSON.stringify(args));
      assert.match(rejected.content[0].text, /参数校验失败/, JSON.stringify(args));
    }

    // 合法形态穿过 zod 进入编排（缺设计来源＝用法错误，而非校验失败）。
    for (const args of [
      {},
      { vision: "auto" },
      { vision: true },
      { vision: false },
      { run: true },
      { reuseExistingFlows: false },
      { device: "emulator-5554" },
      { maxFlows: 300, maxDepth: 12 },
      { maxFlows: 1000 }
    ]) {
      const accepted = await harness.client.callTool({ name: "design_to_test", arguments: args });
      assert.ok(!accepted.content[0].text.includes("参数校验失败"), JSON.stringify(args));
      assert.equal(accepted.isError, true, JSON.stringify(args));
      const payload = JSON.parse(accepted.content[0].text);
      assert.equal(payload.ok, false, JSON.stringify(args));
      assert.ok(payload.error.includes("用法错误"), JSON.stringify(args));
    }
  } finally {
    await harness.close();
  }
});

async function namedTool(client, name) {
  const { tools } = await client.listTools();
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `${name} missing from ${tools.map((entry) => entry.name).join(",")}`);
  return tool;
}

test("run_regression: registered in the catalog with the documented schema", async () => {
  assert.ok(inProcessToolCatalog().includes("run_regression"));
  const harness = await makeHarness();
  try {
    const tool = await namedTool(harness.client, "run_regression");
    assert.ok(tool.description.length > 0);
    const properties = tool.inputSchema.properties ?? {};
    for (const key of ["excelPath", "scope", "all", "device", "columns", "async"]) {
      assert.ok(key in properties, `inputSchema exposes ${key}`);
    }
  } finally {
    await harness.close();
  }
});

test("run_regression: description pins the regression protocol (no drift)", async () => {
  const harness = await makeHarness();
  try {
    const tool = await namedTool(harness.client, "run_regression");
    for (const phrase of [
      "回归",
      "重跑",
      "Excel",
      ".xlsx",
      "needs-setup",
      "needs-info",
      "功能×条数",
      "来源",
      "导入自",
      "生成自",
      "执行前",
      "日志",
      "缺省",
      "最新用例集",
      "全量"
    ]) {
      assert.ok(tool.description.includes(phrase), `description must mention "${phrase}"`);
    }
  } finally {
    await harness.close();
  }
});

test("run_regression: zod rejects illegal types", async () => {
  const harness = await makeHarness();
  try {
    for (const args of [{ excelPath: 42 }, { scope: 1 }, { all: "yes" }, { device: 123 }, { columns: "x" }]) {
      const rejected = await harness.client.callTool({ name: "run_regression", arguments: args });
      assert.equal(rejected.isError, true, JSON.stringify(args));
      assert.match(rejected.content[0].text, /参数校验失败/, JSON.stringify(args));
    }
  } finally {
    await harness.close();
  }
});

test("verify_jira_issue: registered in the catalog with the documented schema", async () => {
  assert.ok(inProcessToolCatalog().includes("verify_jira_issue"));
  const harness = await makeHarness();
  try {
    const tool = await namedTool(harness.client, "verify_jira_issue");
    assert.ok(tool.description.length > 0);
    const properties = tool.inputSchema.properties ?? {};
    for (const key of ["issueKey", "device", "scope", "dryRun", "async"]) {
      assert.ok(key in properties, `inputSchema exposes ${key}`);
    }
    const required = tool.inputSchema.required ?? [];
    assert.ok(required.includes("issueKey"), "issueKey is required");
  } finally {
    await harness.close();
  }
});

test("verify_jira_issue: description pins the jira-verification protocol (no drift)", async () => {
  const harness = await makeHarness();
  try {
    const tool = await namedTool(harness.client, "verify_jira_issue");
    for (const phrase of [
      "Jira 验证",
      "粗单",
      "只能从清单中选",
      "单子即用例",
      "任一强断言失败",
      "弱断言仅记录路径，不代表验证通过",
      "AOS-VERIFY",
      "dryRun",
      "dryRun 零写回（不产生任何外部副作用；读单/评论读取不变）",
      "needs-setup",
      "needs-info",
      "回显"
    ]) {
      assert.ok(tool.description.includes(phrase), `description must mention "${phrase}"`);
    }
  } finally {
    await harness.close();
  }
});

test("verify_jira_issue: zod rejects illegal types", async () => {
  const harness = await makeHarness();
  try {
    for (const args of [{}, { issueKey: 42 }, { device: 123 }, { scope: 1 }, { dryRun: "yes" }]) {
      const rejected = await harness.client.callTool({ name: "verify_jira_issue", arguments: args });
      assert.equal(rejected.isError, true, JSON.stringify(args));
      assert.match(rejected.content[0].text, /参数校验失败/, JSON.stringify(args));
    }
  } finally {
    await harness.close();
  }
});

test("project_archive: registered with a no-argument schema and callable read-only", async () => {
  assert.ok(inProcessToolCatalog().includes("project_archive"));
  const harness = await makeHarness();
  try {
    const tool = await namedTool(harness.client, "project_archive");
    assert.ok(tool.description.length > 0);
    const properties = tool.inputSchema.properties ?? {};
    assert.equal(Object.keys(properties).length, 0, "no parameters");
    const required = tool.inputSchema.required ?? [];
    assert.equal(required.length, 0, "nothing required");

    const result = await harness.client.callTool({ name: "project_archive", arguments: {} });
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.project.name, "string");
    assert.equal(Array.isArray(payload.degraded), true);
  } finally {
    await harness.close();
  }
});

test("project_archive: description pins the read-only protocol (no drift)", async () => {
  const harness = await makeHarness();
  try {
    const tool = await namedTool(harness.client, "project_archive");
    for (const phrase of [
      "档案",
      "只读",
      "不触网",
      "无子进程",
      "不写盘",
      "未复核",
      "设计血统",
      "用例库",
      "最近运行",
      "裁决",
      "前置状态",
      "masked"
    ]) {
      assert.ok(tool.description.includes(phrase), `description must mention "${phrase}"`);
    }
  } finally {
    await harness.close();
  }
});
