import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { baseConfig, makeTempDir } from "./helpers.js";

const SCRIPT = fileURLToPath(new URL("../scripts/audit-legacy-tests.mjs", import.meta.url));

const FLOWS = {
  screens: [{ id: "1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] }],
  edges: []
};

function caseEntry(overrides = {}) {
  return {
    id: "case-1",
    name: "Case 1",
    screens: ["Home"],
    steps: ["点击「Go」，验证进入「Next」（页面应出现「Done」）"],
    preconditions: ["应用已安装且可正常启动"],
    taskDesc: "run case 1（【真实数据】须经真实请求链路，禁止伪造页面/假数据）",
    ...overrides
  };
}

function makeProject(parent, name, kind) {
  const dir = path.join(parent, name);
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(dir, "aos.config.jsonc"), JSON.stringify(baseConfig()), "utf-8");
  if (kind === "md-only") {
    fs.writeFileSync(path.join(designDir, "tests.md"), "# legacy 用例", "utf-8");
    return dir;
  }
  fs.writeFileSync(
    path.join(designDir, "tests.json"),
    JSON.stringify({ flows: [caseEntry(kind === "no-marker" ? { taskDesc: "run case 1" } : {})] }),
    "utf-8"
  );
  fs.writeFileSync(path.join(designDir, "flows.json"), JSON.stringify(FLOWS), "utf-8");
  if (kind !== "missing-xlsx") {
    const xlsx = path.join(designDir, "tests.xlsx");
    fs.writeFileSync(xlsx, "fake-xlsx");
    if (kind === "stale") {
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(xlsx, old, old);
    }
  }
  return dir;
}

function runAudit(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8" });
}

test("audit: 工作区扫描——md-only/缺xlsx/过期/缺标记分类 + 干净项目通过 + exit 1", () => {
  const ws = makeTempDir("aos-audit-");
  const md = makeProject(ws, "proj-md", "md-only");
  const missing = makeProject(ws, "proj-missing", "missing-xlsx");
  const stale = makeProject(ws, "proj-stale", "stale");
  const noMarker = makeProject(ws, "proj-marker", "no-marker");
  const clean = makeProject(ws, "proj-clean", "clean");

  const run = runAudit([ws, "--json"]);
  assert.equal(run.status, 1, `${run.stderr}\n${run.stdout}`);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.scanned, 5);
  assert.equal(payload.pass, 1);
  assert.equal(payload.needsWork, 4);
  const byDir = new Map(payload.projects.map((entry) => [entry.dir, entry]));
  assert.equal(byDir.get(md).status, "needs-work");
  assert.deepEqual(byDir.get(md).categories, ["md-only（无 tests.json）"]);
  assert.deepEqual(byDir.get(missing).categories, ["缺 tests.xlsx"]);
  assert.deepEqual(byDir.get(stale).categories, ["tests.xlsx 过期（早于 tests.json）"]);
  assert.deepEqual(byDir.get(noMarker).categories, ["缺【真实数据】标记"]);
  assert.equal(byDir.get(clean).status, "pass");
  assert.equal(byDir.get(clean).cases, 1);
});

test("audit: 单项目直传 + 文本输出含问题与复核命令", () => {
  const ws = makeTempDir("aos-audit-text-");
  const dir = makeProject(ws, "proj-missing", "missing-xlsx");
  const run = runAudit([dir]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /proj-missing/);
  assert.match(run.stdout, /缺 tests\.xlsx/);
  assert.match(run.stdout, /suite check --project/);
});

test("audit: 全通过 → exit 0；无项目 → exit 2", () => {
  const ws = makeTempDir("aos-audit-ok-");
  makeProject(ws, "proj-clean", "clean");
  const ok = runAudit([ws]);
  assert.equal(ok.status, 0, `${ok.stderr}\n${ok.stdout}`);
  assert.match(ok.stdout, /通过 1/);

  const empty = makeTempDir("aos-audit-empty-");
  const none = runAudit([empty]);
  assert.equal(none.status, 2);
});
