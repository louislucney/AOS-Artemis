import assert from "node:assert/strict";
import test from "node:test";

import { parsePipelineArgs, runPipeline } from "../scripts/design-to-test.mjs";

function makeDeps(overrides = {}) {
  const calls = [];
  const cliCalls = [];
  const deps = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "pen_extract_flows" || name === "figma_extract_flows") {
        return {
          ok: true,
          counts: { screens: 3, edges: 2, unresolved: 0 },
          entryScreens: ["Home"],
          savedTo: { flows: "/p/flows.json", markdown: "/p/flow-map.md" }
        };
      }
      if (name === "figma_generate_tests") {
        return { ok: true, counts: { flows: 2 }, coverage: { complete: true }, savedTo: { markdown: "/p/tests.md" }, flows: [{ taskDesc: "case1" }] };
      }
      throw new Error(`unexpected tool ${name}`);
    },
    runCli: async (args) => {
      cliCalls.push(args);
      return 0;
    },
    ...overrides
  };
  return { deps, calls, cliCalls };
}

const NOOP_LOG = { log: () => {}, errorLog: () => {} };

test("design-to-test: Figma 全链——提取→生成→校验→执行（含步骤与参数）", async () => {
  const { deps, calls, cliCalls } = makeDeps();
  const code = await runPipeline({
    options: { source: { kind: "figma", url: "https://www.figma.com/design/X/File", nodeId: "1-2" }, projectDir: "/proj", device: "S1" },
    deps,
    ...NOOP_LOG
  });
  assert.equal(code, 0);
  assert.deepEqual(
    calls.map((entry) => entry.name),
    ["figma_extract_flows", "figma_generate_tests"]
  );
  assert.deepEqual(calls[0].args, { url: "https://www.figma.com/design/X/File", nodeId: "1-2" });
  assert.deepEqual(calls[1].args, {});
  assert.deepEqual(cliCalls, [
    ["suite", "check", "--project", "/proj"],
    ["suite", "run", "--project", "/proj", "--device", "S1"]
  ]);
});

test("design-to-test: pen 源——提取带 vision 透传；无 --device 只到校验并给执行提示", async () => {
  const { deps, calls, cliCalls } = makeDeps();
  const logs = [];
  const code = await runPipeline({
    options: { source: { kind: "pen", penPath: "/d/x.pen", vision: "auto" }, projectDir: "/proj", device: null },
    deps,
    log: (line) => logs.push(line),
    errorLog: () => {}
  });
  assert.equal(code, 0);
  assert.deepEqual(calls[0], { name: "pen_extract_flows", args: { penPath: "/d/x.pen", vision: "auto" } });
  assert.deepEqual(cliCalls, [["suite", "check", "--project", "/proj"]]);
  assert.ok(logs.join("\n").includes("suite run"), "应提示手工执行命令");
});

test("design-to-test: 校验失败→不执行测试、exit 2；--no-run 时也不执行", async () => {
  const failing = makeDeps({
    runCli: async (args) => {
      failingCli.push(args);
      return 2;
    }
  });
  const failingCli = [];
  const code = await runPipeline({
    options: { source: { kind: "pen", penPath: "/d/x.pen" }, projectDir: "/proj", device: "S1" },
    deps: failing.deps,
    ...NOOP_LOG
  });
  assert.equal(code, 2);
  assert.deepEqual(failingCli, [["suite", "check", "--project", "/proj"]]);

  const { deps, cliCalls } = makeDeps();
  const code2 = await runPipeline({
    options: { source: { kind: "pen", penPath: "/d/x.pen" }, projectDir: "/proj", device: "S1", noRun: true },
    deps,
    ...NOOP_LOG
  });
  assert.equal(code2, 0);
  assert.deepEqual(cliCalls, [["suite", "check", "--project", "/proj"]]);
});

test("design-to-test: 执行失败透传退出码 1", async () => {
  const { deps } = makeDeps({
    runCli: async (args) => (args[0] === "suite" && args[1] === "run" ? 1 : 0)
  });
  const code = await runPipeline({
    options: { source: { kind: "pen", penPath: "/d/x.pen" }, projectDir: "/proj", device: "S1" },
    deps,
    ...NOOP_LOG
  });
  assert.equal(code, 1);
});

test("design-to-test: 参数校验——figma/pen 互斥且必选其一；node-id 仅 figma", () => {
  assert.throws(() => parsePipelineArgs(["--project", "/p"]), /figma|pen/);
  assert.throws(() => parsePipelineArgs(["--figma", "u", "--pen", "/d/x.pen", "--project", "/p"]), /只能/);
  assert.throws(() => parsePipelineArgs(["--pen", "/d/x.pen", "--node-id", "1-2", "--project", "/p"]), /node-id/);
  const figma = parsePipelineArgs(["--figma", "https://f", "--node-id", "1-2", "--project", "/p", "--device", "S1"]);
  assert.deepEqual(figma, {
    source: { kind: "figma", url: "https://f", nodeId: "1-2" },
    projectDir: "/p",
    device: "S1",
    noRun: false,
    noCheck: false
  });
  const pen = parsePipelineArgs(["--pen", "/d/x.pen", "--vision", "true", "--project", "/p", "--no-run"]);
  assert.deepEqual(pen.source, { kind: "pen", penPath: "/d/x.pen", vision: "true" });
  assert.equal(pen.noRun, true);
});
