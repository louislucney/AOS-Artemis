import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function setup() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  await store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  return { deps: { store, env: {} }, rootPath: runtime.project.rootDir, store };
}

function request(pathname, body, overrides = {}) {
  return {
    method: "POST",
    url: new URL(`http://localhost${pathname}`),
    body,
    ...overrides
  };
}

test("console actions: 同源守卫（cross-site 403；自定义头放行）", async () => {
  const { deps, rootPath } = await setup();
  const blocked = await handlePanelActionRequest(
    request("/panel/api/tasks/release", { project: rootPath, taskId: "t" }, {
      headers: { "sec-fetch-site": "cross-site" }
    }),
    deps
  );
  assert.equal(blocked.status, 403);

  const allowed = await handlePanelActionRequest(
    request("/panel/api/tasks/release", { project: rootPath, taskId: "t" }, {
      headers: { "sec-fetch-site": "cross-site", "x-aos-console": "1" }
    }),
    deps
  );
  assert.equal(allowed.status, 404, "守卫通过后进入业务（未知任务 404）");
});

test("console actions: 释放重跑（claimed→pending；终态 400；未知 404；落审计）", async () => {
  const { deps, rootPath, store } = await setup();
  const task = await store.createRegressionTask({
    rootPath,
    refs: [{ caseSetId: "cs", featureKey: "f" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  await store.updateRegressionTask(rootPath, task.id, {
    status: "claimed",
    claimedBy: "runner-1",
    claimedAt: "2026-10-18T00:00:00.000Z"
  });

  const released = await handlePanelActionRequest(
    request("/panel/api/tasks/release", { project: rootPath, taskId: task.id }),
    deps
  );
  assert.equal(released.status, 200);
  const after = await store.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "pending");
  assert.equal(after.claimedBy, null);

  await store.updateRegressionTask(rootPath, task.id, { status: "completed" });
  const terminal = await handlePanelActionRequest(
    request("/panel/api/tasks/release", { project: rootPath, taskId: task.id }),
    deps
  );
  assert.equal(terminal.status, 400);

  const unknown = await handlePanelActionRequest(
    request("/panel/api/tasks/release", { project: rootPath, taskId: "nope" }),
    deps
  );
  assert.equal(unknown.status, 404);

  const audit = await store.listAudit(rootPath, { domain: "panel" });
  assert.ok(audit.some((event) => event.action === "action.release"));
});

test("console actions: 计划 CRUD（create/重复 400/enable/disable/delete）", async () => {
  const { deps, rootPath, store } = await setup();
  const created = await handlePanelActionRequest(
    request("/panel/api/schedules", {
      project: rootPath,
      action: "create",
      name: "夜间",
      featureKeys: ["f-1"],
      platforms: ["android"],
      everyMinutes: 60
    }),
    deps
  );
  assert.equal(created.status, 200);
  const schedule = JSON.parse(created.body).schedule;

  const duplicate = await handlePanelActionRequest(
    request("/panel/api/schedules", {
      project: rootPath,
      action: "create",
      name: "夜间",
      featureKeys: ["f-1"],
      platforms: ["android"],
      everyMinutes: 60
    }),
    deps
  );
  assert.equal(duplicate.status, 400);

  const disabled = await handlePanelActionRequest(
    request("/panel/api/schedules", { project: rootPath, action: "disable", id: schedule.id }),
    deps
  );
  assert.equal(disabled.status, 200);
  assert.equal((await store.getSchedule(rootPath, schedule.id)).enabled, false);

  const badMinutes = await handlePanelActionRequest(
    request("/panel/api/schedules", {
      project: rootPath,
      action: "create",
      name: "x",
      featureKeys: ["f"],
      platforms: ["android"],
      everyMinutes: 0
    }),
    deps
  );
  assert.equal(badMinutes.status, 400);

  const deleted = await handlePanelActionRequest(
    request("/panel/api/schedules", { project: rootPath, action: "delete", id: schedule.id }),
    deps
  );
  assert.equal(deleted.status, 200);
  assert.equal(await store.getSchedule(rootPath, schedule.id), null);
});

test("console actions: quarantine 增删（owner 签字；写盘可解析）", async () => {
  const { deps, rootPath } = await setup();
  const added = await handlePanelActionRequest(
    request("/panel/api/quarantine", {
      project: rootPath,
      action: "add",
      caseId: "c1",
      owner: "qa-lead",
      until: "2026-12-31T00:00:00.000Z"
    }),
    deps
  );
  assert.equal(added.status, 200);
  const file = join(rootPath, ".artemis", "design", "quarantine.json");
  const parsed = JSON.parse(await readFile(file, "utf8"));
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].owner, "qa-lead");

  const missingOwner = await handlePanelActionRequest(
    request("/panel/api/quarantine", { project: rootPath, action: "add", caseId: "c2" }),
    deps
  );
  assert.equal(missingOwner.status, 400);

  const removed = await handlePanelActionRequest(
    request("/panel/api/quarantine", { project: rootPath, action: "remove", caseId: "c1" }),
    deps
  );
  assert.equal(removed.status, 200);
  assert.equal(JSON.parse(await readFile(file, "utf8")).entries.length, 0);
});

test("console actions: 导出（POST 与 GET 下载变体）", async () => {
  const { deps, rootPath } = await setup();
  const posted = await handlePanelActionRequest(
    request("/panel/api/export", { project: rootPath, what: "process" }),
    deps
  );
  assert.equal(posted.status, 200);
  assert.equal(JSON.parse(posted.body).what, "process");

  const get = await handlePanelActionRequest(
    {
      method: "GET",
      url: new URL(
        `http://localhost/panel/api/export?project=${encodeURIComponent(rootPath)}&what=results&format=csv`
      ),
      body: undefined
    },
    deps
  );
  assert.equal(get.status, 200);
  assert.match(get.contentType, /text\/csv/);

  const badWhat = await handlePanelActionRequest(
    request("/panel/api/export", { project: rootPath, what: "nope" }),
    deps
  );
  assert.equal(badWhat.status, 400);
});

test("console actions: 导入（无运行时 → 400 指引；缺路径 → 400）", async () => {
  const { deps, rootPath } = await setup();
  const noPath = await handlePanelActionRequest(
    request("/panel/api/import", { project: rootPath }),
    deps
  );
  assert.equal(noPath.status, 400);

  const noRuntime = await handlePanelActionRequest(
    request("/panel/api/import", { project: rootPath, path: "/x/cases.xlsx" }),
    deps
  );
  assert.equal(noRuntime.status, 400);
  assert.match(noRuntime.body, /运行时/);
});

test("console actions: 导入单飞（409）＋上传临时文件必清理", async () => {
  const { deps, rootPath } = await setup();
  const boundary = "----aos";
  const content = "XLSX";
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cases.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`,
    "utf8"
  );
  const raw = { rawBody: body, contentType: `multipart/form-data; boundary=${boundary}` };

  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const gated = {
    ...deps,
    runtimeFor: async () => {
      await gate;
      return null;
    }
  };

  const first = handlePanelActionRequest(request("/panel/api/import", { project: rootPath }, raw), gated);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await handlePanelActionRequest(
    request("/panel/api/import", { project: rootPath }, raw),
    gated
  );
  assert.equal(second.status, 409, "并发导入单飞");

  release();
  const done = await first;
  assert.equal(done.status, 400, "无运行时指引");

  const expected = `aos-upload-${createHash("sha256").update(Buffer.from(content)).digest("hex").slice(0, 12)}.xlsx`;
  const leftovers = (await readdir(tmpdir())).filter((name) => name.startsWith("aos-upload-"));
  assert.ok(!leftovers.includes(expected), "上传临时文件已清理");
});
