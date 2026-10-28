import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runWebRunnerCommand } from "../dist/runner/web-agent.js";
import { createDefaultWebJobExecutor } from "../dist/runner/web-job-runner.js";
import { zipBuffer } from "./fixtures/web-zip.mjs";

const TOKEN = "runner-job-token-0123456789abcdef";
const BASE = "http://center.local:8765";
const FLOW_ENTRIES = [
  ["flows/TC-1.yaml", "appId: com.acme.web\n---\n- launchApp\n"],
  ["flows/TC-2.yaml", "appId: com.acme.web\n---\n- launchApp\n"]
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-web-job-runner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function jobSpec(overrides = {}) {
  return {
    kind: "web-test",
    assignment: "manual",
    devicePinned: true,
    targetHostId: "host-a",
    deviceSerial: "emulator-5554",
    requirements: { platform: "android", deviceKind: "device" },
    deviceLeaseId: "host-a:emulator-5554",
    excelAssetId: "excel-1",
    packageAssetId: "package-1",
    materialsAssetId: null,
    scriptSetId: "scripts-1",
    executionMode: "maestro",
    caseFilter: { modules: [], caseIds: [] },
    retry: 0,
    allowStaleScript: false,
    allowPartialUnresolved: false,
    assetSnapshot: [],
    ...overrides
  };
}

function device(overrides = {}) {
  return {
    serial: "emulator-5554",
    name: "Pixel 8",
    model: "Pixel 8",
    osVersion: "15",
    platform: "android",
    kind: "device",
    state: "device",
    ...overrides
  };
}

function task(id, overrides = {}) {
  return {
    id,
    deviceSerial: "emulator-5554",
    claimedHostId: "host-a",
    targetHostId: "host-a",
    ...overrides
  };
}

function jUnitXml(cases) {
  const body = cases.map((entry) => {
    const attrs = `name="${entry.name}" classname="flows" time="1"`;
    if (entry.failure === undefined) return `<testcase ${attrs}/>`;
    return `<testcase ${attrs}><failure message="${entry.failure}">boom</failure></testcase>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<testsuites>",
    `<testsuite name="maestro" tests="${cases.length}">`,
    ...body,
    "</testsuite>",
    "</testsuites>"
  ].join("\n");
}

function fakeExec({ junitCases }) {
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === "unzip") {
      if (args[0] === "-Z1") {
        return { code: 0, stdout: `${FLOW_ENTRIES.map(([name]) => name).join("\n")}\n`, stderr: "" };
      }
      const dir = args[args.indexOf("-d") + 1];
      for (const [name, content] of FLOW_ENTRIES) {
        const target = path.join(dir, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "adb") {
      return {
        code: 0,
        stdout: "Success\npackage:com.acme.web\nversionName=1.2.3\n",
        stderr: ""
      };
    }
    if (command === "maestro") {
      if (junitCases !== null) {
        const output = args[args.indexOf("--output") + 1];
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, jUnitXml(junitCases));
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 127, stdout: "", stderr: `unsupported: ${command}` };
  };
  return { exec, calls };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/** 假中心：按 URL 路由 spec / 资产 / 结果；记录每次请求（含 headers/body）。 */
function fakeCenter({ assets, uploads, resultStatus = 200 }) {
  const calls = [];
  const contents = new Map(assets.map((asset) => [asset.id, asset.buffer]));
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const record = {
      url: target,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body
    };
    calls.push(record);
    if (target.endsWith("/spec")) {
      return jsonResponse({
        ok: true,
        job: { id: "job-1", status: "claimed", deviceSerial: "emulator-5554" },
        spec: jobSpec(),
        assets: assets.map((asset) => ({
          id: asset.id,
          kind: asset.kind,
          sha256: asset.sha256,
          filename: asset.filename,
          secret: asset.secret === true,
          downloadUrl: `/panel/api/jobs/job-1/assets/${asset.id}`
        }))
      });
    }
    const asset = assets.find((entry) => target.endsWith(`/assets/${entry.id}`));
    if (asset !== undefined) {
      return new Response(contents.get(asset.id), {
        status: 200,
        headers: { "x-aos-sha256": asset.sha256 }
      });
    }
    if (target.endsWith("/results")) {
      uploads.push(JSON.parse(String(record.body)));
      return jsonResponse({ ok: true }, resultStatus);
    }
    return jsonResponse({ ok: false, error: "not found" }, 404);
  };
  return { fetchImpl, calls };
}

async function setup(t) {
  const workRoot = await tempDir(t);
  const excel = Buffer.from("excel-bytes");
  const pkg = Buffer.from("apk-bytes");
  const scripts = zipBuffer(FLOW_ENTRIES);
  const assets = [
    { id: "excel-1", kind: "excel", filename: "cases.xlsx", buffer: excel },
    { id: "package-1", kind: "package", filename: "acme.apk", buffer: pkg },
    { id: "scripts-1", kind: "scripts", filename: "scripts.zip", buffer: scripts }
  ].map((asset) => ({ ...asset, sha256: sha256(asset.buffer) }));
  return { workRoot, assets };
}

function executorFor({ fetchImpl, exec, workRoot, hostId, timeoutMs }) {
  return createDefaultWebJobExecutor({
    ...(hostId === undefined ? {} : { hostId }),
    panelBaseUrl: BASE,
    runnerToken: TOKEN,
    workRoot,
    exec,
    env: {},
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
}

test("默认执行器：spec → 下载/解压/安装/Maestro → 上传 passed（Bearer + host 头）", async (t) => {
  const { workRoot, assets } = await setup(t);
  const uploads = [];
  const center = fakeCenter({ assets, uploads });
  const fake = fakeExec({ junitCases: [{ name: "TC-1" }, { name: "TC-2" }] });
  const execute = executorFor({
    fetchImpl: center.fetchImpl,
    exec: fake.exec,
    workRoot,
    hostId: "host-a"
  });

  const result = await execute({
    task: task("job-1"),
    rootPath: "/tmp/projects/acme",
    device: device()
  });

  assert.deepEqual(result, { status: "completed" });
  const specCall = center.calls.find((call) => call.url.endsWith("/spec"));
  assert.equal(specCall.url, `${BASE}/panel/api/jobs/job-1/spec`);
  assert.equal(specCall.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(specCall.headers["x-aos-host-id"], "host-a");

  const downloadCalls = center.calls.filter((call) => call.url.includes("/assets/"));
  assert.equal(downloadCalls.length, 3);
  assert.ok(downloadCalls.every((call) => call.headers.authorization === `Bearer ${TOKEN}`));

  const adbCall = fake.calls.find((call) => call.command === "adb");
  assert.deepEqual(adbCall.args.slice(0, 4), ["-s", "emulator-5554", "install", "-r"]);
  const maestroCall = fake.calls.find((call) => call.command === "maestro");
  assert.deepEqual(maestroCall.args.slice(0, 4), ["test", "--udid", "emulator-5554", "--format"]);
  assert.ok(fs.existsSync(path.join(workRoot, "acme", "job-1", "flows", "TC-1.yaml")));

  assert.equal(uploads.length, 1);
  const payload = uploads[0];
  assert.equal(payload.execution.status, "passed");
  assert.deepEqual(
    payload.execution.cases.map((entry) => [entry.caseId, entry.status]),
    [
      ["TC-1", "PASS"],
      ["TC-2", "PASS"]
    ]
  );
  assert.deepEqual(payload.device, { serial: "emulator-5554", model: "Pixel 8", osVersion: "15" });
  assert.deepEqual(payload.package, {
    name: "com.acme.web",
    version: "1.2.3",
    filename: "acme.apk"
  });
  const uploadCall = center.calls.find((call) => call.url.endsWith("/results"));
  assert.equal(uploadCall.method, "POST");
  assert.equal(uploadCall.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(uploadCall.headers["x-aos-host-id"], "host-a");
  assert.equal(uploadCall.headers["content-type"], "application/json");
});

test("默认执行器：无 JUnit → 上传 execution.status=error，返回 failed；host 头取自任务", async (t) => {
  const { workRoot, assets } = await setup(t);
  const uploads = [];
  const center = fakeCenter({ assets, uploads });
  const fake = fakeExec({ junitCases: null });
  const execute = executorFor({
    fetchImpl: center.fetchImpl,
    exec: fake.exec,
    workRoot
  });

  const result = await execute({
    task: task("job-2", { claimedHostId: "host-b", targetHostId: "host-b" }),
    rootPath: "/tmp/projects/acme",
    device: device()
  });

  assert.deepEqual(result, { status: "failed", detail: "maestro-no-junit: exit=0" });
  const specCall = center.calls.find((call) => call.url.endsWith("/spec"));
  assert.equal(specCall.headers["x-aos-host-id"], "host-b");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].execution.status, "error");
  assert.deepEqual(uploads[0].execution.cases, []);
  assert.match(uploads[0].execution.detail, /maestro-no-junit/);
});

test("默认执行器：结果上传失败抛错（Task 5 回池，不冒充成功）", async (t) => {
  const { workRoot, assets } = await setup(t);
  const uploads = [];
  const center = fakeCenter({ assets, uploads, resultStatus: 500 });
  const fake = fakeExec({ junitCases: [{ name: "TC-1" }] });
  const execute = executorFor({ fetchImpl: center.fetchImpl, exec: fake.exec, workRoot });

  await assert.rejects(
    execute({ task: task("job-3"), rootPath: "/tmp/projects/acme", device: device() }),
    /web-job-result-upload-failed: 500/
  );
  assert.equal(uploads.length, 1);
});

test("默认执行器：spec 401 抛错（不回退/不本地假成功）", async (t) => {
  const workRoot = await tempDir(t);
  const execute = executorFor({
    fetchImpl: async () => jsonResponse({ ok: false, error: "unauthorized" }, 401),
    exec: fakeExec({ junitCases: [] }).exec,
    workRoot
  });
  await assert.rejects(
    execute({ task: task("job-4"), rootPath: "/tmp/projects/acme", device: device() }),
    /web-job-spec-failed: 401/
  );
});

test("web-runner 启动：缺中心基址/AOS_RUNNER_JOB_TOKEN 明确 exit 2", async () => {
  const missingBase = [];
  const codeBase = await runWebRunnerCommand(
    ["--once"],
    { log: () => {}, errorLog: (line) => missingBase.push(line) },
    { env: {} }
  );
  assert.equal(codeBase, 2);
  assert.match(missingBase.join("\n"), /AOS_PANEL_BASE_URL|--panel-base-url/);

  const missingToken = [];
  const codeToken = await runWebRunnerCommand(
    ["--once", "--panel-base-url", BASE],
    { log: () => {}, errorLog: (line) => missingToken.push(line) },
    { env: {} }
  );
  assert.equal(codeToken, 2);
  assert.match(missingToken.join("\n"), /AOS_RUNNER_JOB_TOKEN/);
});
