import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeWebJob } from "../dist/runner/web-executors.js";
import { buildScriptSetBundle } from "../dist/web/script-set.js";

function jobSpec() {
  return {
    kind: "web-test",
    assignment: "auto",
    devicePinned: false,
    targetHostId: "host-1",
    deviceSerial: "emulator-5554",
    requirements: { platform: "android", deviceKind: "device" },
    deviceLeaseId: null,
    excelAssetId: "excel-1",
    packageAssetId: "package-1",
    materialsAssetId: null,
    scriptSetId: "scripts-1",
    executionMode: "maestro",
    caseFilter: { modules: [], caseIds: [] },
    retry: 0,
    allowStaleScript: false,
    allowPartialUnresolved: false,
    assetSnapshot: []
  };
}

function device() {
  return { serial: "emulator-5554", platform: "android", kind: "device" };
}

function execWithJunit(caseName) {
  return async (command, args) => {
    assert.equal(command, "maestro");
    const index = args.indexOf("--output");
    assert.ok(index >= 0);
    const output = args[index + 1];
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<testsuites>",
        '<testsuite name="maestro" tests="1">',
        `<testcase name="${caseName}" classname="flows" time="1"/>`,
        "</testsuite>",
        "</testsuites>"
      ].join("\n")
    );
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("generated script: runner executes flow and counts generated assertions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aos-script-runner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobDir = path.join(root, "job-1");
  const flowsDir = path.join(jobDir, "flows");
  await mkdir(flowsDir, { recursive: true });

  const bundle = buildScriptSetBundle({
    appId: "com.example.app",
    platform: "android",
    sourceExcelAssetId: "excel-1",
    packageAssetId: "package-1",
    cases: [
      {
        caseId: "TC-1",
        steps: ["1. 启动 App", "2. 点击“登录”"],
        expected: "页面显示“成功”",
        preconditions: []
      }
    ]
  });
  const flow = bundle.files.find((entry) => entry.path === "flows/TC-1.yaml");
  assert.ok(flow);
  await writeFile(path.join(flowsDir, "TC-1.yaml"), flow.content);

  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec: execWithJunit("TC-1"),
    env: {}
  });

  assert.equal(result.status, "passed");
  assert.equal(result.cases.length, 1);
  assert.equal(result.cases[0].caseId, "TC-1");
  assert.equal(result.cases[0].status, "PASS");
  assert.equal(result.cases[0].assertionCount, 1);
  assert.deepEqual(result.cases[0].assertions, [{ type: "visible", text: "成功" }]);
});
